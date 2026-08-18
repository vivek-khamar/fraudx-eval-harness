'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFParse } = require('pdf-parse');
const {
  generatePdfReports,
  formatTimestampForFilename,
  formatLocalTimestamp,
  humanizeFieldName,
  sortByRiskStatus,
  uniqueFilePath,
  formatCitationMatch,
} = require('./generate-pdf-report');

// Fixed to UTC so tests that feed a UTC instant (e.g. via FIXED_NOW below) get
// deterministic, environment-independent "local time" output. Each test file
// runs in its own process under node:test, so this doesn't leak to other files.
process.env.TZ = 'UTC';

function sampleResultsFile() {
  return {
    results: {
      timestamp: '2026-08-13T05:52:47.729Z',
      results: [
        {
          vars: {
            expected: {
              fraudRiskScore: 0.68,
              claimantName: 'Jose Briones',
              defendant: 'One Team Restoration, Inc.',
              insuranceFirm: 'New York State Insurance Fund (NYSIF)',
            },
          },
          response: {
            output: {
              ingestion: { timeMs: 30000 },
              processing: { timeMs: 60000 },
              report: {
                bucketId: 32023,
                fraudRiskScore: 0.7,
                claimantName: 'Jose Briones',
                defendant: 'One Team Restoration, Inc.',
                insuranceFirm: 'New York State Insurance Fund (NYSIF)',
              },
            },
          },
          gradingResult: {
            namedScores: {
              riskStatusMatch: 0.8,
              answerContentMatch: 0.6,
              report_quality: 0.75,
              fraudRiskScoreMatch: 1,
              entityFieldsMatch: 1,
            },
            componentResults: [
              {
                assertion: { metric: 'qa_match' },
                perQuestionBreakdown: [
                  { predefinedQuestionId: 1, question: 'Is there fraud?', actualAnswer: 'RISK DETECTED: Yes, per doc X.', riskStatus: 'RISK_DETECTED', riskStatusMatches: true, matches: true, reason: 'Matches expected reasoning' },
                ],
              },
              {
                assertion: { metric: 'report_quality' },
                reason: 'Summary is complete and grounded.',
              },
            ],
          },
        },
      ],
    },
  };
}

// Used to give generatePdfReports a deterministic "now" in tests instead of
// the real wall-clock time a live run would use.
const FIXED_NOW = () => new Date('2026-08-13T05:52:47.729Z');

test('formatTimestampForFilename converts an ISO timestamp into a filesystem-safe string', () => {
  assert.equal(formatTimestampForFilename('2026-08-13T05:52:47.729Z'), '2026-08-13T05-52-47');
});

test('formatLocalTimestamp always renders IST (Asia/Kolkata), regardless of the process\'s own timezone', (t) => {
  const originalTz = process.env.TZ;
  t.after(() => {
    process.env.TZ = originalTz;
  });

  const instant = new Date('2026-08-13T05:52:47.000Z');

  // CI runners default to UTC with no TZ set; a dev machine might be in any
  // zone. Either way the report must read IST, not whatever the host is in.
  process.env.TZ = 'UTC';
  assert.equal(formatLocalTimestamp(instant), '2026-08-13T11:22:47');

  process.env.TZ = 'America/New_York';
  assert.equal(formatLocalTimestamp(instant), '2026-08-13T11:22:47');
});

