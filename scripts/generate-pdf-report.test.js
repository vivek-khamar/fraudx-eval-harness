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
  sortByRiskStatus,
  uniqueFilePath,
} = require('./generate-pdf-report');

process.env.TZ = 'UTC';

const FIXED_NOW = () => new Date('2026-08-20T12:07:23.000Z');

function sampleResultsFile() {
  return {
    results: {
      timestamp: '2026-08-20T06:15:24.000Z',
      results: [
        {
          vars: {
            expected: {
              fraudRiskScore: 0.7524,
              claimantName: 'Jose Briones',
              defendant: 'One Team Restoration, Inc.',
              insuranceFirm: 'New York State Insurance Fund (NYSIF)',
              qa: [
                { predefinedQuestionId: 1, question: 'Are any medical providers bad actors?', expectedRiskStatus: 'RISK_DETECTED' },
                { predefinedQuestionId: 2, question: 'Are any attorneys bad actors?', expectedRiskStatus: 'UNSURE' },
              ],
            },
          },
          response: {
            output: {
              ingestion: { timeMs: 366800, docsSubmitted: 5, docsComplete: 5 },
              processing: { timeMs: 722500 },
              failedDocuments: [],
              report: {
                bucketId: 32277,
                fraudRiskScore: 0.7071,
                claimantName: 'Jose Briones',
                defendant: 'NA',
                insuranceFirm: 'New York State Insurance Fund',
              },
            },
          },
          gradingResult: {
            namedScores: {
              riskStatusMatch: 0.5,
              answerContentMatch: 0.6,
              report_quality: 0.8,
              fraudRiskScoreMatch: 0,
              entityFieldsMatch: 0.67,
              citationMatch: 0.3,
            },
            componentResults: [
              {
                assertion: { metric: 'qa_match' },
                perQuestionBreakdown: [
                  {
                    predefinedQuestionId: 1, question: 'Are any medical providers bad actors?',
                    actualAnswer: 'RISK DETECTED: Provider X is a bad actor.',
                    riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: true,
                    matches: true, reason: 'Good match.', score: 90, citationMatchScore: 50,
                  },
                  {
                    predefinedQuestionId: 2, question: 'Are any attorneys bad actors?',
                    actualAnswer: 'RISK DETECTED: attorney is a bad actor.',
                    riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'UNSURE', riskStatusMatches: false,
                    matches: false, reason: 'Opposite conclusion.', score: 0, citationMatchScore: undefined,
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  };
}

function writeResultsFile(dir, data) {
  const filePath = path.join(dir, 'results.json');
  fs.writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

function mockProvider(narrativeOutput) {
  return { callApi: async () => ({ output: JSON.stringify(narrativeOutput) }) };
}

const VALID_NARRATIVE = {
  summaryPanel: ['Summary bullet.'], questionsPanel: ['Questions bullet.'],
  citationsPanel: ['Citations bullet.'], overallPanel: ['Overall bullet.'],
  finalVerdict: { netRead: ['Net read bullet.'], whatWentRight: ['Right bullet.'], whatWentWrong: ['Wrong bullet.'], reasoning: 'Reasoning paragraph.' },
  perQuestionVerdicts: { 1: 'Right risk call.', 2: 'Wrong direction entirely.' },
};

async function extractPdfText(filePath) {
  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

test('generatePdfReports writes a real PDF containing the bucket id, a question, and the accuracy percentage', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const resultsPath = writeResultsFile(dir, sampleResultsFile());
  const reportsDir = path.join(dir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW, mockProvider(VALID_NARRATIVE));

  assert.ok(fs.existsSync(filePath));
  assert.equal(fs.readFileSync(filePath).slice(0, 4).toString(), '%PDF');

  const text = await extractPdfText(filePath);
  assert.match(text, /32277/);
  assert.match(text, /Are any medical providers bad actors\?/);
  assert.match(text, /Right risk call\./);
});

test('generatePdfReports still writes a valid PDF when the narrative provider fails (fallback path)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const resultsPath = writeResultsFile(dir, sampleResultsFile());
  const reportsDir = path.join(dir, 'reports');
  const failingProvider = { callApi: async () => ({ error: 'rate limited' }) };

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW, failingProvider);

  assert.ok(fs.existsSync(filePath));
  const text = await extractPdfText(filePath);
  assert.match(text, /32277/);
  assert.match(text, /narrative analysis unavailable/i);
});

test('generatePdfReports skips a claim with a missing/non-numeric fraudRiskScore instead of throwing, and still renders a healthy claim in the same file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fixture = sampleResultsFile();
  const malformedClaim = sampleResultsFile().results.results[0];
  malformedClaim.response.output.report.bucketId = 55555;
  delete malformedClaim.vars.expected.fraudRiskScore; // buildClaimData would otherwise crash on .toFixed(4)
  // Put the malformed claim first so a naive implementation that throws while
  // building it would abort before ever reaching the healthy claim below.
  fixture.results.results.unshift(malformedClaim);
  const resultsPath = writeResultsFile(dir, fixture);
  const reportsDir = path.join(dir, 'reports');

  const originalConsoleError = console.error;
  const errorCalls = [];
  console.error = (...args) => {
    errorCalls.push(args.join(' '));
  };
  t.after(() => {
    console.error = originalConsoleError;
  });

  const written = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW, mockProvider(VALID_NARRATIVE));

  assert.equal(written.length, 1);
  assert.match(written[0], /32277/);
  assert.ok(fs.existsSync(written[0]));
  assert.ok(!fs.existsSync(path.join(reportsDir, '55555')));
  assert.ok(
    errorCalls.some((message) => message.includes('55555')),
    `expected a console.error call mentioning bucketId 55555, got: ${JSON.stringify(errorCalls)}`,
  );
});

test('running generate-pdf-report.js as a CLI exits non-zero when a claim in results.json errored', (t) => {
  const { execFileSync } = require('node:child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-cli-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  // A claim that errored before any report existed at all (no bucketId, no response) —
  // generatePdfReports skips it (nothing to render), but score-dashboard.js's
  // dashboardHasErrors must still flag it, which is what main() uses to decide the
  // process's exit code.
  const fixture = {
    results: {
      timestamp: '2026-08-20T06:15:24.000Z',
      results: [{ error: 'Creating a claim failed: 404 INGESTION model is not found.' }],
    },
  };
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  let status = 0;
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'generate-pdf-report.js'), resultsPath, reportsDir], { stdio: 'pipe' });
  } catch (err) {
    status = err.status;
  }

  assert.equal(status, 1);
});

test('formatTimestampForFilename, formatLocalTimestamp, sortByRiskStatus, uniqueFilePath are unchanged', (t) => {
  assert.equal(formatTimestampForFilename('2026-08-20T12:07:23.000Z'), '2026-08-20T12-07-23');
  // formatLocalTimestamp exists specifically to render IST (UTC+5:30) regardless of the
  // host's own timezone, so a vacuous typeof-string check would pass even if it silently
  // regressed to UTC or the host's local time. Assert the exact IST value.
  assert.equal(formatLocalTimestamp(FIXED_NOW()), '2026-08-20T17:37:23');
  assert.deepEqual(
    sortByRiskStatus([{ riskStatus: 'UNSURE' }, { riskStatus: 'RISK_DETECTED' }]).map((e) => e.riskStatus),
    ['RISK_DETECTED', 'UNSURE'],
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unique-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p1 = path.join(dir, 'x.pdf');
  fs.writeFileSync(p1, 'x');
  assert.equal(uniqueFilePath(p1), path.join(dir, 'x-2.pdf'));
});

test('formatLocalTimestamp renders the same IST value regardless of the process\'s own timezone', (t) => {
  const originalTz = process.env.TZ;
  t.after(() => {
    process.env.TZ = originalTz;
  });

  const instant = new Date('2026-08-20T12:07:23.000Z');

  process.env.TZ = 'UTC';
  assert.equal(formatLocalTimestamp(instant), '2026-08-20T17:37:23');

  process.env.TZ = 'America/New_York';
  assert.equal(formatLocalTimestamp(instant), '2026-08-20T17:37:23');
});
