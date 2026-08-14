'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { entitiesMatch, fraudRiskScoreMatches } = require('./metadata-match-assertion');
const { computeAccuracy } = require('./score-dashboard');

const MARGIN = 50;
const COLUMN_GAP = 10;

function formatTimestampForFilename(isoTimestamp) {
  return isoTimestamp.replace(/:/g, '-').replace(/\.\d+Z$/, '');
}

function drawTableRow(doc, columns, colWidths) {
  const heights = columns.map((text, i) => doc.heightOfString(String(text), { width: colWidths[i] }));
  const rowHeight = Math.max(...heights) + 8;
  if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
  const startY = doc.y;
  let x = doc.page.margins.left;
  columns.forEach((text, i) => {
    doc.text(String(text), x, startY, { width: colWidths[i] });
    x += colWidths[i] + COLUMN_GAP;
  });
  // pdfkit's text() with an explicit x leaves doc.x pinned at the last
  // column's x position (it doesn't restore it), so any subsequent
  // doc.text(...) call made without an explicit x (headings, paragraphs)
  // would otherwise render indented under the last column instead of at
  // the left margin. Reset both cursor coordinates explicitly.
  doc.x = doc.page.margins.left;
  doc.y = startY + rowHeight;
}

function findComponent(gradingResult, metric) {
  return (gradingResult.componentResults || []).find((c) => c.assertion && c.assertion.metric === metric);
}

const REQUIRED_NAMED_SCORES = [
  'riskStatusMatch',
  'answerContentMatch',
  'report_quality',
  'fraudRiskScoreMatch',
  'entityFieldsMatch',
];

function hasRequiredNamedScores(namedScores) {
  return REQUIRED_NAMED_SCORES.every(
    (key) => typeof namedScores?.[key] === 'number' && !Number.isNaN(namedScores[key])
  );
}

// Mirrors the defensive shape-check in scripts/score-dashboard.js: a claim can have a
// bucketId (so it got past the "did the report even get created" check) yet still be
// missing the data renderClaimPdf needs, e.g. a gradingResult that never ran to
// completion. Skip such claims instead of letting renderClaimPdf throw and abort the
// whole run — the rest of the file's claims should still get their PDFs written.
function isClaimRenderable(result) {
  const output = result.response?.output;
  return Boolean(
    output &&
    output.ingestion &&
    output.processing &&
    result.vars?.expected &&
    hasRequiredNamedScores(result.gradingResult?.namedScores)
  );
}

function renderClaimPdf(result, timestamp, filePath) {
  const output = result.response.output;
  const report = output.report;
  const expected = result.vars.expected;
  const namedScores = result.gradingResult.namedScores;
  const qaMatchComponent = findComponent(result.gradingResult, 'qa_match');
  const reportQualityComponent = findComponent(result.gradingResult, 'report_quality');
  const perQuestionBreakdown = (qaMatchComponent && qaMatchComponent.perQuestionBreakdown) || [];

  const bucketId = report.bucketId;
  const ingestionTime = output.ingestion.timeMs / 1000;
  const processingTime = output.processing.timeMs / 1000;
  const accuracy = computeAccuracy(namedScores);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const doc = new PDFDocument({ margin: MARGIN });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  doc.fontSize(18).text(`Claim Report — bucket ${bucketId}`);
  doc.moveDown();
  doc.fontSize(11);
  doc.text(`Ingestion time: ${ingestionTime}s`);
  doc.text(`Processing time: ${processingTime}s`);
  doc.text(`Accuracy: ${accuracy}`);
  doc.text(`Generated at: ${timestamp}`);
  doc.moveDown();

  doc.fontSize(14).text('Question-by-question results');
  doc.moveDown(0.5);
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  for (const entry of perQuestionBreakdown) {
    // Full-width flowing paragraphs (no manual x/y column positioning) let pdfkit's
    // automatic pagination handle overflow within each paragraph, so a single
    // question's content stays together in reading order even if it spans a page
    // break — unlike the fixed-column drawTableRow layout below, which tears a
    // wrapped cell's remaining columns onto whatever page the cursor lands on.
    doc.fontSize(10).font('Helvetica-Bold').text(`Q${entry.predefinedQuestionId}: ${entry.question}`, { width: usableWidth });
    doc.font('Helvetica');
    doc.text(`Match: ${entry.matches ? 'YES' : 'NO'}`, { width: usableWidth });
    doc.text(`Answer: ${entry.actualAnswer}`, { width: usableWidth });
    doc.text(`Reason: ${entry.reason}`, { width: usableWidth });
    doc.moveDown();
  }

  doc.fontSize(14).text('Claim metadata match');
  doc.moveDown(0.5);
  doc.fontSize(10);
  const mWidths = [110, 150, 150, 50];
  drawTableRow(doc, ['Field', 'Expected', 'Actual', 'Match'], mWidths);
  drawTableRow(doc, [
    'fraudRiskScore',
    String(expected.fraudRiskScore),
    String(report.fraudRiskScore),
    fraudRiskScoreMatches(report.fraudRiskScore, expected.fraudRiskScore) ? 'YES' : 'NO',
  ], mWidths);
  const entityRows = [
    ['claimantName', expected.claimantName, report.claimantName],
    ['defendant', expected.defendant, report.defendant],
    ['insuranceFirm', expected.insuranceFirm, report.insuranceFirm],
  ];
  for (const [field, exp, actual] of entityRows) {
    drawTableRow(doc, [field, exp, actual, entitiesMatch(actual, exp) ? 'YES' : 'NO'], mWidths);
  }
  doc.moveDown();

  doc.fontSize(14).text('Overall summary');
  doc.moveDown(0.5);
  doc.fontSize(10);
  doc.text(reportQualityComponent && reportQualityComponent.reason ? reportQualityComponent.reason : '(no report_quality reasoning available)');

  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function generatePdfReports(resultsFilePath, reportsDir) {
  const raw = fs.readFileSync(resultsFilePath, 'utf8');
  const parsed = JSON.parse(raw);
  const timestamp = parsed.results.timestamp;
  const results = parsed.results.results;

  const written = [];
  for (const result of results) {
    const bucketId = result.response?.output?.report?.bucketId;
    if (bucketId === undefined) {
      console.error('Skipping claim unknown: no report was ever produced.');
      continue;
    }
    if (!isClaimRenderable(result)) {
      console.error(`Skipping claim ${bucketId}: missing required data for PDF generation.`);
      continue;
    }
    const fileName = `report-${formatTimestampForFilename(timestamp)}.pdf`;
    const filePath = path.join(reportsDir, String(bucketId), fileName);
    await renderClaimPdf(result, timestamp, filePath);
    written.push(filePath);
  }
  return written;
}

function main() {
  const resultsFilePath = process.argv[2] || path.join(process.cwd(), 'results.json');
  const reportsDir = process.argv[3] || path.join(process.cwd(), 'reports');
  generatePdfReports(resultsFilePath, reportsDir)
    .then((written) => {
      for (const filePath of written) {
        console.log(`Wrote ${filePath}`);
      }
      console.log(`Wrote ${written.length} report(s).`);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

if (require.main === module) {
  main();
}

module.exports = { generatePdfReports, formatTimestampForFilename };
