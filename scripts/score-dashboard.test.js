'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { scoreDashboard } = require('./score-dashboard');

test('scoreDashboard reads results.json and computes all four dashboard numbers for the one claim it contains', () => {
  const fixture = path.join(__dirname, '..', 'test', 'fixtures', 'results.sample.json');
  const dashboards = scoreDashboard(fixture);

  assert.equal(dashboards.length, 1);
  const dashboard = dashboards[0];
  assert.equal(dashboard.bucketId, 31662);
  // Fixture has ingestion.timeMs: 60000, processing.timeMs: 300000 — reported in seconds, no budget scoring.
  assert.equal(dashboard.ingestTime, 60);
  assert.equal(dashboard.claimProcTime, 300);
  // acc = round((100/3)*riskStatusMatch + (100/3)*answerContentMatch + (100/3)*report_quality)
  //     = round((100/3)*0.9 + (100/3)*0.7 + (100/3)*0.85) = round(81.666...) = 82
  assert.equal(dashboard.acc, 82);
  assert.equal(dashboard.entAcc, null);
});

test('scoreDashboard reports ingestTime and claimProcTime independently, in seconds, without combining them', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const fixturePath = path.join(os.tmpdir(), 'independent-timers-results.json');
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({
      results: {
        results: [
          {
            response: {
              output: {
                ingestion: { timeMs: 401500 },
                processing: { timeMs: 300000 },
                report: { bucketId: 31662, summary: 's', qa: [] },
              },
            },
            gradingResult: {
              pass: true,
              score: 1,
              namedScores: {
                riskStatusMatch: 0.9,
                answerContentMatch: 0.7,
                report_quality: 0.85,
              },
            },
          },
        ],
      },
    })
  );

  const dashboards = scoreDashboard(fixturePath);

  assert.equal(dashboards[0].ingestTime, 401.5);
  assert.equal(dashboards[0].claimProcTime, 300);
});

test('scoreDashboard scores every claim in results.json independently, not just the first one', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const fixturePath = path.join(os.tmpdir(), 'multi-claim-results.json');
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({
      results: {
        results: [
          {
            response: {
              output: {
                ingestion: { timeMs: 60000 },
                processing: { timeMs: 300000 },
                report: { bucketId: 31662, summary: 's', qa: [] },
              },
            },
            gradingResult: { pass: true, score: 1, namedScores: { riskStatusMatch: 0.9, answerContentMatch: 0.7, report_quality: 0.85 } },
          },
          {
            response: {
              output: {
                ingestion: { timeMs: 30000 },
                processing: { timeMs: 120000 },
                report: { bucketId: 31970, summary: 's', qa: [] },
              },
            },
            gradingResult: { pass: true, score: 1, namedScores: { riskStatusMatch: 0.4, answerContentMatch: 0.3, report_quality: 0.5 } },
          },
        ],
      },
    })
  );

  const dashboards = scoreDashboard(fixturePath);

  assert.equal(dashboards.length, 2);
  assert.equal(dashboards[0].bucketId, 31662);
  assert.equal(dashboards[0].acc, 82);
  assert.equal(dashboards[1].bucketId, 31970);
  assert.equal(dashboards[1].ingestTime, 30);
  assert.equal(dashboards[1].claimProcTime, 120);
  // acc = round((100/3)*0.4 + (100/3)*0.3 + (100/3)*0.5) = round(40.0) = 40
  assert.equal(dashboards[1].acc, 40);
});

test('scoreDashboard throws a clear error when results.json has no results', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const empty = path.join(os.tmpdir(), 'empty-results.json');
  fs.writeFileSync(empty, JSON.stringify({ results: { results: [] } }));
  assert.throws(() => scoreDashboard(empty), /No results found/);
});

test('scoreDashboard reports a claim whose eval result errored (no response/gradingResult) as an error entry, not a thrown exception', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const errored = path.join(os.tmpdir(), 'errored-results.json');
  fs.writeFileSync(
    errored,
    JSON.stringify({
      results: {
        results: [
          {
            error: 'Ingestion failed for FX-GOLD-5K-v1: 500 boom',
          },
        ],
      },
    })
  );
  const dashboards = scoreDashboard(errored);
  assert.equal(dashboards.length, 1);
  // No response.output was ever returned (the provider threw before fetching the report),
  // so there's no bucketId to report — the error text is the only record of what happened.
  assert.equal(dashboards[0].bucketId, undefined);
  assert.match(dashboards[0].error, /500 boom/);
  assert.equal(dashboards[0].ingestTime, undefined);
});