test('formatLocalTimestamp zero-pads month, day, hour, minute, and second', () => {
  process.env.TZ = 'UTC';
  assert.equal(formatLocalTimestamp(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T08:34:05');
});

test('humanizeFieldName splits camelCase into title-cased words', () => {
  assert.equal(humanizeFieldName('fraudRiskScore'), 'Fraud Risk Score');
  assert.equal(humanizeFieldName('claimantName'), 'Claimant Name');
  assert.equal(humanizeFieldName('insuranceFirm'), 'Insurance Firm');
});

test('humanizeFieldName leaves a single lowercase word capitalized but otherwise unchanged', () => {
  assert.equal(humanizeFieldName('defendant'), 'Defendant');
});

test('sortByRiskStatus orders Detected before Unsure before Not Detected, regardless of input order', () => {
  const input = [
    { id: 'a', riskStatus: 'UNSURE' },
    { id: 'b', riskStatus: 'RISK_NOT_DETECTED' },
    { id: 'c', riskStatus: 'RISK_DETECTED' },
  ];
  assert.deepEqual(sortByRiskStatus(input).map((e) => e.id), ['c', 'a', 'b']);
});

test('sortByRiskStatus is stable within the same risk status and sorts a missing/unknown status last', () => {
  const input = [
    { id: 'a', riskStatus: 'UNSURE' },
    { id: 'b', riskStatus: undefined },
    { id: 'c', riskStatus: 'RISK_DETECTED' },
    { id: 'd', riskStatus: 'UNSURE' },
  ];
  assert.deepEqual(sortByRiskStatus(input).map((e) => e.id), ['c', 'a', 'd', 'b']);
});

test('sortByRiskStatus does not mutate the input array', () => {
  const input = [{ id: 'a', riskStatus: 'UNSURE' }, { id: 'b', riskStatus: 'RISK_DETECTED' }];
  const copy = [...input];
  sortByRiskStatus(input);
  assert.deepEqual(input, copy);
});

test('formatCitationMatch renders YES for a matching citation', () => {
  assert.equal(formatCitationMatch({ citationMatches: true }), 'YES');
});

test('formatCitationMatch renders NO with the grader\'s reason for a non-matching citation', () => {
  assert.equal(
    formatCitationMatch({ citationMatches: false, citationMatchReason: 'The cited passage does not mention the expected entity.' }),
    'NO (The cited passage does not mention the expected entity.)'
  );
});

test('formatCitationMatch renders N/A when citationMatches is undefined', () => {
  assert.equal(formatCitationMatch({ citationMatches: undefined }), 'N/A');
  assert.equal(formatCitationMatch({ citationMatches: null }), 'N/A');
});

test('uniqueFilePath returns the given path unchanged when nothing exists there yet', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unique-file-path-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const target = path.join(tmpDir, 'report.pdf');
  assert.equal(uniqueFilePath(target), target);
});

test('uniqueFilePath appends -2, -3, ... to avoid an existing file, preserving the extension', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unique-file-path-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const target = path.join(tmpDir, 'report.pdf');
  fs.writeFileSync(target, 'first');
  assert.equal(uniqueFilePath(target), path.join(tmpDir, 'report-2.pdf'));

  fs.writeFileSync(path.join(tmpDir, 'report-2.pdf'), 'second');
  assert.equal(uniqueFilePath(target), path.join(tmpDir, 'report-3.pdf'));
});

test('generatePdfReports writes one PDF per claim with a bucketId, at reports/<bucketId>/report-<timestamp>.pdf', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile()));
  const reportsDir = path.join(tmpDir, 'reports');

  const written = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  assert.equal(written.length, 1);
  assert.equal(written[0], path.join(reportsDir, '32023', 'report-2026-08-13T11-22-47.pdf'));
  assert.ok(fs.existsSync(written[0]));
});

test('generatePdfReports stamps each run with its own actual generation time, not the frozen results.timestamp', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile()));
  const reportsDir = path.join(tmpDir, 'reports');

  const firstRun = await generatePdfReports(resultsPath, reportsDir, () => new Date('2026-08-13T05:52:47.729Z'));
  const secondRun = await generatePdfReports(resultsPath, reportsDir, () => new Date('2026-08-14T09:15:03.000Z'));

  assert.equal(firstRun[0], path.join(reportsDir, '32023', 'report-2026-08-13T11-22-47.pdf'));
  assert.equal(secondRun[0], path.join(reportsDir, '32023', 'report-2026-08-14T14-45-03.pdf'));
  assert.notEqual(secondRun[0], firstRun[0]);
  assert.ok(fs.existsSync(firstRun[0]), 'the original report must still exist');
  assert.ok(fs.existsSync(secondRun[0]), 'a new, distinctly timestamped report must have been written');
});

