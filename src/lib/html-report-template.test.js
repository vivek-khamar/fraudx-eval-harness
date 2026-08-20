'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REPORT_CSS, escapeHtml, verdictKind,
  computeRiskStatusMatchCounts, computeRiskDistribution,
  computeSemanticBuckets, computeSemanticByGoldCategory,
} = require('./html-report-template');

test('REPORT_CSS is a non-empty string containing the navy/lime palette', () => {
  assert.equal(typeof REPORT_CSS, 'string');
  assert.match(REPORT_CSS, /--navy/);
  assert.match(REPORT_CSS, /--lime/);
});

test('escapeHtml escapes the five HTML-significant characters', () => {
  assert.equal(escapeHtml(`<a href="x">A & B's "quote"</a>`), '&lt;a href=&quot;x&quot;&gt;A &amp; B&#39;s &quot;quote&quot;&lt;/a&gt;');
});

test('escapeHtml passes through plain text unchanged', () => {
  assert.equal(escapeHtml('Plain text, no special chars.'), 'Plain text, no special chars.');
});

test('verdictKind is "bad" whenever riskStatusMatches is false, regardless of score', () => {
  assert.equal(verdictKind({ riskStatusMatches: false, score: 95 }), 'bad');
});

test('verdictKind is "good" when riskStatusMatches is true and score >= 80', () => {
  assert.equal(verdictKind({ riskStatusMatches: true, score: 80 }), 'good');
  assert.equal(verdictKind({ riskStatusMatches: true, score: 100 }), 'good');
});

test('verdictKind is "mid" when riskStatusMatches is true and score < 80', () => {
  assert.equal(verdictKind({ riskStatusMatches: true, score: 79 }), 'mid');
  assert.equal(verdictKind({ riskStatusMatches: true, score: 0 }), 'mid');
});

function makeQuestion({ riskStatus, expectedRiskStatus, riskStatusMatches, score }) {
  return { riskStatus, expectedRiskStatus, riskStatusMatches, score };
}

test('computeRiskStatusMatchCounts counts matched vs mismatched', () => {
  const breakdown = [
    makeQuestion({ riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: true, score: 90 }),
    makeQuestion({ riskStatus: 'UNSURE', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: false, score: 10 }),
  ];
  assert.deepEqual(computeRiskStatusMatchCounts(breakdown), { matched: 1, mismatched: 1 });
});

test('computeRiskDistribution tallies model output and gold expected counts by short code', () => {
  const breakdown = [
    makeQuestion({ riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: true, score: 90 }),
    makeQuestion({ riskStatus: 'UNSURE', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: false, score: 10 }),
    makeQuestion({ riskStatus: 'RISK_NOT_DETECTED', expectedRiskStatus: 'UNSURE', riskStatusMatches: false, score: 5 }),
  ];
  assert.deepEqual(computeRiskDistribution(breakdown), {
    model: { det: 1, nd: 1, ns: 1 },
    gold: { det: 2, nd: 0, ns: 1 },
  });
});

test('computeSemanticBuckets splits scores into 5 buckets, further split by riskStatusMatches', () => {
  const breakdown = [
    makeQuestion({ riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: true, score: 92 }),
    makeQuestion({ riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'UNSURE', riskStatusMatches: false, score: 92 }),
    makeQuestion({ riskStatus: 'UNSURE', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: false, score: 5 }),
  ];
  const buckets = computeSemanticBuckets(breakdown);
  assert.deepEqual(buckets.labels, ['0-20', '21-40', '41-60', '61-80', '81-100']);
  assert.deepEqual(buckets.matched, [0, 0, 0, 0, 1]);
  assert.deepEqual(buckets.mismatched, [1, 0, 0, 0, 1]);
  assert.deepEqual(buckets.total, [1, 0, 0, 0, 2]);
});

test('computeSemanticByGoldCategory averages score per expected gold category, always returning all 3 categories', () => {
  const breakdown = [
    makeQuestion({ riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: true, score: 40 }),
    makeQuestion({ riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: true, score: 60 }),
    makeQuestion({ riskStatus: 'UNSURE', expectedRiskStatus: 'UNSURE', riskStatusMatches: true, score: 100 }),
  ];
  const categories = computeSemanticByGoldCategory(breakdown);
  assert.deepEqual(categories, [
    { label: 'Gold: Risk Detected', count: 2, avgScore: 50 },
    { label: 'Gold: Not Sure', count: 1, avgScore: 100 },
    { label: 'Gold: Not Detected', count: 0, avgScore: 0 },
  ]);
});
