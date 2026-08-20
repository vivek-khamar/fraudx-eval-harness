# PDF Report Redesign: HTML-Templated, Headless-Rendered Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `scripts/generate-pdf-report.js`'s pdfkit-drawn PDF with one
built from the reference report's real HTML/CSS/SVG design (navy/lime
branding, KPI cards, ingestion/processing/accuracy sections with SVG charts,
a narrative Final Verdict section, detailed tables, and a Q&A appendix),
rendered to PDF via headless Chromium (Puppeteer). One new LLM call per
claim (`src/lib/narrative-analysis.js`) supplies all narrative prose; every
number in the report stays deterministically computed from `results.json`.

**Architecture:** `scripts/generate-pdf-report.js` orchestrates: read
`results.json` → compute per-claim data → call `narrative-analysis.js` (with
a fallback on failure) → call `html-report-template.js`'s `renderReportHtml`
to build a complete HTML string in memory → print that string to PDF with
Puppeteer → write the PDF bytes to `reports/<bucketId>/report-<timestamp>.pdf`.
No HTML file is ever written to disk.

**Tech Stack:** Node.js, `puppeteer` (new dependency, replaces `pdfkit`),
`promptfoo` (already a dependency, reused for the LLM call), `node:test` +
`node:assert/strict` (existing test conventions), `pdf-parse`'s `PDFParse`
class (already used for PDF-content assertions).

## Global Constraints

- Output stays one PDF per claim at `reports/<bucketId>/report-<timestamp>.pdf`
  — same location/naming as today (`formatTimestampForFilename`,
  `formatLocalTimestamp`, `uniqueFilePath` are unchanged and reused verbatim).
- The LLM narrative call must never be the source of any number shown in the
  report — every stat/chart/table value is computed in
  `html-report-template.js` from `results.json` fields already present
  today (plus the one additive `expectedRiskStatus` field from Task 1). The
  narrative call only supplies prose interpreting those already-computed
  numbers.
- A claim's narrative LLM call failing (network error, malformed JSON) must
  not abort the whole `generatePdfReports` run — fall back to a fixed
  placeholder narrative object and keep rendering that claim's PDF normally.
- `fraudRiskScoreMatches`'s real tolerance in this codebase is ±10%
  (`Math.abs(actual - expected) <= 0.1 + 1e-9`, in
  `src/lib/metadata-match-assertion.js`) — the report must label this
  tolerance accurately (e.g. "±10% tol.") rather than copying the reference
  mockup's "±2%" label, which described a different, hand-authored dataset.
- SVG chart functions must scale to however many questions/claims are in a
  real `results.json` — no hardcoded axis maximums or gridline counts tied
  to the reference's fixed 35-question example.
- No change to `answerContentMatch`, `citationMatch`, `riskStatusMatch`,
  `computeAccuracy`, or any pass/fail threshold logic in this plan — purely
  rendering and narrative-prose additions.
- Every new/changed function gets a test, following this repo's existing
  `node:test` + `node:assert/strict` conventions (see
  `src/lib/qa-match-assertion.test.js`'s `mockLoadApiProvider` helper and
  `scripts/generate-pdf-report.test.js`'s `PDFParse`-based content
  assertions for the established style).

---

### Task 1: Thread `expectedRiskStatus` through `qa-match-assertion.js`

**Files:**
- Modify: `src/lib/qa-match-assertion.js:233-246` (the `perQuestionBreakdown.push(...)` call inside `qaMatchAssertion`)
- Test: `src/lib/qa-match-assertion.test.js`

**Interfaces:**
- Produces: `perQuestionBreakdown[i].expectedRiskStatus` (string, one of `'RISK_DETECTED' | 'UNSURE' | 'RISK_NOT_DETECTED'`) — consumed by Task 4's `computeRiskDistribution` and `computeSemanticByGoldCategory`, and by Task 8's per-question card rendering (the "Expected Output" chip).

- [ ] **Step 1: Write the failing test**

Add to `src/lib/qa-match-assertion.test.js` (near the other `qaMatchAssertion`-level tests, e.g. after the existing `perQuestionBreakdown` assertions):

```js
test('qaMatchAssertion carries expectedRiskStatus through to perQuestionBreakdown', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, score: 90, reason: 'ok' }) }));

  const output = {
    report: {
      questions: [{ predefinedQuestionId: 1, question: 'Q1?', riskStatus: 'RISK_DETECTED', answer: 'Yes.' }],
    },
  };
  const context = {
    vars: {
      expected: {
        qa: [{ predefinedQuestionId: 1, question: 'Q1?', expectedRiskStatus: 'UNSURE', expectedAnswerSummary: 'Unsure.' }],
      },
    },
    test: { options: { provider: 'openai:chat:gpt-4o' } },
  };

  const result = await qaMatchAssertion(output, context);
  assert.equal(result.perQuestionBreakdown[0].expectedRiskStatus, 'UNSURE');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/qa-match-assertion.test.js`
