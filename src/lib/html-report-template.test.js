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

test('computeSemanticByGoldCategory excludes ungraded (non-numeric score) questions from the average and count', () => {
  const breakdown = [
    makeQuestion({ riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: true, score: 40 }),
    makeQuestion({ riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: true, score: 60 }),
    // Ungraded question: score is undefined (legitimate per parseGraderVerdict), must not pollute the average.
    makeQuestion({ riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: false, score: undefined }),
  ];
  const categories = computeSemanticByGoldCategory(breakdown);
  const detCategory = categories.find((c) => c.label === 'Gold: Risk Detected');
  assert.equal(Number.isNaN(detCategory.avgScore), false);
  assert.equal(detCategory.avgScore, 50);
  assert.equal(detCategory.count, 2);
});

test('computeSemanticBuckets excludes ungraded (non-numeric score) questions entirely, not a 6th bucket', () => {
  const breakdown = [
    makeQuestion({ riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: true, score: 92 }),
    makeQuestion({ riskStatus: 'UNSURE', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: false, score: 5 }),
    // Ungraded question: must not fall into any bucket (previously silently landed in "81-100").
    makeQuestion({ riskStatus: 'UNSURE', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: false, score: undefined }),
  ];
  const buckets = computeSemanticBuckets(breakdown);
  const gradedCount = breakdown.length - 1;
  const totalBucketed = buckets.total.reduce((s, x) => s + x, 0);
  assert.equal(totalBucketed, gradedCount);
  assert.deepEqual(buckets.matched, [0, 0, 0, 0, 1]);
  assert.deepEqual(buckets.mismatched, [1, 0, 0, 0, 0]);
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

test('renderIngestionSummary includes an "Ingestion outcome" chart card with a proportional Complete bar and legend, when all docs succeed', () => {
  const html = renderIngestionSummary(sampleClaimData());
  assert.match(html, /Ingestion outcome/);
  assert.match(html, /flex:5;background:var\(--good\)[^"]*">Complete/);
  assert.match(html, /Complete \(5\)/);
  assert.match(html, /All 5 claim documents ingested cleanly/);
});

test('renderIngestionSummary\'s outcome chart shows a proportional Failed segment and count when some docs fail', () => {
  const claimData = sampleClaimData({ docsComplete: 4, docsFailed: 1, failedDocuments: [{ fileName: 'a.pdf', error: 'timeout' }] });
  const html = renderIngestionSummary(claimData);
  assert.match(html, /flex:4;background:var\(--good\)/);
  assert.match(html, /flex:1;background:var\(--critical\)/);
  assert.match(html, /Failed \(1\)/);
  assert.match(html, /4 of 5 claim documents ingested cleanly; 1 failed/);
});

test('renderProcessingSummary shows a per-step breakdown table marked N/A (no per-step telemetry exists)', () => {
  const html = renderProcessingSummary(sampleClaimData());
  assert.match(html, /722\.5s/);
  assert.match(html, /N\/A/);
  assert.match(html, /Not captured in source/);
});

test('renderProcessingSummary includes a "Where wall-clock time went" chart card with two proportional bars and a computed ratio caption', () => {
  const html = renderProcessingSummary(sampleClaimData());
  assert.match(html, /Where wall-clock time went/);
  assert.match(html, /class="bl">Ingestion<\/div>/);
  assert.match(html, /class="bl">Claim processing<\/div>/);
  assert.match(html, /width:33\.7%;background:var\(--aqua\)/);
  assert.match(html, /width:66\.3%;background:var\(--blue\)/);
  assert.match(html, /366\.8s &middot; 34%/);
  assert.match(html, /722\.5s &middot; 66%/);
  // 722.5 / 366.8 ≈ 1.97 -> rounds to "2.0" in the caption's computed ratio, not a hardcoded "2×".
  assert.match(html, /Claim processing took roughly 2\.0&times; the ingestion time\./);
});

const { renderAccuracySummary, renderFinalVerdict } = require('./html-report-template');

function sampleNarrative() {
  return {
    summaryPanel: ['Substantially matches gold on key facts.'],
    questionsPanel: ['Risk-direction match: 2 / 3.'],
    citationsPanel: ['Citation match sits at 9%.'],
    overallPanel: ['Overall score 66%.'],
    finalVerdict: {
      netRead: ['Well-grounded and reliable at surfacing clear risks.'],
      whatWentRight: ['No hallucinated facts.'],
      whatWentWrong: ['Under-called 9 risks.'],
      reasoning: 'The error pattern is a conservative-bias failure mode.',
    },
  };
}

function sampleAccuracyClaimData() {
  return {
    perQuestionBreakdown: [
      { riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: true, score: 90 },
      { riskStatus: 'UNSURE', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: false, score: 10 },
    ],
    narrative: sampleNarrative(),
  };
}

test('renderAccuracySummary includes the 4 high-level panels and all 4 charts', () => {
  const html = renderAccuracySummary(sampleAccuracyClaimData());
  assert.match(html, /Substantially matches gold on key facts\./);
  assert.match(html, /Risk-direction match: 2 \/ 3\./);
  assert.match(html, /Citation match sits at 9%\./);
  assert.match(html, /Overall score 66%\./);
  assert.match(html, /<svg/); // at least one chart present
  assert.match(html, /Risk-status match/);
});

test('renderFinalVerdict includes net read, what-went-right/wrong, and the reasoning callout', () => {
  const html = renderFinalVerdict(sampleAccuracyClaimData());
  assert.match(html, /Well-grounded and reliable at surfacing clear risks\./);
  assert.match(html, /No hallucinated facts\./);
  assert.match(html, /Under-called 9 risks\./);
  assert.match(html, /The error pattern is a conservative-bias failure mode\./);
});

const {
  renderDetailedResultsTable, renderMetadataMatchTable, renderQaAppendix, renderReportHtml,
} = require('./html-report-template');

function fullClaimData() {
  return {
    bucketId: 32277,
    claimantName: 'Jose Briones',
    generatedAt: '2026-08-20T12:07:23',
    docsSubmitted: 5, docsComplete: 5, docsFailed: 0, failedDocuments: [],
    ingestionTimeMs: 366800, processingTimeMs: 722500,
    namedScores: { riskStatusMatch: 0.5, answerContentMatch: 0.6, citationMatch: 0.3, fraudRiskScoreMatch: 0, entityFieldsMatch: 0.67 },
    accuracy: 55,
    fraudRiskScoreExpected: 0.7524, fraudRiskScoreActual: 0.7071, fraudRiskScoreMatches: false,
    metadataMatch: [
      { field: 'Risk Score (±10% tol.)', expected: '0.7524 · 75.24%', actual: '0.7071 · 70.71%', matches: false },
      { field: 'Claimant Name', expected: 'Jose Briones', actual: 'Jose Briones', matches: true },
    ],
    perQuestionBreakdown: [
      {
        predefinedQuestionId: 1,
        question: 'Are any of the medical providers bad actors?',
        actualAnswer: 'RISK DETECTED: Provider X is a bad actor <InTextCitation url="https://a.test/a.pdf" fileName="a.pdf" documentId="d1" chunkId="c1"></InTextCitation>.',
        riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'RISK_DETECTED', riskStatusMatches: true,
        score: 90, citationMatchScore: 50, reason: 'Good match.',
      },
      {
        predefinedQuestionId: 2,
        question: 'Are any attorneys bad actors?',
        actualAnswer: 'RISK DETECTED: attorney is a bad actor.',
        riskStatus: 'RISK_DETECTED', expectedRiskStatus: 'UNSURE', riskStatusMatches: false,
        score: 0, citationMatchScore: undefined, reason: 'Opposite conclusion.',
      },
    ],
    narrative: {
      summaryPanel: ['Summary bullet.'], questionsPanel: ['Questions bullet.'],
      citationsPanel: ['Citations bullet.'], overallPanel: ['Overall bullet.'],
      finalVerdict: { netRead: ['Net read bullet.'], whatWentRight: ['Right bullet.'], whatWentWrong: ['Wrong bullet.'], reasoning: 'Reasoning paragraph.' },
      perQuestionVerdicts: { 1: 'Right risk call, well cited.', 2: 'Wrong direction entirely.' },
    },
  };
}

test('renderDetailedResultsTable renders one row per question, tinting mismatches', () => {
  const html = renderDetailedResultsTable(fullClaimData());
  assert.match(html, /Q1/);
  assert.match(html, /Q2/);
  assert.match(html, /row-miss/); // Q2 mismatched
  assert.match(html, /90%/);
});

test('renderDetailedResultsTable gives its heading the same navy sec-num badge as the numbered sections, using the reference\'s "＝" marker', () => {
  const html = renderDetailedResultsTable(fullClaimData());
  assert.match(html, /<span class="sec-num">＝<\/span><h2>Detailed Results Table<\/h2>/);
});

test('renderMetadataMatchTable renders expected/actual/match for every field', () => {
  const html = renderMetadataMatchTable(fullClaimData());
  assert.match(html, /Risk Score/);
  assert.match(html, /75\.24%/);
  assert.match(html, /Claimant Name/);
  assert.match(html, /chip yes/);
  assert.match(html, /chip no/);
});

test('renderMetadataMatchTable gives its heading the same navy sec-num badge as the numbered sections', () => {
  const html = renderMetadataMatchTable(fullClaimData());
  assert.match(html, /<span class="sec-num">＝<\/span><h2>Claim Metadata Match<\/h2>/);
});

test('renderQaAppendix renders a card per question with chip, verdict line, cleaned answer, reasoning, and hyperlinked sources', () => {
  const html = renderQaAppendix(fullClaimData());
  assert.match(html, /Are any of the medical providers bad actors\?/);
  assert.match(html, /verdict-line good/); // Q1: matched, score 90
  assert.match(html, /verdict-line bad/);  // Q2: mismatched
  assert.match(html, /Right risk call, well cited\./);
  assert.match(html, /Wrong direction entirely\./);
  assert.match(html, /<a href="https:\/\/a\.test\/a\.pdf"/);
  assert.match(html, /Good match\./);
  assert.doesNotMatch(html, /InTextCitation/); // raw citation tags must be stripped
  // Q1's [1] citation marker must be visually upgraded to a superscript, not left as bare brackets.
  assert.match(html, /<sup class="c">\[1\]<\/sup>/);
  // Q2 has no citations at all — the legend must say so, not render an empty "Sources:" line.
  assert.match(html, /No source document cited/);
});

test('renderQaAppendix renders a citation source without a url as plain text, not a link', () => {
  const claimData = fullClaimData();
  claimData.perQuestionBreakdown.push({
    predefinedQuestionId: 3,
    question: 'Is there a third question?',
    actualAnswer: 'RISK UNKNOWN: no url here <InTextCitation fileName="b.pdf" documentId="d2" chunkId="c2"></InTextCitation>.',
    riskStatus: 'UNSURE', expectedRiskStatus: 'UNSURE', riskStatusMatches: true,
    score: undefined, citationMatchScore: undefined, reason: 'No url provided.',
  });
  claimData.narrative.perQuestionVerdicts[3] = 'Fine either way.';

  const html = renderQaAppendix(claimData);
  assert.match(html, /b\.pdf&nbsp;<span class="idx">\[1\]<\/span>/);
  assert.doesNotMatch(html, /<a[^>]*>b\.pdf/); // no url -> no <a> wrapper
  // metrics-inline's own Semantic field N/A guard (independent of scoreBar, used in the detailed table instead).
  assert.match(html, /Semantic: <b>N\/A<\/b>/);

  // scoreBar (used by renderDetailedResultsTable, not the Q&A appendix) has its own N/A branch.
  const tableHtml = renderDetailedResultsTable(claimData);
  assert.match(tableHtml, /<span class="mini" style="color:var\(--muted\)">N\/A<\/span>/);
});

test('renderQaAppendix preserves newlines in the answer text as <br> instead of collapsing them', () => {
  const claimData = fullClaimData();
  claimData.perQuestionBreakdown[0].actualAnswer = 'Line one.\nLine two.';
  const html = renderQaAppendix(claimData);
  assert.match(html, /Line one\.<br>Line two\./);
});

test('renderQaAppendix groups multiple citations of the same source file into one Sources entry, not one per citation', () => {
  const claimData = fullClaimData();
  claimData.perQuestionBreakdown[0].actualAnswer =
    'RISK DETECTED: first point <InTextCitation url="https://a.test/a.pdf" fileName="a.pdf" documentId="d1" chunkId="c1"></InTextCitation> ' +
    'and a second point from the same file <InTextCitation url="https://a.test/a.pdf" fileName="a.pdf" documentId="d1" chunkId="c9"></InTextCitation>.';

  const html = renderQaAppendix(claimData);
  // One combined entry for a.pdf carrying both citation numbers, not two separate "a.pdf" links.
  assert.match(html, /<a href="https:\/\/a\.test\/a\.pdf"[^>]*>a\.pdf<\/a>&nbsp;<span class="idx">\[1\]\[2\]<\/span>/);
  const occurrences = (html.match(/>a\.pdf</g) || []).length;
  assert.equal(occurrences, 1);
});

test('renderQaAppendix gives its heading the same navy sec-num badge as the numbered sections', () => {
  const html = renderQaAppendix(fullClaimData());
  assert.match(html, /<span class="sec-num">＝<\/span><h2>All Questions/);
});

test('renderReportHtml assembles a full document with all sections and no leftover <script> tags', () => {
  const html = renderReportHtml(fullClaimData());
  assert.match(html, /<style>/);
  assert.match(html, /Ingestion Summary/);
  assert.match(html, /Processing Summary/);
  assert.match(html, /Accuracy Summary/);
  assert.match(html, /Final Verdict/);
  assert.match(html, /Detailed Results Table/);
  assert.match(html, /Claim Metadata Match/);
  assert.match(html, /All Questions/);
  assert.doesNotMatch(html, /<script/);
});
