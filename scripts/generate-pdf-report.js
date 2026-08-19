'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { entitiesMatch, fraudRiskScoreMatches } = require('../src/lib/metadata-match-assertion');
const { formatAnswerWithCitations } = require('../src/lib/extract-cited-file-names');
const { computeAccuracy, scoreDashboard, dashboardHasErrors } = require('./score-dashboard');

const MARGIN = 50;
// Zero, not a real gap: adjacent cells' border boxes must share the exact same edge
// coordinate so drawTableRow reads as one unified table (a shared line between columns)
// rather than a row of individually bordered, visually separate boxes.
const COLUMN_GAP = 0;

function formatTimestampForFilename(isoTimestamp) {
  return isoTimestamp.replace(/:/g, '-').replace(/\.\d+Z$/, '');
}

// Formats a Date in IST (Asia/Kolkata), not UTC and not the host machine's own
// timezone — CI runners default to UTC with no TZ set, so reading process-local
// components (as this used to) silently rendered UTC in CI while looking correct
// on an IST dev machine. The team is IST-based, so the "Generated at" field and
// the filename derived from it must read IST regardless of where this runs.
function formatLocalTimestamp(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => {
    const value = parts.find((p) => p.type === type).value;
    // Some ICU data renders midnight as "24" under hour12: false.
    return type === 'hour' && value === '24' ? '00' : value;
  };
  return (
    `${get('year')}-${get('month')}-${get('day')}` +
    `T${get('hour')}:${get('minute')}:${get('second')}`
  );
}

