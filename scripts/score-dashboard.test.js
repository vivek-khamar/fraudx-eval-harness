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
  assert.equal(dashboard.claimId, 'FX-GOLD-5K-v1');
  // Fixture has ingestion.timeMs: 60000, processing.timeMs: 300000 — reported in seconds, no budget scoring.
  assert.equal(dashboard.ingestTime, 60);
  assert.equal(dashboard.claimProcTime, 300);
  // acc = round(50*qa_match + 50*report_quality) = round(50*0.9 + 50*0.85) = round(87.5) = 88
  assert.equal(dashboard.acc, 88);
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
            vars: { claimId: 'FX-GOLD-5K-v1' },
            response: {
              output: {
                ingestion: { timeMs: 401500 },
                processing: { timeMs: 300000 },
                report: { summary: 's', qa: [] },
              },
            },
            gradingResult: {
              pass: true,
              score: 1,
              namedScores: {
                qa_match: 0.9,
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
            vars: { claimId: 'FX-GOLD-5K-v1' },
            response: {
              output: {
                ingestion: { timeMs: 60000 },
                processing: { timeMs: 300000 },
                report: { summary: 's', qa: [] },
              },
            },
            gradingResult: { pass: true, score: 1, namedScores: { qa_match: 0.9, report_quality: 0.85 } },
          },
          {
            vars: { claimId: 'FX-GOLD-G3128974-v1' },
            response: {
              output: {
                ingestion: { timeMs: 30000 },
                processing: { timeMs: 120000 },
                report: { summary: 's', qa: [] },
              },
            },
            gradingResult: { pass: true, score: 1, namedScores: { qa_match: 0.4, report_quality: 0.5 } },
          },
        ],
      },
    })
  );

  const dashboards = scoreDashboard(fixturePath);

  assert.equal(dashboards.length, 2);
  assert.equal(dashboards[0].claimId, 'FX-GOLD-5K-v1');
  assert.equal(dashboards[0].acc, 88);
  assert.equal(dashboards[1].claimId, 'FX-GOLD-G3128974-v1');
  assert.equal(dashboards[1].ingestTime, 30);
  assert.equal(dashboards[1].claimProcTime, 120);
  // acc = round(50*0.4 + 50*0.5) = round(45) = 45
  assert.equal(dashboards[1].acc, 45);
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
            vars: { claimId: 'FX-GOLD-5K-v1' },
            error: 'Ingestion failed for FX-GOLD-5K-v1: 500 boom',
          },
        ],
      },
    })
  );
  const dashboards = scoreDashboard(errored);
  assert.equal(dashboards.length, 1);
  assert.equal(dashboards[0].claimId, 'FX-GOLD-5K-v1');
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
            vars: { claimId: 'FX-GOLD-5K-v1' },
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
                qa_match: 0.9,
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
  assert.equal(dashboards[0].claimId, 'FX-GOLD-5K-v1');
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
            vars: { claimId: 'FX-GOLD-5K-v1' },
            error: 'Creating a claim failed: 404 INGESTION model is not found.',
          },
          {
            vars: { claimId: 'FX-GOLD-G3128974-v1' },
            response: {
              output: {
                ingestion: { timeMs: 30000 },
                processing: { timeMs: 120000 },
                report: { summary: 's', qa: [] },
              },
            },
            gradingResult: { pass: true, score: 1, namedScores: { qa_match: 0.4, report_quality: 0.5 } },
          },
        ],
      },
    })
  );

  const dashboards = scoreDashboard(mixed);

  assert.equal(dashboards.length, 2);
  assert.equal(dashboards[0].claimId, 'FX-GOLD-5K-v1');
  assert.match(dashboards[0].error, /INGESTION model is not found/);
  assert.equal(dashboards[1].claimId, 'FX-GOLD-G3128974-v1');
  assert.equal(dashboards[1].error, undefined);
  assert.equal(dashboards[1].acc, 45);
});