test('scoreDashboard reports a claim with a NaN accuracy score (missing named score) as an error entry, not a thrown exception', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const missingScore = path.join(os.tmpdir(), 'missing-score-results.json');
  fs.writeFileSync(
    missingScore,
    JSON.stringify({
      results: {
        results: [
          {
            response: {
              output: {
                ingestion: { timeMs: 60000 },
                processing: { timeMs: 300000 },
                report: { bucketId: 31662, summary: 's', qa: [] },
              },
            },
            gradingResult: {
              pass: false,
              score: 0,
              namedScores: {
                riskStatusMatch: 0.9,
                answerContentMatch: 0.8,
                // report_quality is missing
              },
            },
          },
        ],
      },
    })
  );
  const dashboards = scoreDashboard(missingScore);
  assert.equal(dashboards.length, 1);
  assert.equal(dashboards[0].bucketId, 31662);
  assert.match(dashboards[0].error, /NaN/);
});

test('scoreDashboard scores a healthy claim even when another claim in the same file errored', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const mixed = path.join(os.tmpdir(), 'mixed-results.json');
  fs.writeFileSync(
    mixed,
    JSON.stringify({
      results: {
        results: [
          {
            error: 'Creating a claim failed: 404 INGESTION model is not found.',
          },
          {
            response: {
              output: {
                ingestion: { timeMs: 30000 },
                processing: { timeMs: 120000 },
                report: { bucketId: 31970, summary: 's', qa: [] },
              },
            },
            gradingResult: { pass: true, score: 1, namedScores: { riskStatusMatch: 0.4, answerContentMatch: 0.3, report_quality: 0.5 } },
          },
        ],
      },
    })
  );

  const dashboards = scoreDashboard(mixed);

  assert.equal(dashboards.length, 2);
  assert.equal(dashboards[0].bucketId, undefined);
  assert.match(dashboards[0].error, /INGESTION model is not found/);
  assert.equal(dashboards[1].bucketId, 31970);
  assert.equal(dashboards[1].error, undefined);
  assert.equal(dashboards[1].acc, 40);
});

test('scoreDashboard reports full scores for a claim that has namedScores even though promptfoo marked it as errored (an assertion failed its own pass bar)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const assertionFailed = path.join(os.tmpdir(), 'assertion-failed-results.json');
  fs.writeFileSync(
    assertionFailed,
    JSON.stringify({
      results: {
        results: [
          {
            // promptfoo sets top-level `error` to a human-readable failure summary whenever any
            // assertion's own `pass` is false (e.g. report_quality's LLM judge decided the summary
            // was incomplete) — even though the pipeline succeeded and full namedScores exist.
            error: 'The real summary omits several key elements from the gold summary.',
            response: {
              output: {
                ingestion: { timeMs: 30000 },
                processing: { timeMs: 120000 },
                report: { bucketId: 31994, summary: 's', qa: [] },
              },
            },
            gradingResult: {
              pass: false,
              score: 0.65,
              namedScores: { riskStatusMatch: 0.629, answerContentMatch: 0.571, report_quality: 0.7 },
            },
          },
        ],
      },
    })
  );

  const dashboards = scoreDashboard(assertionFailed);

  assert.equal(dashboards.length, 1);
  assert.equal(dashboards[0].bucketId, 31994);
  assert.equal(dashboards[0].ingestTime, 30);
  assert.equal(dashboards[0].claimProcTime, 120);
  // acc = round((100/3)*0.629 + (100/3)*0.571 + (100/3)*0.7) = round(63.33...) = 63
  assert.equal(dashboards[0].acc, 63);
  assert.equal(dashboards[0].error, undefined);
});

test('scoreDashboard reports the bucketId of a claim whose provider call succeeded but grading errored', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const gradingErrored = path.join(os.tmpdir(), 'grading-errored-results.json');
  fs.writeFileSync(
    gradingErrored,
    JSON.stringify({
      results: {
        results: [
          {
            error: 'RateLimitExhaustedError: Rate limit exceeded for openai:gpt-5.1 after 4 attempts',
            response: {
              output: {
                ingestion: { timeMs: 30000 },
                processing: { timeMs: 120000 },
                report: { bucketId: 31970, summary: 's', qa: [] },
              },
            },
          },
        ],
      },
    })
  );

  const dashboards = scoreDashboard(gradingErrored);

  assert.equal(dashboards.length, 1);
  // The pipeline itself succeeded (report.bucketId was fetched) — only grading failed —
  // so the bucketId should still be reported even though this entry is an error overall.
  assert.equal(dashboards[0].bucketId, 31970);
  assert.match(dashboards[0].error, /RateLimitExhaustedError/);
});
