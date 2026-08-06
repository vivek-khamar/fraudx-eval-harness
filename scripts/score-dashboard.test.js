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

test('scoreDashboard reads results.json and computes all four dashboard numbers', () => {
  const fixture = path.join(__dirname, '..', 'test', 'fixtures', 'results.sample.json');
  const dashboard = scoreDashboard(fixture);

  assert.equal(dashboard.ingestTime, 100);
  assert.equal(dashboard.claimProcTime, 100);
  assert.equal(dashboard.acc, 94);
  assert.equal(dashboard.entAcc, null);
});

test('scoreDashboard throws a clear error when results.json has no results', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const empty = path.join(os.tmpdir(), 'empty-results.json');
  fs.writeFileSync(empty, JSON.stringify({ results: { results: [] } }));
  assert.throws(() => scoreDashboard(empty), /No results found/);
});