// Formats a millisecond duration as a decimal-seconds string, e.g. 12345 -> "12.3s".
// Used by the ingestion/processing stat cards — raw ms/1000 division can produce
// long, ugly floats (12.345666...) that a stat card has no room to wrap.
function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function humanizeFieldName(camelCaseName) {
  const spaced = camelCaseName.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Renders a per-question percentage score for display; 'N/A' when the grader
// omitted `score` entirely (parseGraderVerdict treats it as optional) or when
// regenerating a PDF from a results.json produced before this field existed.
// Math.round(undefined) is NaN, which would otherwise render the literal text
// "NaN%" in the PDF.
function formatScore(score) {
  return typeof score === 'number' ? `${Math.round(score)}%` : 'N/A';
}

// Renders the enum-style riskStatus (RISK_DETECTED / UNSURE / RISK_NOT_DETECTED) for
// display, spacing out the underscores; 'N/A' when missing.
function formatRiskStatus(riskStatus) {
  return riskStatus ? riskStatus.replace(/_/g, ' ') : 'N/A';
}

// RISK_DETECTED is the alarming case (red), RISK_NOT_DETECTED is the clean case
// (green), UNSURE is neither (gray); any other/missing value stays plain black.
function riskStatusColor(riskStatus) {
  if (riskStatus === 'RISK_DETECTED') return 'red';
  if (riskStatus === 'RISK_NOT_DETECTED') return 'green';
  if (riskStatus === 'UNSURE') return 'gray';
  return 'black';
}

function booleanMatchColor(matches) {
  return matches ? 'green' : 'red';
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

// Padding inside each cell's border box, between the box edge and the text — matches
// drawStatCardRow's own internal padding for the same reason (text flush against a border
// reads as cramped).
const CELL_PADDING = 4;

function drawTableRow(doc, columns, colWidths, { bold = false, colors } = {}) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
  const textWidths = colWidths.map((w) => w - CELL_PADDING * 2);
  const heights = columns.map((text, i) => doc.heightOfString(String(text), { width: textWidths[i] }));
  const rowHeight = Math.max(...heights) + CELL_PADDING * 2;
  if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
  const startY = doc.y;
  let x = doc.page.margins.left;
  columns.forEach((text, i) => {
    doc.rect(x, startY, colWidths[i], rowHeight).stroke('#cccccc');
    if (colors && colors[i]) {
      doc.fillColor(colors[i]);
    }
    doc.text(String(text), x + CELL_PADDING, startY + CELL_PADDING, { width: textWidths[i] });
    if (colors && colors[i]) {
      doc.fillColor('black');
    }
    x += colWidths[i] + COLUMN_GAP;
  });
  if (bold) {
    doc.font('Helvetica');
  }
  // pdfkit's text() with an explicit x leaves doc.x pinned at the last
  // column's x position (it doesn't restore it), so any subsequent
  // doc.text(...) call made without an explicit x (headings, paragraphs)
  // would otherwise render indented under the last column instead of at
  // the left margin. Reset both cursor coordinates explicitly.
  doc.x = doc.page.margins.left;
  doc.y = startY + rowHeight;
}

// Draws `cards.length` equal-width bordered boxes in a row: a large bold value on
// top, a small label beneath. `color` (optional, per card) tints just the value
// text — e.g. green for a clean success count, red for a nonzero failure count —
// everything else (borders, labels) stays plain black/gray, matching pdfkit's
// existing minimal aesthetic elsewhere in this file (drawTableRow's borders, the
// '#cccccc' question dividers).
function drawStatCardRow(doc, cards) {
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 10;
  const cardWidth = (usableWidth - gap * (cards.length - 1)) / cards.length;
  const cardHeight = 60;
  if (doc.y + cardHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();
  const startY = doc.y;
  cards.forEach((card, i) => {
    const x = doc.page.margins.left + i * (cardWidth + gap);
    doc.rect(x, startY, cardWidth, cardHeight).stroke('#cccccc');
    doc.fontSize(18).font('Helvetica-Bold').fillColor(card.color || 'black')
      .text(String(card.value), x + 8, startY + 10, { width: cardWidth - 16 });
    doc.fontSize(9).font('Helvetica').fillColor('black')
      .text(card.label, x + 8, startY + 36, { width: cardWidth - 16 });
  });
  doc.y = startY + cardHeight + 12;
  doc.x = doc.page.margins.left;
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
// completion, or an ingestion object predating the docsSubmitted/docsComplete counts.
// Skip such claims instead of letting renderClaimPdf throw and abort the whole run —
// the rest of the file's claims should still get their PDFs written.
function isClaimRenderable(result) {
  const output = result.response?.output;
  return Boolean(
    output &&
    output.ingestion &&
    typeof output.ingestion.docsSubmitted === 'number' &&
    typeof output.ingestion.docsComplete === 'number' &&
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
  const failedDocuments = output.failedDocuments || [];

  const bucketId = report.bucketId;
  const accuracy = computeAccuracy(namedScores);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const doc = new PDFDocument({ margin: MARGIN });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.fontSize(18).text('Claim Eval Report', { align: 'center' });
  doc.moveDown();
  doc.fontSize(11);
  function topField(label, value) {
    doc.font('Helvetica-Bold').text(label, { continued: true });
    doc.font('Helvetica').text(value);
  }
  topField('Bucket ID: ', String(bucketId));
  topField('Generated at: ', timestamp);
  doc.moveDown();

  // Renders one "Label: value" line with a bold label and a regular-weight
  // value, wrapping within usableWidth like a normal paragraph.
  function field(label, value) {
    doc.font('Helvetica-Bold').fontSize(10).text(label, { continued: true, width: usableWidth });
    doc.font('Helvetica').text(value, { width: usableWidth });
    doc.moveDown(0.35);
  }

  // --- Section 1: Document Ingestion ---
  doc.fontSize(14).text('Document Ingestion');
  doc.moveDown(0.5);
  drawStatCardRow(doc, [
    { value: output.ingestion.docsSubmitted, label: 'Docs submitted' },
    { value: output.ingestion.docsComplete, label: 'Docs complete', color: 'green' },
    { value: failedDocuments.length, label: 'Docs failed', color: failedDocuments.length > 0 ? 'red' : 'black' },
    { value: formatSeconds(output.ingestion.timeMs), label: 'Ingestion time' },
  ]);

  if (failedDocuments.length > 0) {
    doc.fontSize(10).font('Helvetica-Bold').text('Failed documents:');
    doc.font('Helvetica');
    doc.moveDown(0.25);
    for (const { fileName, error } of failedDocuments) {
      doc.text(`${fileName}: ${error}`, { width: usableWidth });
    }
    doc.moveDown();
  } else {
    doc.moveDown(0.5);
  }

  // --- Section 2: Claim Processing ---
  doc.fontSize(14).text('Claim Processing');
  doc.moveDown(0.5);
  const processingCards = [
    { value: accuracy, label: 'Accuracy' },
    { value: formatSeconds(output.processing.timeMs), label: 'Processing time' },
    { value: `${Math.round(namedScores.riskStatusMatch * 100)}%`, label: 'Risk status match' },
    { value: `${Math.round(namedScores.answerContentMatch * 100)}%`, label: 'Answer content match' },
  ];
  if (namedScores.citationMatch !== undefined) {
    processingCards.push({ value: `${Math.round(namedScores.citationMatch * 100)}%`, label: 'Citation match' });
  }
  drawStatCardRow(doc, processingCards);

  doc.fontSize(14).text('Question-by-question results');
  doc.moveDown(0.75);

  doc.fontSize(10);
  // Citation Match now holds a short percentage (formatScore(entry.citationMatchScore)), same
  // bounded shape as the Score column — the grader's free-text citationMatchReason is computed
  // and stored in results.json same as always, just no longer rendered here. All four columns
  // are sized just above the widest real value each can hold (e.g. "RISK NOT DETECTED") so no
  // realistic value in any of them wraps, which is what keeps this row safe from the
  // pagination-tearing bug the flowing-paragraph layout below it exists to avoid.
  const qWidths = [140, 50, 80, 90];
  drawTableRow(doc, ['Risk Status', 'Score', 'Risk Match', 'Citation Match'], qWidths, { bold: true });
  doc.moveDown(0.5);

  const orderedQuestions = sortByRiskStatus(perQuestionBreakdown);
  orderedQuestions.forEach((entry, index) => {
    // Full-width flowing paragraphs (no manual x/y column positioning) let pdfkit's
    // automatic pagination handle overflow within each paragraph, so a single
    // question's content stays together in reading order even if it spans a page
    // break — unlike the fixed-column drawTableRow layout above, which tears a
    // wrapped cell's remaining columns onto whatever page the cursor lands on.
    doc.fontSize(11).font('Helvetica-Bold').text(`Q${index + 1}: ${entry.question}`, { width: usableWidth });
    doc.moveDown(0.5);

    doc.fontSize(10);
    drawTableRow(
      doc,
      [
        formatRiskStatus(entry.riskStatus),
        formatScore(entry.score),
        entry.riskStatusMatches ? 'YES' : 'NO',
        formatScore(entry.citationMatchScore),
      ],
      qWidths,
      { colors: [riskStatusColor(entry.riskStatus), null, booleanMatchColor(entry.riskStatusMatches), null] }
    );
    doc.moveDown(0.5);

    const { cleanedText, legend } = formatAnswerWithCitations(entry.actualAnswer);
    field('Answer: ', cleanedText);
    if (legend.length > 0) {
      // Built as chained continued-text segments (not one interpolated string) so each
      // filename can carry its own real pdfkit link/underline — a citation without a url
      // renders identically to plain text, since link/underline are per-segment options,
      // not paragraph-wide state.
      doc.fontSize(9).fillColor('gray');
      doc.text('Sources: ', { continued: true });
      legend.forEach((l, i) => {
        const isLast = i === legend.length - 1;
        doc.text(`[${l.number}] `, { continued: true });
        doc.text(l.fileName, { continued: !isLast, underline: Boolean(l.url), link: l.url });
        if (!isLast) {
          doc.text('   ', { continued: true });
        }
      });
      doc.fillColor('black');
      doc.moveDown(0.35);
    }
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
  drawTableRow(doc, ['Field', 'Expected', 'Actual', 'Match'], mWidths, { bold: true });
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
  // Uses IST (not UTC, not the host's own timezone) so the filename and the
  // "Generated at" field inside the PDF both read the same regardless of
  // where this script runs.
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
      // A claim erroring (e.g. a 403 from the FraudX API mid-run) must fail the CI job, not
      // silently produce a green run — even though PDFs for any other, healthy claims in the
      // same results.json were still written above. This is the last step in npm run eval's
      // `;`-chained pipeline, so its exit code becomes the whole command's exit code.
      if (dashboardHasErrors(scoreDashboard(resultsFilePath))) {
        process.exitCode = 1;
      }
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
  formatSeconds,
  humanizeFieldName,
  sortByRiskStatus,
  uniqueFilePath,
  formatScore,
  formatRiskStatus,
  riskStatusColor,
  booleanMatchColor,
  drawStatCardRow,
};