test('generatePdfReports falls back to a numeric suffix, not an overwrite, on the rare case of two runs in the same second', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile()));
  const reportsDir = path.join(tmpDir, 'reports');

  const firstRun = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);
  const originalPath = firstRun[0];
  const originalContent = fs.readFileSync(originalPath);

  const secondRun = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  assert.equal(secondRun[0], path.join(reportsDir, '32023', 'report-2026-08-13T11-22-47-2.pdf'));
  assert.notEqual(secondRun[0], originalPath);
  assert.ok(fs.existsSync(originalPath), 'the original report must still exist');
  assert.ok(fs.existsSync(secondRun[0]), 'a new report must have been written');
  assert.deepEqual(fs.readFileSync(originalPath), originalContent, 'the original report must be untouched');
});

test('generatePdfReports skips a claim with no bucketId (errored before a report existed)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = {
    results: {
      timestamp: '2026-08-13T05:52:47.729Z',
      results: [{ error: 'Creating a claim failed: 404 INGESTION model is not found.' }],
    },
  };
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const written = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  assert.equal(written.length, 0);
  assert.ok(!fs.existsSync(reportsDir));
});

test('generatePdfReports skips a claim with a bucketId but missing gradingResult.namedScores, and still writes the PDF for a healthy claim later in the same file', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const malformedClaim = sampleResultsFile().results.results[0];
  malformedClaim.response.output.report.bucketId = 99999;
  delete malformedClaim.gradingResult.namedScores;
  // Put the malformed claim first so a naive implementation that throws
  // on it would abort before ever reaching the healthy claim below.
  fixture.results.results.unshift(malformedClaim);
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const written = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  assert.equal(written.length, 1);
  assert.equal(written[0], path.join(reportsDir, '32023', 'report-2026-08-13T11-22-47.pdf'));
  assert.ok(fs.existsSync(written[0]));
  assert.ok(!fs.existsSync(path.join(reportsDir, '99999')));
});

test('generatePdfReports writes a PDF whose text includes the bucketId, question text, entity names, and report_quality reasoning', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile()));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.match(text, /Claim Eval Report/);
  assert.doesNotMatch(text, /Claim Eval Report.*32023/);
  assert.match(text, /Bucket ID: 32023/);
  assert.match(text, /Generated at: 2026-08-13T11:22:47\n/);
  assert.match(text, /Is there fraud\?/);
  assert.match(text, /Risk Status Match: YES/);
  assert.match(text, /Answer: RISK DETECTED: Yes, per doc X\./, 'the risk-status prefix must remain in the rendered answer text');
  assert.match(text, /Citation Match: N\/A/);
  assert.match(text, /Summary is complete and grounded\./);
  assert.match(text, /Jose Briones/);
  assert.match(text, /One Team Restoration, Inc\./);
  assert.match(text, /Fraud Risk Score/);
  assert.match(text, /Claimant Name/);
  assert.match(text, /Insurance Firm/);
  assert.doesNotMatch(text, /fraudRiskScore/);
  assert.doesNotMatch(text, /claimantName/);
  assert.doesNotMatch(text, /insuranceFirm/);
});

test('generatePdfReports numbers questions sequentially in Detected/Unsure/Not-Detected order, not by predefinedQuestionId', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const qaMatchComponent = fixture.results.results[0].gradingResult.componentResults.find(
    (c) => c.assertion.metric === 'qa_match'
  );
  // Deliberately out of both ID order and risk-status order.
  qaMatchComponent.perQuestionBreakdown = [
    { predefinedQuestionId: 900, question: 'UNSURE-QUESTION', actualAnswer: 'a', riskStatus: 'UNSURE', matches: true, reason: 'r' },
    { predefinedQuestionId: 100, question: 'NOT-DETECTED-QUESTION', actualAnswer: 'a', riskStatus: 'RISK_NOT_DETECTED', matches: true, reason: 'r' },
    { predefinedQuestionId: 500, question: 'DETECTED-QUESTION', actualAnswer: 'a', riskStatus: 'RISK_DETECTED', matches: true, reason: 'r' },
  ];
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.match(text, /Q1: DETECTED-QUESTION/);
  assert.match(text, /Q2: UNSURE-QUESTION/);
  assert.match(text, /Q3: NOT-DETECTED-QUESTION/);
  assert.doesNotMatch(text, /Q900/);
  assert.doesNotMatch(text, /Q100/);
  assert.doesNotMatch(text, /Q500/);
});

