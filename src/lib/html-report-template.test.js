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

test('REPORT_CSS styles the ".tot" total-row class used by the processing-breakdown table', () => {
  assert.match(REPORT_CSS, /\.tot td\{/);
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

const {
  renderRiskStatusMatchBar, renderRiskDistributionChart,
  renderSemanticHistogram, renderSemanticByGoldCategoryChart,
} = require('./html-report-template');

test('renderRiskStatusMatchBar sizes the two flex segments to the matched/mismatched counts', () => {
  const html = renderRiskStatusMatchBar(3, 1);
  assert.match(html, /flex:3;background:var\(--good\)/);
  assert.match(html, /flex:1;background:var\(--critical\)/);
  assert.match(html, /Match &middot; 3/);
  assert.match(html, /Mismatch &middot; 1/);
  assert.match(html, /75% of answers/);
});

test('renderRiskDistributionChart renders one grouped bar per risk category with correct counts', () => {
  const svg = renderRiskDistributionChart({ model: { det: 2, nd: 0, ns: 1 }, gold: { det: 1, nd: 0, ns: 2 } });
  assert.match(svg, /<svg/);
  assert.match(svg, /Risk Detected/);
  assert.match(svg, /Not Sure/);
  // Count labels are drawn as bold value text right after each bar's <rect> —
  // matching that adjacency (not just the bare digit, which axis gridlines
  // also render) confirms the actual bar count, not a coincidental gridline.
  assert.match(svg, /<rect[^>]*fill="var\(--blue\)"\/><text[^>]*>2<\/text>/); // model det count
  assert.match(svg, /<rect[^>]*fill="var\(--muted\)"\/><text[^>]*>2<\/text>/); // gold ns count
});

test('renderSemanticHistogram renders a bar per bucket with the total count labeled', () => {
  const buckets = { labels: ['0-20', '21-40', '41-60', '61-80', '81-100'], matched: [0, 0, 0, 0, 2], mismatched: [1, 0, 0, 0, 0], total: [1, 0, 0, 0, 2] };
  const svg = renderSemanticHistogram(buckets);
  assert.match(svg, /<svg/);
  assert.match(svg, /81-100/);
  // The bucket-total label is the only text drawn bold (font-weight="800") —
  // axis gridline labels are font-size="9" fill="var(--muted)" with no
  // font-weight, so matching on the bold attribute (not just the bare digit)
  // confirms the actual bucket total, not a coincidental gridline value.
  assert.match(svg, /font-weight="800"[^>]*>2<\/text>/);
});

test('renderSemanticByGoldCategoryChart shows "— no questions —" for a category with zero count', () => {
  const categories = [
    { label: 'Gold: Risk Detected', count: 2, avgScore: 50 },
    { label: 'Gold: Not Sure', count: 0, avgScore: 0 },
    { label: 'Gold: Not Detected', count: 0, avgScore: 0 },
  ];
  const svg = renderSemanticByGoldCategoryChart(categories);
  assert.match(svg, /Gold: Risk Detected/);
  assert.match(svg, /50%/);
  // The function emits HTML entities (markup), not the literal em-dash
  // character (rendered text) — match the source form it actually outputs.
  assert.match(svg, /&mdash; no questions &mdash;/);
});

const {
  formatSeconds, renderHeroHeader, renderKpiCards,
  renderIngestionSummary, renderProcessingSummary,
} = require('./html-report-template');

function sampleClaimData(overrides = {}) {
  return {
    bucketId: 32277,
    claimantName: 'Jose Briones',
    generatedAt: '2026-08-20T12:07:23',
    docsSubmitted: 5,
    docsComplete: 5,
    docsFailed: 0,
    failedDocuments: [],
    ingestionTimeMs: 366800,
    processingTimeMs: 722500,
    namedScores: { riskStatusMatch: 0.66, answerContentMatch: 0.57, citationMatch: 0.09, fraudRiskScoreMatch: 0, entityFieldsMatch: 0.67 },
    accuracy: 66,
    fraudRiskScoreExpected: 0.7524,
    fraudRiskScoreActual: 0.7071,
    fraudRiskScoreMatches: false,
    ...overrides,
  };
}

test('formatSeconds formats milliseconds as one-decimal seconds', () => {
  assert.equal(formatSeconds(366800), '366.8s');
});

test('renderHeroHeader includes bucket id, claimant name, generated-at, docs ingested, and the overall score pill', () => {
  const html = renderHeroHeader(sampleClaimData());
  assert.match(html, /32277/);
  assert.match(html, /Jose Briones/);
  assert.match(html, /2026-08-20T12:07:23/);
  assert.match(html, /5\s*\/\s*5/);
  assert.match(html, /66%/);
});

test('renderKpiCards shows all four headline percentages and the risk-score-vs-gold delta', () => {
  const html = renderKpiCards(sampleClaimData());
  assert.match(html, /66%/);  // risk-status match
  assert.match(html, /57%/);  // answer-content match
  assert.match(html, /9%/);   // citation match
  assert.match(html, /70\.71%/); // actual fraud risk score
  assert.match(html, /75\.24%/); // gold fraud risk score
  assert.match(html, /outside/i); // tolerance verdict text, since fraudRiskScoreMatches is false
});

test('renderKpiCards shows "N/A" for citation match when namedScores.citationMatch is undefined', () => {
  const claimData = sampleClaimData({ namedScores: { riskStatusMatch: 0.66, answerContentMatch: 0.57, fraudRiskScoreMatch: 0, entityFieldsMatch: 0.67 } });
  const html = renderKpiCards(claimData);
  assert.match(html, /N\/A/);
});

test('renderIngestionSummary shows docs submitted/complete/failed and ingestion time', () => {
  const html = renderIngestionSummary(sampleClaimData());
  assert.match(html, />5<\/div>/); // docs submitted card value
  assert.match(html, /366\.8s/);
});

test('renderIngestionSummary lists failed documents when present', () => {
  const claimData = sampleClaimData({ docsComplete: 4, docsFailed: 1, failedDocuments: [{ fileName: 'a.pdf', error: 'timeout' }] });
  const html = renderIngestionSummary(claimData);
  assert.match(html, /a\.pdf/);
  assert.match(html, /timeout/);
});

test('renderProcessingSummary shows a per-step breakdown table marked N/A (no per-step telemetry exists)', () => {
  const html = renderProcessingSummary(sampleClaimData());
  assert.match(html, /722\.5s/);
  assert.match(html, /N\/A/);
  assert.match(html, /Not captured in source/);
});