Expected: FAIL — `result.perQuestionBreakdown[0].expectedRiskStatus` is `undefined`, not `'UNSURE'`.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/qa-match-assertion.js`, add the one field to the existing push
call (no other lines change):

```js
    perQuestionBreakdown.push({
      predefinedQuestionId: q.predefinedQuestionId,
      question: q.question,
      actualAnswer,
      riskStatus,
      expectedRiskStatus: q.expectedRiskStatus,
      riskStatusMatches,
      matches,
      reason,
      score,
      actualCitedFileNames,
      citationMatches,
      citationMatchReason,
      citationMatchScore,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/lib/qa-match-assertion.test.js`
Expected: PASS, all existing tests in this file still pass too.

- [ ] **Step 5: Commit**

```bash
git add src/lib/qa-match-assertion.js src/lib/qa-match-assertion.test.js
git commit -m "feat: thread expectedRiskStatus through qa-match perQuestionBreakdown"
```

---

### Task 2: `src/lib/narrative-analysis.js` — prompt builder + response parser

**Files:**
- Create: `src/lib/narrative-analysis.js`
- Test: `src/lib/narrative-analysis.test.js`

**Interfaces:**
- Consumes: a `claimSummary` object (shape below), built by `scripts/generate-pdf-report.js` in Task 9 from `namedScores`, `perQuestionBreakdown` (with `expectedRiskStatus` from Task 1), and `metadataMatch` data.
- Produces: `buildNarrativePrompt(claimSummary): string` and
  `parseNarrativeResponse(responseOutput, claimSummary): object` — both pure,
  no I/O. Consumed by Task 3's `generateNarrativeAnalysis` and directly by
  this task's own tests.

`claimSummary` shape (all fields already computable from data that exists in
`results.json` today, plus Task 1's addition):

```js
{
  namedScores: { riskStatusMatch, answerContentMatch, citationMatch, fraudRiskScoreMatch, entityFieldsMatch },
  riskDistribution: { model: { det: number, nd: number, ns: number }, gold: { det: number, nd: number, ns: number } },
  semanticByGoldCategory: [{ label: string, count: number, avgScore: number }],
  metadataMatch: [{ field: string, expected: string, actual: string, matches: boolean }],
  questions: [{
    id: string | number,       // predefinedQuestionId
    question: string,
    expectedRiskStatus: string,
    riskStatus: string,
    riskStatusMatches: boolean,
    score: number,
    citationMatchScore: number | undefined,
    reason: string,
    actualAnswerExcerpt: string,   // actualAnswer, capped to 600 chars by the caller
  }],
}
```

- [ ] **Step 1: Write the failing test**

Create `src/lib/narrative-analysis.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNarrativePrompt, parseNarrativeResponse } = require('./narrative-analysis');

function sampleClaimSummary() {
  return {
    namedScores: { riskStatusMatch: 0.66, answerContentMatch: 0.57, citationMatch: 0.09, fraudRiskScoreMatch: 0, entityFieldsMatch: 0.67 },
    riskDistribution: { model: { det: 11, nd: 1, ns: 23 }, gold: { det: 17, nd: 0, ns: 18 } },
    semanticByGoldCategory: [
      { label: 'Gold: Risk Detected', count: 17, avgScore: 38 },
      { label: 'Gold: Not Sure', count: 18, avgScore: 82 },
      { label: 'Gold: Not Detected', count: 0, avgScore: 0 },
    ],
    metadataMatch: [
      { field: 'Risk Score (±10% tol.)', expected: '0.7524 · 75.24%', actual: '0.7071 · 70.71%', matches: false },
    ],
    questions: [
      {
        id: 1, question: 'Are any of the medical providers bad actors?', expectedRiskStatus: 'RISK_DETECTED',
        riskStatus: 'RISK_DETECTED', riskStatusMatches: true, score: 30, citationMatchScore: 50,
        reason: 'Names only one overlapping bad actor.', actualAnswerExcerpt: 'RISK DETECTED: ...',
      },
      {
        id: 2, question: 'Are any attorneys bad actors?', expectedRiskStatus: 'UNSURE',
        riskStatus: 'RISK_DETECTED', riskStatusMatches: false, score: 0, citationMatchScore: 0,
        reason: 'Opposite conclusion.', actualAnswerExcerpt: 'RISK DETECTED: ...',
      },
    ],
  };
}

test('buildNarrativePrompt embeds every computed figure and every question id', () => {
  const prompt = buildNarrativePrompt(sampleClaimSummary());

  assert.match(prompt, /riskStatusMatch.*0\.66/s);
  assert.match(prompt, /answerContentMatch.*0\.57/s);
  assert.match(prompt, /citationMatch.*0\.09/s);
  assert.match(prompt, /Gold: Risk Detected.*38/s);
  assert.match(prompt, /Gold: Not Sure.*82/s);
  assert.match(prompt, /"id": 1/);
  assert.match(prompt, /"id": 2/);
  assert.match(prompt, /Are any of the medical providers bad actors\?/);
  assert.match(prompt, /summaryPanel/);
  assert.match(prompt, /finalVerdict/);
  assert.match(prompt, /perQuestionVerdicts/);
});

test('parseNarrativeResponse parses a well-formed response', () => {
  const claimSummary = sampleClaimSummary();
  const response = JSON.stringify({
    summaryPanel: ['a'], questionsPanel: ['b'], citationsPanel: ['c'], overallPanel: ['d'],
    finalVerdict: { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'], reasoning: 'h' },
    perQuestionVerdicts: { 1: 'Right call', 2: 'Wrong call' },
  });

  const result = parseNarrativeResponse(response, claimSummary);
  assert.deepEqual(result.summaryPanel, ['a']);
  assert.deepEqual(result.finalVerdict, { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'], reasoning: 'h' });
  assert.deepEqual(result.perQuestionVerdicts, { 1: 'Right call', 2: 'Wrong call' });
});

test('parseNarrativeResponse extracts JSON even when wrapped in markdown code fences', () => {
  const claimSummary = { ...sampleClaimSummary(), questions: [] };
  const response = '```json\n' + JSON.stringify({
    summaryPanel: ['a'], questionsPanel: ['b'], citationsPanel: ['c'], overallPanel: ['d'],
    finalVerdict: { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'], reasoning: 'h' },
    perQuestionVerdicts: {},
  }) + '\n```';
  const result = parseNarrativeResponse(response, claimSummary);
  assert.deepEqual(result.summaryPanel, ['a']);
});

test('parseNarrativeResponse throws when a required panel array is missing', () => {
  const claimSummary = { ...sampleClaimSummary(), questions: [] };
  const response = JSON.stringify({
    questionsPanel: ['b'], citationsPanel: ['c'], overallPanel: ['d'],
    finalVerdict: { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'], reasoning: 'h' },
    perQuestionVerdicts: {},
  });
  assert.throws(() => parseNarrativeResponse(response, claimSummary), /summaryPanel/);
});

test('parseNarrativeResponse throws when finalVerdict is missing a required sub-field', () => {
  const claimSummary = { ...sampleClaimSummary(), questions: [] };
  const response = JSON.stringify({
    summaryPanel: ['a'], questionsPanel: ['b'], citationsPanel: ['c'], overallPanel: ['d'],
    finalVerdict: { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'] },
    perQuestionVerdicts: {},
  });
  assert.throws(() => parseNarrativeResponse(response, claimSummary), /reasoning/);
});

test('parseNarrativeResponse throws when perQuestionVerdicts is missing an entry for a question id that was in the input', () => {
  const claimSummary = sampleClaimSummary(); // has question ids 1 and 2
  const response = JSON.stringify({
    summaryPanel: ['a'], questionsPanel: ['b'], citationsPanel: ['c'], overallPanel: ['d'],
    finalVerdict: { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'], reasoning: 'h' },
    perQuestionVerdicts: { 1: 'Right call' }, // missing id 2
  });
  assert.throws(() => parseNarrativeResponse(response, claimSummary), /perQuestionVerdicts.*2/s);
});

test('parseNarrativeResponse throws a clear error when no JSON object is present', () => {
  assert.throws(() => parseNarrativeResponse('not json at all', { questions: [] }), /Could not find a JSON object/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/narrative-analysis.test.js`
Expected: FAIL with `Cannot find module './narrative-analysis'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/narrative-analysis.js`:

```js
'use strict';

function buildNarrativePrompt(claimSummary) {
  return [
    'You are analyzing the results of an automated fraud-risk claim evaluation.',
    'Below are the already-computed scores and per-question breakdown for one claim.',
    'Do NOT invent or recompute any number — only interpret the numbers given.',
    '',
    `Named scores: ${JSON.stringify(claimSummary.namedScores)}`,
    `Risk distribution (model output vs gold expected): ${JSON.stringify(claimSummary.riskDistribution)}`,
    `Semantic match by gold category: ${JSON.stringify(claimSummary.semanticByGoldCategory)}`,
    `Claim metadata match: ${JSON.stringify(claimSummary.metadataMatch)}`,
    '',
    'Per-question breakdown:',
    JSON.stringify(claimSummary.questions, null, 2),
    '',
    'Respond with only a JSON object, no other text, in exactly this shape:',
    JSON.stringify({
      summaryPanel: ['3-5 short bullet strings covering key facts, hallucinations, gaps'],
      questionsPanel: ['3-5 short bullet strings covering risk-direction and semantic match'],
      citationsPanel: ['3-5 short bullet strings covering citation accuracy'],
      overallPanel: ['3-5 short bullet strings covering the overall takeaway'],
      finalVerdict: {
        netRead: ['3-6 short bullet strings summarizing the net read'],
        whatWentRight: ['2-5 short bullet strings'],
        whatWentWrong: ['2-5 short bullet strings'],
        reasoning: 'one paragraph explaining the error pattern, if any',
      },
      perQuestionVerdicts: { '<questionId>': 'one short sentence per question, keyed by its id, for every question id given above' },
    }, null, 2),
  ].join('\n');
}

const REQUIRED_PANELS = ['summaryPanel', 'questionsPanel', 'citationsPanel', 'overallPanel'];
const REQUIRED_FINAL_VERDICT_FIELDS = ['netRead', 'whatWentRight', 'whatWentWrong', 'reasoning'];

function parseNarrativeResponse(responseOutput, claimSummary) {
  const text = typeof responseOutput === 'string' ? responseOutput : JSON.stringify(responseOutput);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Could not find a JSON object in narrative response: ${text}`);
  }
  const parsed = JSON.parse(match[0]);

  for (const panel of REQUIRED_PANELS) {
    if (!Array.isArray(parsed[panel])) {
      throw new Error(`Narrative response missing required panel array "${panel}": ${text}`);
    }
  }
  if (typeof parsed.finalVerdict !== 'object' || parsed.finalVerdict === null) {
    throw new Error(`Narrative response missing "finalVerdict" object: ${text}`);
  }
  for (const field of REQUIRED_FINAL_VERDICT_FIELDS) {
    const value = parsed.finalVerdict[field];
    const isValid = field === 'reasoning' ? typeof value === 'string' : Array.isArray(value);
    if (!isValid) {
      throw new Error(`Narrative response's finalVerdict missing required field "${field}": ${text}`);
    }
  }
  if (typeof parsed.perQuestionVerdicts !== 'object' || parsed.perQuestionVerdicts === null) {
    throw new Error(`Narrative response missing "perQuestionVerdicts" object: ${text}`);
  }
  const missingIds = (claimSummary.questions || [])
    .map((q) => q.id)
    .filter((id) => typeof parsed.perQuestionVerdicts[id] !== 'string');
  if (missingIds.length > 0) {
    throw new Error(`Narrative response's perQuestionVerdicts is missing entries for question id(s): ${missingIds.join(', ')}`);
  }

  return {
    summaryPanel: parsed.summaryPanel,
    questionsPanel: parsed.questionsPanel,
    citationsPanel: parsed.citationsPanel,
    overallPanel: parsed.overallPanel,
    finalVerdict: parsed.finalVerdict,
    perQuestionVerdicts: parsed.perQuestionVerdicts,
  };
}

module.exports = { buildNarrativePrompt, parseNarrativeResponse };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/lib/narrative-analysis.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/narrative-analysis.js src/lib/narrative-analysis.test.js
git commit -m "feat: add narrative prompt builder and response parser"
```

---

### Task 3: `src/lib/narrative-analysis.js` — `generateNarrativeAnalysis` wrapper

**Files:**
- Modify: `src/lib/narrative-analysis.js`
- Test: `src/lib/narrative-analysis.test.js`

**Interfaces:**
- Consumes: `buildNarrativePrompt`, `parseNarrativeResponse` (Task 2, same file); a `provider` object with `async callApi(prompt): { output } | { error }` — the same shape `qa-match-assertion.js` already gets from `promptfoo.loadApiProvider(...)`.
- Produces: `async generateNarrativeAnalysis(provider, claimSummary): object` (same shape as `parseNarrativeResponse`'s return value) — consumed by Task 9's `generate-pdf-report.js` orchestrator.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/narrative-analysis.test.js`:

```js
const { generateNarrativeAnalysis } = require('./narrative-analysis');

test('generateNarrativeAnalysis calls provider.callApi exactly once with the built prompt and returns the parsed result', async () => {
  const claimSummary = sampleClaimSummary();
  const calls = [];
  const provider = {
    callApi: async (prompt) => {
      calls.push(prompt);
      return {
        output: JSON.stringify({
          summaryPanel: ['a'], questionsPanel: ['b'], citationsPanel: ['c'], overallPanel: ['d'],
          finalVerdict: { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'], reasoning: 'h' },
          perQuestionVerdicts: { 1: 'Right call', 2: 'Wrong call' },
        }),
      };
    },
  };

  const result = await generateNarrativeAnalysis(provider, claimSummary);

  assert.equal(calls.length, 1);
  assert.equal(calls[0], buildNarrativePrompt(claimSummary));
  assert.deepEqual(result.summaryPanel, ['a']);
});

test('generateNarrativeAnalysis throws when provider.callApi returns an error', async () => {
  const claimSummary = sampleClaimSummary();
  const provider = { callApi: async () => ({ error: 'rate limited' }) };
  await assert.rejects(() => generateNarrativeAnalysis(provider, claimSummary), /rate limited/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/narrative-analysis.test.js`
Expected: FAIL — `generateNarrativeAnalysis` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/narrative-analysis.js` (before `module.exports`):

```js
async function generateNarrativeAnalysis(provider, claimSummary) {
  const prompt = buildNarrativePrompt(claimSummary);
  const response = await provider.callApi(prompt);
  if (response.error) {
    throw new Error(response.error);
  }
  return parseNarrativeResponse(response.output, claimSummary);
}
```

Update `module.exports`:

```js
module.exports = { buildNarrativePrompt, parseNarrativeResponse, generateNarrativeAnalysis };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/lib/narrative-analysis.test.js`
Expected: PASS, all tests in this file green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/narrative-analysis.js src/lib/narrative-analysis.test.js
git commit -m "feat: add generateNarrativeAnalysis LLM call wrapper"
```

---

### Task 4: `src/lib/html-report-template.js` — CSS constant, escaping, compute helpers

**Files:**
- Create: `src/lib/html-report-template.js`
- Test: `src/lib/html-report-template.test.js`

**Interfaces:**
- Produces: `REPORT_CSS` (string constant), `escapeHtml(text): string`,
  `verdictKind(entry): 'good'|'mid'|'bad'`,
  `computeRiskStatusMatchCounts(perQuestionBreakdown): { matched, mismatched }`,
  `computeRiskDistribution(perQuestionBreakdown): { model: {det,nd,ns}, gold: {det,nd,ns} }`,
  `computeSemanticBuckets(perQuestionBreakdown): { labels, matched, mismatched, total }`,
  `computeSemanticByGoldCategory(perQuestionBreakdown): [{ label, count, avgScore }]`.
  All consumed by Task 5 (charts), Task 6/7/8 (section rendering), and by
  Task 9's orchestrator (`verdictKind` for the Q&A appendix).
- `perQuestionBreakdown` entries here are the same shape produced by
  `qaMatchAssertion` (Task 1): `{ riskStatus, expectedRiskStatus,
  riskStatusMatches, score, ... }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/html-report-template.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/html-report-template.test.js`
Expected: FAIL with `Cannot find module './html-report-template'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/html-report-template.js`:

```js
'use strict';

// Ported verbatim from the reference report's <style> block
// (/home/vivek/Downloads/claim_eval_report.html) — the navy/lime brand
// palette, card/chip/table/chart styling, and its @media print rules
// (which already assume this HTML gets printed to PDF).
const REPORT_CSS = `
  :root{
    --navy:#1e2547; --navy-2:#252d54; --lime:#a3e635; --lime-2:#84cc16;
    --page:#f4f5f7; --surface:#ffffff; --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
    --grid:#e7e8ec; --border:rgba(11,11,11,0.10);
    --blue:#2a78d6; --orange:#eb6834; --aqua:#1baf7a; --yellow:#eda100; --violet:#4a3aa7;
    --good:#0ca30c; --good-ink:#0a7d0a; --warning:#fab219; --serious:#ec835a; --critical:#d03b3b;
    --detected:#d03b3b; --detected-bg:#fdecec; --notdet:#0ca30c; --notdet-bg:#e9f7e9;
    --notsure:#8a7d3a; --notsure-bg:#fbf4dd;
    --radius:16px;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    background:var(--page); color:var(--ink);
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    line-height:1.5; -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:900px;margin:0 auto;padding:28px 22px 80px}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em;
    background:rgba(11,11,11,.05);padding:1px 5px;border-radius:5px}
  .hero{
    background:var(--navy); border-radius:var(--radius); color:#fff;
    padding:30px 32px 28px; position:relative; overflow:hidden;
    box-shadow:0 1px 3px rgba(0,0,0,.08);
  }
  .hero::before{content:"";position:absolute;top:0;left:0;right:0;height:6px;
    background:linear-gradient(90deg,var(--lime),var(--lime-2))}
  .hero-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
  .brand{font-size:15px;font-weight:800;letter-spacing:.5px;color:#fff;display:flex;align-items:center;gap:8px}
  .brand small{display:block;font-size:8.5px;font-weight:600;letter-spacing:2px;color:#7f88b5;margin-top:2px}
  .pill{background:var(--lime);color:#1b2a05;font-weight:700;font-size:12.5px;
    padding:6px 14px;border-radius:999px;white-space:nowrap}
  .pillwrap{display:flex;flex-direction:column;gap:8px;align-items:flex-end}
  .pill.match{background:var(--lime);color:#1b2a05;font-size:14px;padding:9px 18px;
    box-shadow:0 0 0 4px rgba(163,230,53,.22)}
  .pill.match b{font-size:17px}
  .card.hl{background:linear-gradient(180deg,#f1fce0,#ffffff);border:1.5px solid var(--lime-2);
    box-shadow:0 0 0 3px rgba(132,204,22,.14)}
  .card.hl .tag{display:inline-block;font-size:8.5px;font-weight:800;letter-spacing:1.2px;
    color:#4d7a08;background:#e4f7bf;border-radius:6px;padding:2px 7px;margin-bottom:8px}
  .kicker{font-size:11px;font-weight:700;letter-spacing:2px;color:#8b93bf;margin:20px 0 6px}
  h1.title{font-size:30px;font-weight:800;margin:0 0 8px;letter-spacing:-.5px}
  .subtitle{color:#c3c8e0;font-size:14px;margin:0;max-width:640px}
  .subtitle b{color:#fff}
  .meta-row{display:grid;grid-template-columns:repeat(3,1fr);gap:18px 26px;margin-top:24px;
    border-top:1px solid rgba(255,255,255,.13);padding-top:20px}
  .meta-row .m-lab{font-size:9.5px;font-weight:700;letter-spacing:1.5px;color:#7f88b5;margin-bottom:4px}
  .meta-row .m-val{font-size:14px;font-weight:600;color:#eef0f8}
  section{margin-top:40px}
  .sec-head{display:flex;align-items:baseline;gap:12px;margin:0 0 4px;
    padding-bottom:10px;border-bottom:2px solid var(--ink);}
  .sec-num{font-size:13px;font-weight:800;color:#fff;background:var(--navy);
    border-radius:8px;padding:3px 9px;line-height:1.2}
  h2{font-size:21px;font-weight:800;margin:0;letter-spacing:-.3px}
  .sec-sub{color:var(--ink-2);font-size:13.5px;margin:12px 0 0}
  .cards{display:grid;gap:14px;margin-top:18px}
  .cards.c4{grid-template-columns:repeat(4,1fr)}
  .cards.c3{grid-template-columns:repeat(3,1fr)}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:14px;
    padding:16px 16px 14px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
  .card .big{font-size:30px;font-weight:800;letter-spacing:-1px;line-height:1}
  .card .lab{font-size:11.5px;color:var(--ink-2);margin-top:8px;line-height:1.35}
  .card .sub{font-size:10.5px;color:var(--muted);margin-top:3px}
  .big.green{color:var(--good-ink)} .big.red{color:var(--critical)}
  .big.amber{color:#b6820a} .big.blue{color:var(--blue)}
  .callout{border-radius:14px;padding:18px 20px;font-size:13.5px;line-height:1.6;margin-top:18px;
    border:1px solid var(--border);background:var(--surface)}
  .callout.verdict{border-left:5px solid var(--good);background:#f2fbf2}
  .callout.info{border-left:5px solid var(--blue);background:#eef5fd}
  .callout h4{margin:0 0 6px;font-size:13px;font-weight:800}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:18px}
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px}
  .panel h4{margin:0 0 10px;font-size:13.5px;font-weight:800;display:flex;align-items:center;gap:8px}
  .panel ul{margin:0;padding-left:18px} .panel li{margin:6px 0;font-size:13px;line-height:1.5}
  .dot{width:9px;height:9px;border-radius:3px;display:inline-block}
  .chart-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;
    padding:18px 20px 16px;margin-top:18px}
  .chart-card h4{margin:0 0 2px;font-size:14px;font-weight:800}
  .chart-card .cap{font-size:11.5px;color:var(--muted);margin:10px 0 0;line-height:1.45}
  .legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:11.5px;color:var(--ink-2)}
  .legend span{display:flex;align-items:center;gap:6px}
  svg{display:block;max-width:100%;height:auto;overflow:visible}
  table{width:100%;border-collapse:collapse;margin-top:16px;font-size:12.5px;
    background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
  thead th{background:#f1f2f5;text-align:left;padding:10px 12px;font-size:10.5px;
    font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--ink-2);
    border-bottom:1px solid var(--border)}
  tbody td{padding:9px 12px;border-bottom:1px solid #eef0f3;vertical-align:middle}
  tbody tr:last-child td{border-bottom:none}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  td.ctr,th.ctr{text-align:center}
  .row-miss{background:#fdf2f2}
  .chip{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700;
    padding:3px 9px;border-radius:999px;white-space:nowrap;line-height:1.3}
  .chip.det{color:#a01d1d;background:var(--detected-bg)}
  .chip.nd{color:#0a6b0a;background:var(--notdet-bg)}
  .chip.ns{color:#7a6b1e;background:var(--notsure-bg)}
  .chip.yes{color:#0a6b0a;background:var(--notdet-bg)}
  .chip.no{color:#a01d1d;background:var(--detected-bg)}
  .mini{font-size:11px;font-weight:700}
  .mbar{display:inline-block;width:52px;height:7px;border-radius:4px;background:#eef0f3;
    position:relative;vertical-align:middle;margin-right:7px;overflow:hidden}
  .mbar i{position:absolute;left:0;top:0;bottom:0;border-radius:4px}
  .qcard{background:var(--surface);border:1px solid var(--border);border-radius:14px;
    padding:16px 18px;margin-top:14px}
  .qcard .qtop{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}
  .qid{font-size:12px;font-weight:800;color:#fff;background:var(--navy);border-radius:7px;
    padding:3px 8px;flex:none}
  .qtext{font-size:14px;font-weight:700;flex:1;min-width:60%;line-height:1.4}
  .qchips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .verdict-line{margin-top:12px;padding:9px 12px;border-radius:10px;font-size:12.5px;
    font-weight:600;display:flex;gap:8px;align-items:flex-start}
  .verdict-line.good{background:#eefaef;color:#0a5f0a;border-left:3px solid var(--good)}
  .verdict-line.bad{background:#fdf0f0;color:#8f1f1f;border-left:3px solid var(--critical)}
  .verdict-line.mid{background:#fdf8e7;color:#7a5c05;border-left:3px solid var(--warning)}
  .ans{font-size:12.8px;color:#26262a;margin:12px 0 0;line-height:1.6}
  sup.c{color:var(--blue);font-weight:700;font-size:10px}
  .reason{font-size:12px;color:var(--ink-2);margin:10px 0 0;line-height:1.55;
    background:#fafafa;border:1px solid #eee;border-radius:9px;padding:9px 12px}
  .reason b{color:var(--ink)}
  .srcs{font-size:11px;color:var(--muted);margin:10px 0 0;line-height:1.7}
  .srcs a{color:var(--blue);text-decoration:none;border-bottom:1px dotted var(--blue)}
  .srcs .idx{color:var(--ink-2);font-weight:700}
  .metrics-inline{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:11px;color:var(--ink-2)}
  .metrics-inline b{color:var(--ink)}
  .foot{margin-top:44px;padding-top:16px;border-top:1px solid var(--border);
    font-size:11px;color:var(--muted);line-height:1.6}
  @media print{
    body{background:#fff} .wrap{max-width:100%}
    .qcard,.card,.chart-card,.panel,table{break-inside:avoid}
    section{break-inside:avoid-page}
  }
`;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// !riskStatusMatches always outweighs a high score — a semantically rich
// answer that points the wrong risk direction is still a miss for this
// report's purposes. Reproduces every row of the reference report's own
// vk column for its sample 35-question dataset.
function verdictKind(entry) {
  if (!entry.riskStatusMatches) return 'bad';
  return entry.score >= 80 ? 'good' : 'mid';
}

function computeRiskStatusMatchCounts(perQuestionBreakdown) {
  const matched = perQuestionBreakdown.filter((e) => e.riskStatusMatches).length;
  return { matched, mismatched: perQuestionBreakdown.length - matched };
}

const RISK_CODE = { RISK_DETECTED: 'det', RISK_NOT_DETECTED: 'nd', UNSURE: 'ns' };

function computeRiskDistribution(perQuestionBreakdown) {
  const model = { det: 0, nd: 0, ns: 0 };
  const gold = { det: 0, nd: 0, ns: 0 };
  for (const entry of perQuestionBreakdown) {
    const modelCode = RISK_CODE[entry.riskStatus];
    const goldCode = RISK_CODE[entry.expectedRiskStatus];
    if (modelCode) model[modelCode] += 1;
    if (goldCode) gold[goldCode] += 1;
  }
  return { model, gold };
}

const SEMANTIC_BUCKET_LABELS = ['0-20', '21-40', '41-60', '61-80', '81-100'];

function semanticBucketIndex(score) {
  if (score <= 20) return 0;
  if (score <= 40) return 1;
  if (score <= 60) return 2;
  if (score <= 80) return 3;
  return 4;
}

function computeSemanticBuckets(perQuestionBreakdown) {
  const matched = [0, 0, 0, 0, 0];
  const mismatched = [0, 0, 0, 0, 0];
  for (const entry of perQuestionBreakdown) {
    const i = semanticBucketIndex(entry.score);
    if (entry.riskStatusMatches) matched[i] += 1;
    else mismatched[i] += 1;
  }
  const total = matched.map((m, i) => m + mismatched[i]);
  return { labels: SEMANTIC_BUCKET_LABELS, matched, mismatched, total };
}

const GOLD_CATEGORY_ORDER = [
  { code: 'det', label: 'Gold: Risk Detected' },
  { code: 'ns', label: 'Gold: Not Sure' },
  { code: 'nd', label: 'Gold: Not Detected' },
];

function computeSemanticByGoldCategory(perQuestionBreakdown) {
  const scoresByCode = { det: [], ns: [], nd: [] };
  for (const entry of perQuestionBreakdown) {
    const code = RISK_CODE[entry.expectedRiskStatus];
    if (code) scoresByCode[code].push(entry.score);
  }
  return GOLD_CATEGORY_ORDER.map(({ code, label }) => {
    const scores = scoresByCode[code];
    const avgScore = scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : 0;
    return { label, count: scores.length, avgScore };
  });
}

module.exports = {
  REPORT_CSS,
  escapeHtml,
  verdictKind,
  computeRiskStatusMatchCounts,
  computeRiskDistribution,
  computeSemanticBuckets,
  computeSemanticByGoldCategory,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/lib/html-report-template.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/html-report-template.js src/lib/html-report-template.test.js
git commit -m "feat: add html-report-template CSS, escaping, and compute helpers"
```

---

### Task 5: `src/lib/html-report-template.js` — SVG chart functions

**Files:**
- Modify: `src/lib/html-report-template.js`
- Test: `src/lib/html-report-template.test.js`

**Interfaces:**
- Consumes: `computeRiskStatusMatchCounts`, `computeRiskDistribution`,
  `computeSemanticBuckets`, `computeSemanticByGoldCategory` outputs (Task 4).
- Produces: `renderRiskStatusMatchBar(matched, mismatched): string`,
  `renderRiskDistributionChart(distribution): string`,
  `renderSemanticHistogram(buckets): string`,
  `renderSemanticByGoldCategoryChart(categories): string` — all return HTML/
  SVG markup strings, consumed by Task 7's Accuracy Summary section.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/html-report-template.test.js`:

```js
const {
  renderRiskStatusMatchBar, renderRiskDistributionChart,
  renderSemanticHistogram, renderSemanticByGoldCategoryChart,
} = require('./html-report-template');

test('renderRiskStatusMatchBar sizes the two flex segments to the matched/mismatched counts', () => {
  const html = renderRiskStatusMatchBar(3, 1);
  assert.match(html, /flex:3;background:var\(--good\)/);
  assert.match(html, /flex:1;background:var\(--critical\)/);
  assert.match(html, /Match · 3/);
  assert.match(html, /Mismatch · 1/);
  assert.match(html, /75% of answers/);
});

test('renderRiskDistributionChart renders one grouped bar per risk category with correct counts', () => {
  const svg = renderRiskDistributionChart({ model: { det: 2, nd: 0, ns: 1 }, gold: { det: 1, nd: 0, ns: 2 } });
  assert.match(svg, /<svg/);
  assert.match(svg, />2<\/text>/); // model det count
  assert.match(svg, />1<\/text>/); // gold det count (also model ns count — both appear)
  assert.match(svg, /Risk Detected/);
  assert.match(svg, /Not Sure/);
});

test('renderSemanticHistogram renders a bar per bucket with the total count labeled', () => {
  const buckets = { labels: ['0-20', '21-40', '41-60', '61-80', '81-100'], matched: [0, 0, 0, 0, 2], mismatched: [1, 0, 0, 0, 0], total: [1, 0, 0, 0, 2] };
  const svg = renderSemanticHistogram(buckets);
  assert.match(svg, /<svg/);
  assert.match(svg, /81-100/);
  assert.match(svg, />2<\/text>/);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/html-report-template.test.js`
Expected: FAIL — the four render functions are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/html-report-template.js` (before `module.exports`):

```js
function renderRiskStatusMatchBar(matched, mismatched) {
  const total = matched + mismatched;
  const pct = total ? Math.round((matched / total) * 100) : 0;
  return `
    <div class="chart-card">
      <h4>Risk-status match — ${matched} correct, ${mismatched} mismatched</h4>
      <div style="height:26px;border-radius:8px;overflow:hidden;background:#eef0f3;margin-top:12px;display:flex">
        <div style="flex:${matched};background:var(--good);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px">Match &middot; ${matched}</div>
        <div style="flex:${mismatched};background:var(--critical);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px">Mismatch &middot; ${mismatched}</div>
      </div>
      <p class="cap">${pct}% of answers pointed in the correct risk direction.</p>
    </div>`;
}

function renderRiskDistributionChart(distribution) {
  const data = [
    ['Risk Detected', distribution.model.det, distribution.gold.det],
    ['Not Detected', distribution.model.nd, distribution.gold.nd],
    ['Not Sure', distribution.model.ns, distribution.gold.ns],
  ];
  const W = 380, H = 190, pad = { l: 90, r: 20, t: 10, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, bh = ih / data.length;
  const maxValue = Math.max(1, ...data.flatMap(([, modelCount, goldCount]) => [modelCount, goldCount]));
  const max = Math.max(5, Math.ceil(maxValue / 5) * 5);

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let g = 0; g <= 5; g++) {
    const gridValue = (max * g) / 5;
    const x = pad.l + iw * (gridValue / max);
    s += `<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${pad.t + ih}" stroke="var(--grid)"/>`;
    s += `<text x="${x}" y="${H - 8}" font-size="9" fill="var(--muted)" text-anchor="middle">${Math.round(gridValue)}</text>`;
  }
  data.forEach(([label, modelCount, goldCount], i) => {
    const y = pad.t + bh * i + 6;
    const h = (bh - 16) / 2;
    const w1 = iw * (modelCount / max);
    const w2 = iw * (goldCount / max);
    s += `<text x="${pad.l - 8}" y="${y + h}" font-size="10.5" fill="var(--ink-2)" text-anchor="end">${label}</text>`;
    s += `<rect x="${pad.l}" y="${y}" width="${w1}" height="${h}" rx="3" fill="var(--blue)"/>`;
    s += `<text x="${pad.l + w1 + 5}" y="${y + h - 1}" font-size="10" font-weight="700" fill="var(--ink)">${modelCount}</text>`;
    s += `<rect x="${pad.l}" y="${y + h + 3}" width="${w2}" height="${h}" rx="3" fill="var(--muted)"/>`;
    s += `<text x="${pad.l + w2 + 5}" y="${y + h * 2 + 2}" font-size="10" font-weight="700" fill="var(--ink)">${goldCount}</text>`;
  });
  s += `</svg>`;
  return s;
}

function renderSemanticHistogram(buckets) {
  const { labels, matched, mismatched, total } = buckets;
  const W = 380, H = 196, pad = { l: 34, r: 12, t: 14, b: 34 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, bw = iw / total.length;
  const maxValue = Math.max(1, ...total);
  const step = Math.max(1, Math.ceil(maxValue / 4));

  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let g = 0; g <= maxValue; g += step) {
    const y = pad.t + ih - ih * (g / maxValue);
    s += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="var(--grid)"/>`;
    s += `<text x="${pad.l - 6}" y="${y + 3}" font-size="9" fill="var(--muted)" text-anchor="end">${g}</text>`;
  }
  total.forEach((v, i) => {
    const x = pad.l + bw * i + 8, w = bw - 16;
    const hMismatch = ih * (mismatched[i] / maxValue);
    const hMatch = ih * (matched[i] / maxValue);
    const yMismatch = pad.t + ih - hMismatch;
    const yMatch = yMismatch - hMatch - (hMatch && hMismatch ? 2 : 0);
    if (mismatched[i] > 0) s += `<rect x="${x}" y="${yMismatch}" width="${w}" height="${hMismatch}" rx="4" fill="var(--critical)"/>`;
    if (matched[i] > 0) s += `<rect x="${x}" y="${yMatch}" width="${w}" height="${hMatch}" rx="4" fill="var(--good)"/>`;
    if (v > 0) s += `<text x="${x + w / 2}" y="${(matched[i] ? yMatch : yMismatch) - 4}" font-size="11" font-weight="800" fill="var(--ink)" text-anchor="middle">${v}</text>`;
    s += `<text x="${x + w / 2}" y="${H - 18}" font-size="9" fill="var(--muted)" text-anchor="middle">${labels[i]}</text>`;
  });
  s += `<text x="${pad.l + iw / 2}" y="${H - 4}" font-size="8.5" fill="var(--muted)" text-anchor="middle">semantic match % (vs gold answer)</text>`;
  s += `</svg>`;
  return s;
}

function renderSemanticByGoldCategoryChart(categories) {
  const W = 760, H = 170, pad = { l: 150, r: 60, t: 10, b: 22 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, bh = ih / categories.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let g = 0; g <= 100; g += 20) {
    const x = pad.l + iw * (g / 100);
    s += `<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${pad.t + ih}" stroke="var(--grid)"/>`;
    s += `<text x="${x}" y="${H - 6}" font-size="9" fill="var(--muted)" text-anchor="middle">${g}%</text>`;
  }
  categories.forEach(({ label, count, avgScore }, i) => {
    const y = pad.t + bh * i + 10, h = bh - 30;
    s += `<text x="${pad.l - 10}" y="${y + h / 2 - 2}" font-size="11" font-weight="600" fill="var(--ink-2)" text-anchor="end">${escapeHtml(label)}</text>`;
    s += `<text x="${pad.l - 10}" y="${y + h / 2 + 12}" font-size="9" fill="var(--muted)" text-anchor="end">${count} question${count === 1 ? '' : 's'}</text>`;
    s += `<rect x="${pad.l}" y="${y}" width="${iw}" height="${h}" rx="5" fill="#e9e8e2"/>`;
    const w = iw * (avgScore / 100);
    if (count > 0) {
      s += `<rect x="${pad.l}" y="${y}" width="${w}" height="${h}" rx="5" fill="var(--blue)"/>`;
      s += `<text x="${pad.l + w + 8}" y="${y + h / 2 + 4}" font-size="12" font-weight="800" fill="var(--ink)">${avgScore}%</text>`;
    } else {
      s += `<text x="${pad.l + 8}" y="${y + h / 2 + 4}" font-size="11" fill="var(--muted)">&mdash; no questions &mdash;</text>`;
    }
  });
  s += `</svg>`;
  return s;
}
```

Update `module.exports` to add the four new functions:

```js
module.exports = {
  REPORT_CSS,
  escapeHtml,
  verdictKind,
  computeRiskStatusMatchCounts,
  computeRiskDistribution,
  computeSemanticBuckets,
  computeSemanticByGoldCategory,
  renderRiskStatusMatchBar,
  renderRiskDistributionChart,
  renderSemanticHistogram,
  renderSemanticByGoldCategoryChart,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/lib/html-report-template.test.js`
Expected: PASS, all tests in this file green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/html-report-template.js src/lib/html-report-template.test.js
git commit -m "feat: add SVG chart builders to html-report-template"
```

---

### Task 6: `src/lib/html-report-template.js` — hero header, KPI cards, Ingestion/Processing sections

**Files:**
- Modify: `src/lib/html-report-template.js`
- Test: `src/lib/html-report-template.test.js`

**Interfaces:**
- Consumes: a `claimData` object's ingestion/processing/identity fields
  (see full shape in Task 8) — this task only needs
  `{ bucketId, claimantName, generatedAt, docsSubmitted, docsComplete,
  docsFailed, failedDocuments, ingestionTimeMs, processingTimeMs,
  namedScores, accuracy, fraudRiskScoreExpected, fraudRiskScoreActual,
  fraudRiskScoreMatches }`.
- Produces: `renderHeroHeader(claimData): string`,
  `renderKpiCards(claimData): string`, `renderIngestionSummary(claimData): string`,
  `renderProcessingSummary(claimData): string`, plus a `formatSeconds(ms): string`
  helper (ported from the existing `generate-pdf-report.js`, since that file
  is rewritten in Task 9 and no longer the natural home for a template-facing
  formatter). Consumed by Task 8's top-level `renderReportHtml`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/html-report-template.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/html-report-template.test.js`
Expected: FAIL — the five new functions are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/html-report-template.js` (before `module.exports`):

```js
function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderHeroHeader(claimData) {
  const docsLine = `${claimData.docsComplete} / ${claimData.docsSubmitted}`;
  const docsPct = claimData.docsSubmitted ? Math.round((claimData.docsComplete / claimData.docsSubmitted) * 100) : 0;
  return `
  <header class="hero">
    <div class="hero-top">
      <div class="brand">FraudX<small>CLAIM EVALUATION</small></div>
      <div class="pillwrap">
        <div class="pill match">OVERALL SCORE&nbsp;&middot;&nbsp;<b>${claimData.accuracy}%</b></div>
      </div>
    </div>
    <div class="kicker">CLAIM EVAL REPORT</div>
    <h1 class="title">${escapeHtml(claimData.claimantName)} &mdash; Fraud Risk Evaluation</h1>
    <p class="subtitle">Automated fraud-risk evaluation of a single claim, scored against the gold rubric for risk direction, answer content, and citation accuracy.</p>
    <div class="meta-row">
      <div><div class="m-lab">BUCKET ID</div><div class="m-val"><code>${claimData.bucketId}</code></div></div>
      <div><div class="m-lab">CLAIMANT</div><div class="m-val">${escapeHtml(claimData.claimantName)}</div></div>
      <div><div class="m-lab">GENERATED</div><div class="m-val">${claimData.generatedAt}</div></div>
      <div><div class="m-lab">DOCS INGESTED</div><div class="m-val">${docsLine} &middot; ${docsPct}%</div></div>
    </div>
  </header>`;
}

function renderKpiCards(claimData) {
  const { namedScores } = claimData;
  const citationPct = namedScores.citationMatch === undefined ? 'N/A' : `${Math.round(namedScores.citationMatch * 100)}%`;
  const delta = ((claimData.fraudRiskScoreActual - claimData.fraudRiskScoreExpected) * 100).toFixed(2);
  const toleranceLabel = claimData.fraudRiskScoreMatches
    ? '<span style="color:var(--good-ink);font-weight:700">within &plusmn;10%</span>'
    : '<span style="color:var(--critical);font-weight:700">outside &plusmn;10%</span>';
  return `
  <div class="cards c4" style="margin-top:20px">
    <div class="card hl"><span class="tag">OVERALL SCORE</span><div class="big" style="color:#4d7a08">${Math.round(namedScores.riskStatusMatch * 100)}%</div><div class="lab"><b>Risk-status match</b></div></div>
    <div class="card"><div class="big amber">${Math.round(namedScores.answerContentMatch * 100)}%</div><div class="lab">Answer-content match</div></div>
    <div class="card"><div class="big red">${citationPct}</div><div class="lab">Citation match</div></div>
    <div class="card"><div class="big blue">${(claimData.fraudRiskScoreActual * 100).toFixed(2)}%</div><div class="lab">Claim risk score <span style="color:var(--muted)">vs gold</span></div><div class="sub">gold ${(claimData.fraudRiskScoreExpected * 100).toFixed(2)}% &middot; ${delta} pts &middot; ${toleranceLabel}</div></div>
  </div>`;
}

function renderIngestionSummary(claimData) {
  const failedList = claimData.failedDocuments.length > 0
    ? `<p class="cap"><b>Failed documents:</b> ${claimData.failedDocuments.map((d) => `${escapeHtml(d.fileName)}: ${escapeHtml(d.error)}`).join('; ')}</p>`
    : '';
  return `
  <section>
    <div class="sec-head"><span class="sec-num">1</span><h2>Ingestion Summary</h2></div>
    <p class="sec-sub">The claim documents for Bucket <code>${claimData.bucketId}</code> were ingested ahead of evaluation.</p>
    <div class="cards c4">
      <div class="card"><div class="big">${claimData.docsSubmitted}</div><div class="lab">Docs submitted</div></div>
      <div class="card"><div class="big green">${claimData.docsComplete}</div><div class="lab">Docs complete</div></div>
      <div class="card"><div class="big ${claimData.docsFailed > 0 ? 'red' : ''}">${claimData.docsFailed}</div><div class="lab">Docs failed</div></div>
      <div class="card"><div class="big">${formatSeconds(claimData.ingestionTimeMs)}</div><div class="lab">Ingestion time</div></div>
    </div>
    ${failedList}
  </section>`;
}

function renderProcessingSummary(claimData) {
  const totalWallMs = claimData.ingestionTimeMs + claimData.processingTimeMs;
  return `
  <section>
    <div class="sec-head"><span class="sec-num">2</span><h2>Processing Summary</h2></div>
    <p class="sec-sub">Time spent turning ingested documents into scored risk answers. Only total ingestion and claim-processing time are emitted; per-step timings are marked <code>N/A</code>.</p>
    <div class="cards c3">
      <div class="card"><div class="big">${formatSeconds(claimData.ingestionTimeMs)}</div><div class="lab">Ingestion time</div></div>
      <div class="card"><div class="big blue">${formatSeconds(claimData.processingTimeMs)}</div><div class="lab">Claim processing time</div></div>
      <div class="card"><div class="big">${formatSeconds(totalWallMs)}</div><div class="lab">Total wall-clock</div></div>
    </div>
    <div class="chart-card">
      <h4>Per-step processing breakdown</h4>
      <table>
        <thead><tr><th>Processing step</th><th class="num">Time taken</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td>Entity / claim profile generation</td><td class="num">N/A</td><td>Not captured in source</td></tr>
          <tr><td>Question answering</td><td class="num">N/A</td><td>Not captured in source</td></tr>
          <tr><td>Citation extraction / matching</td><td class="num">N/A</td><td>Not captured in source</td></tr>
          <tr><td>Summary / metadata generation</td><td class="num">N/A</td><td>Not captured in source</td></tr>
          <tr class="tot"><td>Total claim processing</td><td class="num">${formatSeconds(claimData.processingTimeMs)}</td><td>Only total was emitted</td></tr>
        </tbody>
      </table>
    </div>
  </section>`;
}
```

Update `module.exports` to add `formatSeconds`, `renderHeroHeader`,
`renderKpiCards`, `renderIngestionSummary`, `renderProcessingSummary`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/lib/html-report-template.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/html-report-template.js src/lib/html-report-template.test.js
git commit -m "feat: add hero header, KPI cards, and ingestion/processing sections"
```

---

### Task 7: `src/lib/html-report-template.js` — Accuracy Summary + Final Verdict sections

**Files:**
- Modify: `src/lib/html-report-template.js`
- Test: `src/lib/html-report-template.test.js`

**Interfaces:**
- Consumes: Task 4's compute helpers, Task 5's chart renderers, and
  `claimData.narrative` (the parsed narrative object from
  `generateNarrativeAnalysis` or its fallback — shape:
  `{ summaryPanel, questionsPanel, citationsPanel, overallPanel, finalVerdict: { netRead, whatWentRight, whatWentWrong, reasoning } }`).
- Produces: `renderAccuracySummary(claimData): string`,
  `renderFinalVerdict(claimData): string`. Consumed by Task 8.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/html-report-template.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/html-report-template.test.js`
Expected: FAIL — `renderAccuracySummary`/`renderFinalVerdict` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/html-report-template.js` (before `module.exports`):

```js
function renderBulletList(items) {
  return `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
}

function renderAccuracySummary(claimData) {
  const { perQuestionBreakdown, narrative } = claimData;
  const { matched, mismatched } = computeRiskStatusMatchCounts(perQuestionBreakdown);
  const distribution = computeRiskDistribution(perQuestionBreakdown);
  const buckets = computeSemanticBuckets(perQuestionBreakdown);
  const goldCategories = computeSemanticByGoldCategory(perQuestionBreakdown);

  return `
  <section>
    <div class="sec-head"><span class="sec-num">3</span><h2>Accuracy Summary</h2></div>
    <p class="sec-sub">How well the engine's answers matched the gold rubric.</p>
    <div class="grid2">
      <div class="panel"><h4><span class="dot" style="background:var(--aqua)"></span>Summary</h4>${renderBulletList(narrative.summaryPanel)}</div>
      <div class="panel"><h4><span class="dot" style="background:var(--blue)"></span>Questions</h4>${renderBulletList(narrative.questionsPanel)}</div>
      <div class="panel"><h4><span class="dot" style="background:var(--critical)"></span>Citations</h4>${renderBulletList(narrative.citationsPanel)}</div>
      <div class="panel"><h4><span class="dot" style="background:var(--violet)"></span>Overall</h4>${renderBulletList(narrative.overallPanel)}</div>
    </div>
    ${renderRiskStatusMatchBar(matched, mismatched)}
    <div class="grid2">
      <div class="chart-card" style="margin-top:0">
        <h4>Risk distribution &mdash; model vs gold</h4>
        ${renderRiskDistributionChart(distribution)}
        <div class="legend"><span><span class="dot" style="background:var(--blue)"></span>Model output</span><span><span class="dot" style="background:var(--muted)"></span>Gold expected</span></div>
      </div>
      <div class="chart-card" style="margin-top:0">
        <h4>Semantic match vs gold &mdash; score distribution</h4>
        ${renderSemanticHistogram(buckets)}
        <div class="legend"><span><span class="dot" style="background:var(--good)"></span>Matched gold direction</span><span><span class="dot" style="background:var(--critical)"></span>Missed gold direction</span></div>
      </div>
    </div>
    <div class="chart-card">
      <h4>Semantic match vs the gold dataset &mdash; by expected category</h4>
      ${renderSemanticByGoldCategoryChart(goldCategories)}
      <div class="legend"><span><span class="dot" style="background:var(--blue)"></span>Model avg semantic match</span><span><span class="dot" style="background:#d7d6d0"></span>Gold reference (100%)</span></div>
    </div>
  </section>`;
}

function renderFinalVerdict(claimData) {
  const { finalVerdict } = claimData.narrative;
  return `
  <section>
    <div class="sec-head"><span class="sec-num">4</span><h2>Final Verdict</h2></div>
    <div class="callout verdict">
      <h4>Net read</h4>
      ${renderBulletList(finalVerdict.netRead)}
    </div>
    <div class="grid2">
      <div class="panel"><h4 style="color:var(--good-ink)">What went right</h4>${renderBulletList(finalVerdict.whatWentRight)}</div>
      <div class="panel"><h4 style="color:#a01d1d">What went wrong</h4>${renderBulletList(finalVerdict.whatWentWrong)}</div>
    </div>
    <div class="callout info">
      <h4>Reasoning</h4>
      ${escapeHtml(finalVerdict.reasoning)}
    </div>
  </section>`;
}
```

Update `module.exports` to add `renderAccuracySummary`, `renderFinalVerdict`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/lib/html-report-template.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/html-report-template.js src/lib/html-report-template.test.js
git commit -m "feat: add Accuracy Summary and Final Verdict section renderers"
```

---

### Task 8: `src/lib/html-report-template.js` — tables, Q&A appendix, top-level `renderReportHtml`

**Files:**
- Modify: `src/lib/html-report-template.js`
- Test: `src/lib/html-report-template.test.js`

**Interfaces:**
- Consumes: `formatAnswerWithCitations` (`src/lib/extract-cited-file-names.js`,
  existing), `verdictKind` (Task 4), all render functions from Tasks 4-7.
- Produces: `renderDetailedResultsTable(claimData): string`,
  `renderMetadataMatchTable(claimData): string`,
  `renderQaAppendix(claimData): string`,
  `renderReportHtml(claimData): string` (the full document — the module's
  main export, consumed by Task 9's `generate-pdf-report.js`).

Full `claimData` shape (union of everything consumed across Tasks 6-8):

```js
{
  bucketId, claimantName, generatedAt,
  docsSubmitted, docsComplete, docsFailed, failedDocuments,
  ingestionTimeMs, processingTimeMs,
  namedScores, accuracy,
  fraudRiskScoreExpected, fraudRiskScoreActual, fraudRiskScoreMatches,
  metadataMatch: [{ field, expected, actual, matches }],
  perQuestionBreakdown: [ /* qaMatchAssertion shape, plus expectedRiskStatus */ ],
  narrative: {
    summaryPanel, questionsPanel, citationsPanel, overallPanel,
    finalVerdict: { netRead, whatWentRight, whatWentWrong, reasoning },
    perQuestionVerdicts: { [predefinedQuestionId]: string },
  },
}
```

- [ ] **Step 1: Write the failing test**

Append to `src/lib/html-report-template.test.js`:

```js
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

test('renderMetadataMatchTable renders expected/actual/match for every field', () => {
  const html = renderMetadataMatchTable(fullClaimData());
  assert.match(html, /Risk Score/);
  assert.match(html, /75\.24%/);
  assert.match(html, /Claimant Name/);
  assert.match(html, /chip yes/);
  assert.match(html, /chip no/);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/lib/html-report-template.test.js`
Expected: FAIL — the four new functions are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/html-report-template.js`. First, require the existing
citation-formatting helper at the top of the file (alongside `'use strict'`):

```js
const { formatAnswerWithCitations } = require('./extract-cited-file-names');
```

Then, before `module.exports`:

```js
const RISK_LABEL = { RISK_DETECTED: 'Risk Detected', RISK_NOT_DETECTED: 'Risk Not Detected', UNSURE: 'Not Sure' };

function riskChip(riskStatus) {
  const code = RISK_CODE[riskStatus] || 'ns';
  return `<span class="chip ${code}">${RISK_LABEL[riskStatus] || 'Unknown'}</span>`;
}

function scoreBar(score) {
  if (typeof score !== 'number') return '<span class="mini" style="color:var(--muted)">N/A</span>';
  const color = score >= 80 ? 'var(--good)' : score >= 40 ? 'var(--warning)' : 'var(--critical)';
  return `<span class="mbar"><i style="width:${score}%;background:${color}"></i></span><span class="mini">${score}%</span>`;
}

function renderDetailedResultsTable(claimData) {
  const rows = claimData.perQuestionBreakdown.map((q) => `
    <tr class="${q.riskStatusMatches ? '' : 'row-miss'}">
      <td><b>Q${q.predefinedQuestionId}</b></td>
      <td>${riskChip(q.riskStatus)}</td>
      <td>${riskChip(q.expectedRiskStatus)}</td>
      <td class="ctr"><span class="chip ${q.riskStatusMatches ? 'yes' : 'no'}">${q.riskStatusMatches ? 'MATCH' : 'MISS'}</span></td>
      <td class="num">${scoreBar(q.score)}</td>
      <td class="num">${typeof q.citationMatchScore === 'number' ? `${q.citationMatchScore}%` : '<span style="color:var(--muted)">N/A</span>'}</td>
    </tr>`).join('');
  return `
  <section>
    <div class="sec-head"><h2>Detailed Results Table</h2></div>
    <p class="sec-sub">Every question's current output vs expected output, whether the risk direction matched, and the semantic and citation match scores.</p>
    <table>
      <thead><tr><th>Question ID</th><th>Current Output</th><th>Expected Output</th><th class="ctr">Risk Match</th><th class="num">Semantic Match</th><th class="num">Citation Match</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderMetadataMatchTable(claimData) {
  const rows = claimData.metadataMatch.map((m) => `
    <tr>
      <td><b>${escapeHtml(m.field)}</b></td>
      <td>${escapeHtml(m.expected)}</td>
      <td>${escapeHtml(m.actual)}</td>
      <td class="ctr"><span class="chip ${m.matches ? 'yes' : 'no'}">${m.matches ? 'YES' : 'NO'}</span></td>
    </tr>`).join('');
  return `
  <section>
    <div class="sec-head"><h2>Claim Metadata Match</h2></div>
    <table>
      <thead><tr><th>Field</th><th>Expected</th><th>Actual</th><th class="ctr">Match</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function renderQaAppendix(claimData) {
  const cards = claimData.perQuestionBreakdown.map((q) => {
    const kind = verdictKind(q);
    const verdictSymbol = kind === 'good' ? '&#10003;' : kind === 'bad' ? '&#10007;' : '&asymp;';
    const oneLiner = claimData.narrative.perQuestionVerdicts[q.predefinedQuestionId] || '';
    const { cleanedText, legend } = formatAnswerWithCitations(q.actualAnswer);
    const answerHtml = escapeHtml(cleanedText).replace(/\[(\d+)\]/g, '<sup class="c">[$1]</sup>');
    const sourcesHtml = legend.length === 0
      ? '<span style="color:var(--muted)">No source document cited</span>'
      : legend.map((l) => l.url
        ? `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.fileName)}</a>&nbsp;<span class="idx">[${l.number}]</span>`
        : `${escapeHtml(l.fileName)}&nbsp;<span class="idx">[${l.number}]</span>`).join(' &middot; ');

    return `
    <div class="qcard">
      <div class="qtop">
        <span class="qid">Q${q.predefinedQuestionId}</span>
        <span class="qtext">${escapeHtml(q.question)}</span>
        <span class="qchips">${riskChip(q.riskStatus)}</span>
      </div>
      <div class="verdict-line ${kind}">${verdictSymbol}&nbsp;${escapeHtml(oneLiner)}</div>
      <p class="ans">${answerHtml}</p>
      <div class="metrics-inline">
        <span>Expected: <b>${RISK_LABEL[q.expectedRiskStatus] || 'Unknown'}</b></span>
        <span>Risk match: <b style="color:${q.riskStatusMatches ? 'var(--good-ink)' : 'var(--critical)'}">${q.riskStatusMatches ? 'Yes' : 'No'}</b></span>
        <span>Semantic: <b>${q.score}%</b></span>
        <span>Citation: <b>${typeof q.citationMatchScore === 'number' ? `${q.citationMatchScore}%` : 'N/A'}</b></span>
      </div>
      <div class="reason"><b>Evaluator reasoning:</b> ${escapeHtml(q.reason)}</div>
      <div class="srcs"><b>Sources:</b> ${sourcesHtml}</div>
    </div>`;
  }).join('');

  return `
  <section>
    <div class="sec-head"><h2>All Questions &mdash; Answers &amp; Evaluation</h2></div>
    <p class="sec-sub">Full engine answer for every question, a highlighted one-line verdict, the evaluator's reasoning, and hyperlinked sources.</p>
    ${cards}
  </section>`;
}

function renderReportHtml(claimData) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Claim Eval Report &middot; Bucket ${claimData.bucketId}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
  ${renderHeroHeader(claimData)}
  ${renderKpiCards(claimData)}
  ${renderIngestionSummary(claimData)}
  ${renderProcessingSummary(claimData)}
  ${renderAccuracySummary(claimData)}
  ${renderFinalVerdict(claimData)}
  ${renderDetailedResultsTable(claimData)}
  ${renderMetadataMatchTable(claimData)}
  ${renderQaAppendix(claimData)}
  <div class="foot">Generated ${claimData.generatedAt} by the fraudx-eval-harness eval pipeline.</div>
</div>
</body>
</html>`;
}
```

Update `module.exports` to add `renderDetailedResultsTable`,
`renderMetadataMatchTable`, `renderQaAppendix`, `renderReportHtml`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/lib/html-report-template.test.js`
Expected: PASS, every test in this file green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/html-report-template.js src/lib/html-report-template.test.js
git commit -m "feat: add tables, Q&A appendix, and top-level renderReportHtml"
```

---

### Task 9: Rewrite `scripts/generate-pdf-report.js` orchestrator + dependency swap

**Files:**
- Modify: `scripts/generate-pdf-report.js` (full rewrite of its body; keeps
  the same exported `generatePdfReports(resultsFilePath, reportsDir, now)`
  and `main()` entry points)
- Modify: `package.json` (remove `pdfkit`, add `puppeteer`)
- Test: `scripts/generate-pdf-report.test.js` (rewritten to assert against
  the new HTML-templated/Puppeteer-rendered output)

**Interfaces:**
- Consumes: `src/lib/narrative-analysis.js`'s `generateNarrativeAnalysis`
  (Task 3), `src/lib/html-report-template.js`'s `renderReportHtml` (Task 8),
  `src/lib/metadata-match-assertion.js`'s `entitiesMatch`/`fraudRiskScoreMatches`
  (existing), `promptfoo.loadApiProvider` (existing pattern).
- Produces: same public surface as today —
  `generatePdfReports(resultsFilePath, reportsDir, now): Promise<string[]>`
  (array of written file paths), `main()`. `formatTimestampForFilename`,
  `formatLocalTimestamp`, `sortByRiskStatus`, `uniqueFilePath` keep their
  existing behavior and are re-exported unchanged for
  `scripts/score-dashboard.js`'s consumers and existing tests.

- [ ] **Step 1: Install the new dependency and remove the old one**

```bash
npm uninstall pdfkit
npm install puppeteer
```

- [ ] **Step 2: Write the failing test**

Rewrite `scripts/generate-pdf-report.test.js`. This keeps the existing
`sampleResultsFile()` fixture and `FIXED_NOW` constant (unchanged from
today), but replaces the pdfkit-era assertions with HTML/Puppeteer-era ones.
Key new tests (add alongside/replacing the existing PDF-content assertions
that reference removed pdfkit-only helpers like `drawStatCardRow`,
`formatScore`, `formatRiskStatus`, `riskStatusColor`, `booleanMatchColor`,
which no longer exist since rendering moved to `html-report-template.js`):

```js
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
  const resultsPath = writeResultsFile(dir, sampleResultsFile());
  const reportsDir = path.join(dir, 'reports');
  const failingProvider = { callApi: async () => ({ error: 'rate limited' }) };

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW, failingProvider);

  assert.ok(fs.existsSync(filePath));
  const text = await extractPdfText(filePath);
  assert.match(text, /32277/);
  assert.match(text, /narrative analysis unavailable/i);
});

test('formatTimestampForFilename, formatLocalTimestamp, sortByRiskStatus, uniqueFilePath are unchanged', () => {
  assert.equal(formatTimestampForFilename('2026-08-20T12:07:23.000Z'), '2026-08-20T12-07-23');
  assert.equal(typeof formatLocalTimestamp(FIXED_NOW()), 'string');
  assert.deepEqual(
    sortByRiskStatus([{ riskStatus: 'UNSURE' }, { riskStatus: 'RISK_DETECTED' }]).map((e) => e.riskStatus),
    ['RISK_DETECTED', 'UNSURE'],
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unique-'));
  const p1 = path.join(dir, 'x.pdf');
  fs.writeFileSync(p1, 'x');
  assert.equal(uniqueFilePath(p1), path.join(dir, 'x-2.pdf'));
});
```

Note: `generatePdfReports` gains a 4th, optional parameter — a pre-loaded
`provider` — so tests never need real network access or to monkeypatch
`promptfoo.loadApiProvider`. When omitted (the real CLI path via `main()`),
it defaults to loading `process.env.GRADER_PROVIDER` exactly once, reusing
the same instance across every claim in the run.

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test scripts/generate-pdf-report.test.js`
Expected: FAIL — old file still uses pdfkit/old signature; `%PDF` /
narrative fixtures won't line up until the rewrite lands.

- [ ] **Step 4: Write minimal implementation**

Rewrite `scripts/generate-pdf-report.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const promptfoo = require('promptfoo');
const puppeteer = require('puppeteer');
const { entitiesMatch, fraudRiskScoreMatches } = require('../src/lib/metadata-match-assertion');
const { generateNarrativeAnalysis } = require('../src/lib/narrative-analysis');
const {
  renderReportHtml, computeRiskDistribution, computeSemanticByGoldCategory,
} = require('../src/lib/html-report-template');
const { computeAccuracy, scoreDashboard, dashboardHasErrors } = require('./score-dashboard');

function formatTimestampForFilename(isoTimestamp) {
  return isoTimestamp.replace(/:/g, '-').replace(/\.\d+Z$/, '');
}

// Formats a Date in IST (Asia/Kolkata) — see prior design note in the
// pre-rewrite version of this file for why this must not depend on the
// host machine's own timezone.
function formatLocalTimestamp(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => {
    const value = parts.find((p) => p.type === type).value;
    return type === 'hour' && value === '24' ? '00' : value;
  };
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

const RISK_STATUS_ORDER = ['RISK_DETECTED', 'UNSURE', 'RISK_NOT_DETECTED'];
function riskStatusSortKey(riskStatus) {
  const index = RISK_STATUS_ORDER.indexOf(riskStatus);
  return index === -1 ? RISK_STATUS_ORDER.length : index;
}
function sortByRiskStatus(perQuestionBreakdown) {
  return [...perQuestionBreakdown].sort((a, b) => riskStatusSortKey(a.riskStatus) - riskStatusSortKey(b.riskStatus));
}

function uniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
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

function findComponent(gradingResult, metric) {
  return (gradingResult.componentResults || []).find((c) => c.assertion && c.assertion.metric === metric);
}

const REQUIRED_NAMED_SCORES = ['riskStatusMatch', 'answerContentMatch', 'report_quality', 'fraudRiskScoreMatch', 'entityFieldsMatch'];
function hasRequiredNamedScores(namedScores) {
  return REQUIRED_NAMED_SCORES.every((key) => typeof namedScores?.[key] === 'number' && !Number.isNaN(namedScores[key]));
}

function isClaimRenderable(result) {
  const output = result.response?.output;
  return Boolean(
    output && output.ingestion &&
    typeof output.ingestion.docsSubmitted === 'number' &&
    typeof output.ingestion.docsComplete === 'number' &&
    output.processing && result.vars?.expected &&
    hasRequiredNamedScores(result.gradingResult?.namedScores)
  );
}

const FALLBACK_NARRATIVE = {
  summaryPanel: ['Narrative analysis unavailable for this run.'],
  questionsPanel: ['Narrative analysis unavailable for this run.'],
  citationsPanel: ['Narrative analysis unavailable for this run.'],
  overallPanel: ['Narrative analysis unavailable for this run.'],
  finalVerdict: {
    netRead: ['Narrative analysis unavailable for this run.'],
    whatWentRight: ['Narrative analysis unavailable for this run.'],
    whatWentWrong: ['Narrative analysis unavailable for this run.'],
    reasoning: 'Narrative analysis unavailable for this run.',
  },
  perQuestionVerdicts: {},
};

function buildClaimData(result, generatedAt) {
  const output = result.response.output;
  const report = output.report;
  const expected = result.vars.expected;
  const namedScores = result.gradingResult.namedScores;
  const qaMatchComponent = findComponent(result.gradingResult, 'qa_match');
  const perQuestionBreakdown = sortByRiskStatus((qaMatchComponent && qaMatchComponent.perQuestionBreakdown) || []);
  const failedDocuments = output.failedDocuments || [];

  const fraudScoreMatches = fraudRiskScoreMatches(report.fraudRiskScore, expected.fraudRiskScore);
  const metadataMatch = [
    {
      field: 'Risk Score (±10% tol.)',
      expected: `${expected.fraudRiskScore.toFixed(4)} · ${(expected.fraudRiskScore * 100).toFixed(2)}%`,
      actual: `${report.fraudRiskScore.toFixed(4)} · ${(report.fraudRiskScore * 100).toFixed(2)}%`,
      matches: fraudScoreMatches,
    },
    { field: 'Claimant Name', expected: expected.claimantName, actual: report.claimantName, matches: entitiesMatch(report.claimantName, expected.claimantName) },
    { field: 'Defendant', expected: expected.defendant, actual: report.defendant, matches: entitiesMatch(report.defendant, expected.defendant) },
    { field: 'Insurance Firm', expected: expected.insuranceFirm, actual: report.insuranceFirm, matches: entitiesMatch(report.insuranceFirm, expected.insuranceFirm) },
  ];

  return {
    bucketId: report.bucketId,
    claimantName: report.claimantName,
    generatedAt,
    docsSubmitted: output.ingestion.docsSubmitted,
    docsComplete: output.ingestion.docsComplete,
    docsFailed: failedDocuments.length,
    failedDocuments,
    ingestionTimeMs: output.ingestion.timeMs,
    processingTimeMs: output.processing.timeMs,
    namedScores,
    accuracy: computeAccuracy(namedScores),
    fraudRiskScoreExpected: expected.fraudRiskScore,
    fraudRiskScoreActual: report.fraudRiskScore,
    fraudRiskScoreMatches: fraudScoreMatches,
    metadataMatch,
    perQuestionBreakdown,
  };
}

function buildNarrativeClaimSummary(claimData) {
  return {
    namedScores: claimData.namedScores,
    riskDistribution: computeRiskDistribution(claimData.perQuestionBreakdown),
    semanticByGoldCategory: computeSemanticByGoldCategory(claimData.perQuestionBreakdown),
    metadataMatch: claimData.metadataMatch,
    questions: claimData.perQuestionBreakdown.map((q) => ({
      id: q.predefinedQuestionId,
      question: q.question,
      expectedRiskStatus: q.expectedRiskStatus,
      riskStatus: q.riskStatus,
      riskStatusMatches: q.riskStatusMatches,
      score: q.score,
      citationMatchScore: q.citationMatchScore,
      reason: q.reason,
      actualAnswerExcerpt: (q.actualAnswer || '').slice(0, 600),
    })),
  };
}

async function generatePdfReports(resultsFilePath, reportsDir, now = () => new Date(), providedProvider) {
  const raw = fs.readFileSync(resultsFilePath, 'utf8');
  const parsed = JSON.parse(raw);
  const results = parsed.results.results;
  const generatedAt = formatLocalTimestamp(now());

  const provider = providedProvider || await promptfoo.loadApiProvider(process.env.GRADER_PROVIDER);
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  const written = [];
  try {
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

      const claimData = buildClaimData(result, generatedAt);
      try {
        claimData.narrative = await generateNarrativeAnalysis(provider, buildNarrativeClaimSummary(claimData));
      } catch (err) {
        console.error(`Narrative analysis failed for claim ${bucketId}, using fallback: ${err.message}`);
        claimData.narrative = FALLBACK_NARRATIVE;
      }

      const html = renderReportHtml(claimData);
      const page = await browser.newPage();
      let pdfBuffer;
      try {
        await page.setContent(html);
        pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
      } finally {
        await page.close();
      }

      const fileName = `report-${formatTimestampForFilename(generatedAt)}.pdf`;
      const filePath = uniqueFilePath(path.join(reportsDir, String(bucketId), fileName));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, pdfBuffer);
      written.push(filePath);
    }
  } finally {
    await browser.close();
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
  sortByRiskStatus,
  uniqueFilePath,
};
```

In `package.json`, remove `"pdfkit": "^0.19.1"` from `dependencies` and add
`"puppeteer": "^23.0.0"` (or whatever the `npm install puppeteer` run in
Step 1 actually resolved — use that exact version, don't hand-guess it).

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test scripts/generate-pdf-report.test.js`
Expected: PASS. This test spins up real headless Chromium per case — expect
it to take several seconds longer than the old pdfkit-based test; that's
expected, not a regression to chase.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS — in particular, `scripts/score-dashboard.test.js` and
`scripts/build-tests-vars.test.js` are untouched by this rewrite and must
still pass unmodified.

- [ ] **Step 7: Commit**

```bash
git add scripts/generate-pdf-report.js scripts/generate-pdf-report.test.js package.json package-lock.json
git commit -m "feat: render the PDF report via HTML template + headless Chromium"
```

---

### Task 10: End-to-end verification, CI Chromium check, README update

**Files:**
- Modify: `.github/workflows/eval-workflow.yml` (only if Chromium fails to
  launch in CI — see Step 2)
- Modify: `README.md` (describe the new report format/mechanism, replacing
  any pdfkit-specific description)

**Interfaces:** none new — this task verifies the whole pipeline built in
Tasks 1-9 end-to-end and documents it.

- [ ] **Step 1: Run the mock-server dry run end-to-end**

Per `README.md`'s existing "Running against the mock server" instructions:

```bash
node test/mock-server.js &
MOCK_SERVER_PID=$!
# (run the documented mock-server eval invocation here, per README.md)
kill $MOCK_SERVER_PID
```

Open the produced PDF (`reports/<bucketId>/report-*.pdf`) and visually
confirm: navy hero header renders, KPI cards show percentages, all 4 charts
render as vector graphics (not broken images), the Q&A appendix shows
citation links, and the Final Verdict section shows prose (from the
narrative call, or the fallback placeholder if `GRADER_PROVIDER` isn't
configured for the dry run).

- [ ] **Step 2: Verify Chromium launches cleanly in the CI environment**

Push this branch and let `.github/workflows/eval-workflow.yml`'s job run (or
approximate the runner locally, e.g. via a matching `ubuntu-latest` Docker
image) and confirm `generatePdfReports` doesn't fail with a Chromium launch
error (e.g. `Failed to launch the browser process`). If it does fail:
add the missing shared libraries as an `apt-get install` step in
`.github/workflows/eval-workflow.yml` immediately before the eval step runs
(Puppeteer's own troubleshooting docs list the typical missing-package set
for minimal Debian/Ubuntu images) — do not disable the sandbox further or
skip this verification.

- [ ] **Step 3: Update README.md**

Replace any pdfkit-specific description of the PDF report (e.g. "drawn with
pdfkit", a description of stat-card rows, etc.) with a short paragraph
describing the new mechanism: the report is built as an HTML document
(navy/lime design, KPI cards, ingestion/processing/accuracy sections with
charts, a narrative Final Verdict, detailed tables, and a Q&A appendix),
then printed to PDF via headless Chromium (Puppeteer) — no HTML file is
written to disk, only the final PDF. Mention that the Final Verdict and
per-question one-line verdicts come from one additional LLM call per claim,
reusing the same `GRADER_PROVIDER` as the existing grading calls, and that
a failure in that call degrades gracefully to a placeholder rather than
failing the report.

- [ ] **Step 4: Commit**

```bash
git add README.md
# only if Step 2 required a workflow change:
git add .github/workflows/eval-workflow.yml
git commit -m "docs: describe the new HTML-templated, headless-rendered PDF report"
```

## Self-Review

- **Spec coverage:** every decision in
  `docs/superpowers/specs/2026-08-20-pdf-report-html-redesign-design.md` maps
  to a task — `expectedRiskStatus` threading (Task 1), the narrative module
  (Tasks 2-3), the HTML template module (Tasks 4-8), the Puppeteer-based
  orchestrator rewrite and dependency swap (Task 9), and the CI/README
  follow-through the spec calls out explicitly (Task 10).
- **Placeholder scan:** no `TBD`/`TODO` remain; every step has complete,
  runnable code, not a description of code.
- **Type/interface consistency:** `claimData`'s shape is introduced
  incrementally (Task 6 needs a subset, Task 7 adds `perQuestionBreakdown`/
  `narrative`, Task 8 states the full union) but every field name is used
  identically across tasks (`perQuestionBreakdown`, `expectedRiskStatus`,
  `citationMatchScore`, `namedScores`, `narrative.finalVerdict`, etc.) —
  cross-checked against Task 9's `buildClaimData`, which is the single place
  that actually constructs this object from `results.json`.
- **Scope check:** this is one cohesive deliverable (the redesigned report),
  not multiple independent subsystems — decomposed into 10 right-sized tasks
  by file/concern rather than split into separate plans.