test('generatePdfReports keeps a question\'s content together in reading order, without truncation, even when its reason text forces a page break', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const qaMatchComponent = fixture.results.results[0].gradingResult.componentResults.find(
    (c) => c.assertion.metric === 'qa_match'
  );
  // A realistically long reason (2,500+ chars) — long enough that, at this repo's
  // table-column widths, it would have forced pdfkit to auto-paginate mid-column
  // under the old 4-column drawTableRow layout, tearing this row's Answer/Match/
  // Reason across pages. Under the new per-question block layout it should just
  // flow across the page break within this one question's paragraph.
  const longReasonBegin = 'REASON-BEGIN-MARKER';
  const longReasonEnd = 'REASON-END-MARKER';
  // Repeated 100x (~8,100 chars) — comfortably past this repo's real observed max
  // answer/reason length (7,299 chars) — so this reliably forces a page break
  // regardless of margins/font metrics, unlike a value merely close to one page.
  const longReason = `${longReasonBegin} ${'The grader compared the actual answer against the expected summary in detail. '.repeat(100)} ${longReasonEnd}`;
  qaMatchComponent.perQuestionBreakdown = [
    { predefinedQuestionId: 1, question: 'FIRST-QUESTION-MARKER: Is there fraud?', actualAnswer: 'Yes, per doc X.', matches: true, reason: 'Short first reason.' },
    { predefinedQuestionId: 2, question: 'SECOND-QUESTION-MARKER: What is the claim status?', actualAnswer: 'Open, pending review.', matches: false, reason: longReason },
  ];
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  let pages;
  try {
    const result = await parser.getText();
    text = result.text;
    pages = result.pages;
  } finally {
    await parser.destroy();
  }

  const pageOf = (marker) => pages.find((p) => p.text.includes(marker))?.num;
  const beginPage = pageOf(longReasonBegin);
  const endPage = pageOf(longReasonEnd);

  // Sanity check that this fixture actually exercises a page break — otherwise the
  // ordering/truncation assertions below wouldn't be testing anything meaningful.
  assert.ok(pages.length > 1, `expected the long reason to force a multi-page PDF, got ${pages.length} page(s)`);
  assert.ok(
    beginPage !== undefined && endPage !== undefined && beginPage < endPage,
    `expected the long reason to actually straddle a page break (begin on page ${beginPage}, end on page ${endPage})`
  );

  assert.match(text, /FIRST-QUESTION-MARKER/);
  assert.match(text, /SECOND-QUESTION-MARKER/);
  assert.ok(
    text.indexOf('FIRST-QUESTION-MARKER') < text.indexOf('SECOND-QUESTION-MARKER'),
    'expected the first question to appear before the second question in reading order'
  );
  assert.match(text, new RegExp(longReasonBegin));
  assert.match(text, new RegExp(longReasonEnd));
  assert.ok(
    text.indexOf(longReasonBegin) < text.indexOf(longReasonEnd),
    'expected the beginning of the long reason to appear before its end'
  );
});

test('generatePdfReports renders the fallback text (not the literal string "undefined") when the report_quality component has no reason field', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const reportQualityComponent = fixture.results.results[0].gradingResult.componentResults.find(
    (c) => c.assertion.metric === 'report_quality'
  );
  delete reportQualityComponent.reason;
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.match(text, /\(no report_quality reasoning available\)/);
  assert.doesNotMatch(text, /undefined/);
});

