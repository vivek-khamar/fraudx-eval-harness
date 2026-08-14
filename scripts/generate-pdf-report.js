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

// Formats a Date using its LOCAL wall-clock components (whichever timezone
// the process is running in), not UTC — so the "Generated at" field and the
// filename derived from it read as the time on the machine that ran this
// script, not a UTC timestamp that can look like it's from "yesterday" or
// "tomorrow" depending on the reader's own timezone.
function formatLocalTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function humanizeFieldName(camelCaseName) {
  const spaced = camelCaseName.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatRiskStatus(riskStatus) {
  return riskStatus ? riskStatus.replace(/_/g, ' ') : 'N/A';
}

// The real report embeds a human-readable risk-status label at the start of
// each answer's text (e.g. "RISK DETECTED: ...", "RISK UNKNOWN: ..."). Now
// that riskStatus is its own field, strip the redundant prefix from the
// answer so it isn't shown twice.
function stripRiskStatusPrefix(answer) {
  return (answer || '').replace(/^RISK [A-Z ]+:\s*/, '');
}

const RISK_STATUS_ORDER = ['RISK_DETECTED', 'UNSURE', 'RISK_NOT_DETECTED'];

function riskStatusSortKey(riskStatus) {
  const index = RISK_STATUS_ORDER.indexOf(riskStatus);
  return index === -1 ? RISK_STATUS_ORDER.length : index;
}

// Orders questions Detected -> Unsure -> Not Detected (any other/missing risk
// status sorts last) so the highest-risk findings read first in the PDF.
// Array.prototype.sort is stable, so questions sharing a risk status keep
// their original relative order.
function sortByRiskStatus(perQuestionBreakdown) {
  return [...perQuestionBreakdown].sort(
    (a, b) => riskStatusSortKey(a.riskStatus) - riskStatusSortKey(b.riskStatus)
  );
}

// Appends "-2", "-3", ... before the extension until an unused path is found.
// Each generatePdfReports run stamps its filename with the actual time it ran,
// so this only kicks in on the rare case of two runs landing in the same
// second — it's a collision fallback, not the primary way reports differ.
function uniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  let n = 2;
  let candidate = `${base}-${n}${ext}`;
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = `${base}-${n}${ext}`;
  }
  return candidate;
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

  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.fontSize(18).text('Claim Eval Report', { align: 'center' });
  doc.moveDown();
  doc.fontSize(11);
  doc.text(`Bucket ID: ${bucketId}`);
  doc.text(`Ingestion time: ${ingestionTime}s`);
  doc.text(`Processing time: ${processingTime}s`);
  doc.text(`Accuracy: ${accuracy}`);
  doc.text(`Generated at: ${timestamp} (local time)`);
  doc.moveDown();

  doc.fontSize(14).text('Question-by-question results');
  doc.moveDown(0.75);

  // Renders one "Label: value" line with a bold label and a regular-weight
  // value, wrapping within usableWidth like a normal paragraph.
  function field(label, value) {
    doc.font('Helvetica-Bold').fontSize(10).text(label, { continued: true, width: usableWidth });
    doc.font('Helvetica').text(value, { width: usableWidth });
    doc.moveDown(0.35);
  }

  const orderedQuestions = sortByRiskStatus(perQuestionBreakdown);
  orderedQuestions.forEach((entry, index) => {
    // Full-width flowing paragraphs (no manual x/y column positioning) let pdfkit's
    // automatic pagination handle overflow within each paragraph, so a single
    // question's content stays together in reading order even if it spans a page
    // break — unlike the fixed-column drawTableRow layout below, which tears a
    // wrapped cell's remaining columns onto whatever page the cursor lands on.
    doc.fontSize(11).font('Helvetica-Bold').text(`Q${index + 1}: ${entry.question}`, { width: usableWidth });
    doc.moveDown(0.5);
    field('Risk Status: ', formatRiskStatus(entry.riskStatus));
    field('Match: ', entry.matches ? 'YES' : 'NO');
    field('Answer: ', stripRiskStatusPrefix(entry.actualAnswer));
    field('Reason: ', entry.reason);

    if (index < orderedQuestions.length - 1) {
      doc.moveDown(0.5);
      doc
        .strokeColor('#cccccc')
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .stroke()
        .strokeColor('black');
      doc.moveDown(0.75);
    } else {
      doc.moveDown();
    }
  });

  doc.fontSize(14).text('Claim metadata match');
  doc.moveDown(0.5);
  doc.fontSize(10);
  const mWidths = [110, 150, 150, 50];
  drawTableRow(doc, ['Field', 'Expected', 'Actual', 'Match'], mWidths);
  drawTableRow(doc, [
    humanizeFieldName('fraudRiskScore'),
    String(expected.fraudRiskScore),
    String(report.fraudRiskScore),
    fraudRiskScoreMatches(report.fraudRiskScore, expected.fraudRiskScore) ? 'YES' : 'NO',
  ], mWidths);
  const entityRows = [
    ['claimantName', expected.claimantName, report.claimantName],
    ['defendant', expected.defendant, report.defendant],
    ['insuranceFirm', expected.insuranceFirm, report.insuranceFirm],
  ];
  for (const [fieldName, exp, actual] of entityRows) {
    drawTableRow(doc, [humanizeFieldName(fieldName), exp, actual, entitiesMatch(actual, exp) ? 'YES' : 'NO'], mWidths);
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

// `now` is injectable so tests can generate a deterministic filename/"Generated
// at" value instead of the real wall-clock time a live run would use.
async function generatePdfReports(resultsFilePath, reportsDir, now = () => new Date()) {
  const raw = fs.readFileSync(resultsFilePath, 'utf8');
  const parsed = JSON.parse(raw);
  const results = parsed.results.results;
  // Stamped once per generatePdfReports call (not once per results.json) so
  // every run of this script — including a re-run against the very same
  // results.json — gets a filename reflecting when it actually ran, instead
  // of reusing the eval's frozen results.timestamp for every regeneration.
  // Uses local time (not UTC) so the filename and the "Generated at" field
  // inside the PDF both read as the time on the machine that ran this script.
  const generatedAt = formatLocalTimestamp(now());

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
    const fileName = `report-${formatTimestampForFilename(generatedAt)}.pdf`;
    const filePath = uniqueFilePath(path.join(reportsDir, String(bucketId), fileName));
    await renderClaimPdf(result, generatedAt, filePath);
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

module.exports = {
  generatePdfReports,
  formatTimestampForFilename,
  formatLocalTimestamp,
  humanizeFieldName,
  formatRiskStatus,
  stripRiskStatusPrefix,
  sortByRiskStatus,
  uniqueFilePath,
};
