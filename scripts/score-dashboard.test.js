'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { scoreDashboard, budgetScore } = require('./score-dashboard');

test('budgetScore saturates at 100 when at or under budget, and scales down proportionally when over', () => {
  assert.equal(budgetScore(600000, 600000), 100);
  assert.equal(budgetScore(600000, 300000), 100);
  assert.equal(budgetScore(600000, 1200000), 50);
});

test('scoreDashboard reads results.json and computes all four dashboard numbers', (t) => {
  const originalIngestBudget = process.env.INGEST_BUDGET_MS;
  const originalClaimBudget = process.env.CLAIM_BUDGET_MS;
  delete process.env.INGEST_BUDGET_MS;
  delete process.env.CLAIM_BUDGET_MS;
  t.after(() => {
    if (originalIngestBudget === undefined) {
      delete process.env.INGEST_BUDGET_MS;
    } else {
      process.env.INGEST_BUDGET_MS = originalIngestBudget;
    }
    if (originalClaimBudget === undefined) {
      delete process.env.CLAIM_BUDGET_MS;
    } else {
      process.env.CLAIM_BUDGET_MS = originalClaimBudget;
    }
  });

  const fixture = path.join(__dirname, '..', 'test', 'fixtures', 'results.sample.json');
  const dashboard = scoreDashboard(fixture);

  assert.equal(dashboard.ingestTime, 100);
  assert.equal(dashboard.claimProcTime, 100);
  assert.equal(dashboard.acc, 94);
  assert.equal(dashboard.entAcc, null);
});

test('scoreDashboard honors INGEST_BUDGET_MS/CLAIM_BUDGET_MS overrides read from process.env', (t) => {
  const originalIngestBudget = process.env.INGEST_BUDGET_MS;
  const originalClaimBudget = process.env.CLAIM_BUDGET_MS;
  process.env.INGEST_BUDGET_MS = '30000';
  process.env.CLAIM_BUDGET_MS = '100000';
  t.after(() => {
    if (originalIngestBudget === undefined) {
      delete process.env.INGEST_BUDGET_MS;
    } else {
      process.env.INGEST_BUDGET_MS = originalIngestBudget;
    }
    if (originalClaimBudget === undefined) {
      delete process.env.CLAIM_BUDGET_MS;
    } else {
      process.env.CLAIM_BUDGET_MS = originalClaimBudget;
    }
  });

  const fixture = path.join(__dirname, '..', 'test', 'fixtures', 'results.sample.json');
  const dashboard = scoreDashboard(fixture);

  // Fixture has ingestion.timeMs: 60000, processing.timeMs: 300000.
  assert.equal(dashboard.ingestTime, budgetScore(30000, 60000)); // 50
  assert.equal(dashboard.claimProcTime, budgetScore(100000, 300000)); // 33
});

test('scoreDashboard throws a clear error when results.json has no results', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const empty = path.join(os.tmpdir(), 'empty-results.json');
  fs.writeFileSync(empty, JSON.stringify({ results: { results: [] } }));
  assert.throws(() => scoreDashboard(empty), /No results found/);
});

test('scoreDashboard throws a clear error instead of a cryptic TypeError when the eval result errored (no response/gradingResult)', () => {
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
  assert.throws(() => scoreDashboard(errored), /Eval result is not scorable/);
});

test('scoreDashboard throws a clear NaN error when a named score is missing from the results file', () => {
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
                report: { summary: 's', qa: [] },
              },
            },
            gradingResult: {
              pass: false,
              score: 0,
              namedScores: {
                qa_summary_accuracy: 0.9,
                // citation_accuracy is missing
              },
            },
          },
        ],
      },
    })
  );
  assert.throws(() => scoreDashboard(missingScore), /NaN/);
});