test('generatePdfReports logs a console.error mentioning the bucketId of a claim it skips', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const malformedClaim = sampleResultsFile().results.results[0];
  malformedClaim.response.output.report.bucketId = 88888;
  delete malformedClaim.gradingResult.namedScores;
  fixture.results.results.unshift(malformedClaim);
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const originalConsoleError = console.error;
  const errorCalls = [];
  console.error = (...args) => {
    errorCalls.push(args.join(' '));
  };
  t.after(() => {
    console.error = originalConsoleError;
  });

  const written = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  assert.equal(written.length, 1);
  assert.ok(
    errorCalls.some((message) => message.includes('88888')),
    `expected a console.error call mentioning bucketId 88888, got: ${JSON.stringify(errorCalls)}`
  );
});

test('generatePdfReports renders Citation Match as YES, NO (with the grader\'s reason), and N/A per question', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const qaMatchComponent = fixture.results.results[0].gradingResult.componentResults.find(
    (c) => c.assertion.metric === 'qa_match'
  );
  qaMatchComponent.perQuestionBreakdown = [
    { predefinedQuestionId: 1, question: 'MATCHED-QUESTION', actualAnswer: 'a', riskStatus: 'RISK_DETECTED', riskStatusMatches: true, matches: true, reason: 'r', actualCitedFileNames: ['a.pdf'], citationMatches: true, citationMatchReason: 'Matches the expected passage.' },
    { predefinedQuestionId: 2, question: 'MISMATCHED-QUESTION', actualAnswer: 'a', riskStatus: 'UNSURE', riskStatusMatches: false, matches: true, reason: 'r', actualCitedFileNames: ['c.pdf'], citationMatches: false, citationMatchReason: 'The cited passage is unrelated to the expected passage.' },
    { predefinedQuestionId: 3, question: 'UNGRADED-QUESTION', actualAnswer: 'a', riskStatus: 'RISK_NOT_DETECTED', riskStatusMatches: true, matches: true, reason: 'r', actualCitedFileNames: ['z.pdf'], citationMatches: undefined, citationMatchReason: undefined },
  ];
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  // Risk-status ordering puts MATCHED (RISK_DETECTED) first, MISMATCHED (UNSURE) second,
  // UNGRADED (RISK_NOT_DETECTED) third — so these markers already appear in this order.
  assert.match(text, /MATCHED-QUESTION[\s\S]*?Citation Match: YES/);
  assert.match(text, /MISMATCHED-QUESTION[\s\S]*?Citation Match: NO \(The cited passage is unrelated to the expected passage\.\)/);
  assert.match(text, /UNGRADED-QUESTION[\s\S]*?Citation Match: N\/A/);
});

test('running generate-pdf-report.js as a CLI exits non-zero when a claim in results.json errored, even though it still writes the PDF for a healthy claim in the same file', (t) => {
  const { execFileSync } = require('node:child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-cli-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const malformedClaim = sampleResultsFile().results.results[0];
  malformedClaim.response.output.report.bucketId = 99999;
  delete malformedClaim.gradingResult.namedScores;
  fixture.results.results.unshift(malformedClaim);
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  let status = 0;
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'generate-pdf-report.js'), resultsPath, reportsDir], { stdio: 'pipe' });
  } catch (err) {
    status = err.status;
  }

  assert.equal(status, 1);
  assert.ok(fs.existsSync(path.join(reportsDir, '32023')), 'the healthy claim\'s PDF should still be written');
  assert.ok(!fs.existsSync(path.join(reportsDir, '99999')));
});

test('running generate-pdf-report.js as a CLI exits zero when every claim in results.json is healthy', (t) => {
  const { execFileSync } = require('node:child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-cli-clean-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile()));
  const reportsDir = path.join(tmpDir, 'reports');

  // Throws if the child process exits non-zero.
  execFileSync(process.execPath, [path.join(__dirname, 'generate-pdf-report.js'), resultsPath, reportsDir], { stdio: 'pipe' });
});
