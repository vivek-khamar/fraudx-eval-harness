# Per-Claim PDF Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate one PDF report per scoreable claim after `npm run eval`, showing the per-question grading breakdown, claim-metadata match, and overall summary — backed by a redesigned `qa_match` (one LLM call per question instead of one batched call) and a new deterministic `metadata_match` assertion.

**Architecture:** `scripts/qa-match-assertion.js`'s answer-content grading moves from a single `matchesLlmRubric` call to a loop of `promptfoo.loadApiProvider(...).callApi(...)` calls, one per question, producing a `perQuestionBreakdown` array that rides through promptfoo's `componentResults` into `results.json`. A new `scripts/metadata-match-assertion.js` deterministically compares `fraudRiskScore` (within tolerance) and three entity fields (case/whitespace-insensitive) between the real report and new `expected*` fields added to `testdata/claims.json`. `scripts/score-dashboard.js`'s `accuracy` formula becomes equal fifths across all five named scores. A new `scripts/generate-pdf-report.js` reads `results.json` and writes `reports/<bucketId>/report-<timestamp>.pdf` via `pdfkit`, wired into `npm run score`.

**Tech Stack:** Node.js (`>=20.16.0 <21 || >=22.3.0`), `node:test` + `node:assert/strict`, `promptfoo` (`loadApiProvider`), `pdfkit` (new dependency), `pdf-parse` (already a dependency, reused to verify generated PDFs in tests).

## Global Constraints

- Node engines: `>=20.16.0 <21 || >=22.3.0`.
- Never destructure `require('promptfoo')` — always call through the module object (`promptfoo.loadApiProvider(...)`), so tests can monkey-patch it in place, matching the existing convention in `provider.test.js` (`mockFraudxClient`) and `scripts/qa-match-assertion.js`.
- No swallowed errors: a grader call failing, returning `response.error`, or returning unparseable JSON must throw and propagate — never caught-and-defaulted.
- New assertions follow the established pass/threshold convention: `pass = threshold === undefined ? score > 0 : score >= threshold`, with the assertion's own `metric:` name looked up via `context.test.assert.find((a) => a.metric === '<name>')`.
- Entity-field matching is case/whitespace-insensitive exact match — explicitly **not** fuzzy/similarity-based, even though real data shows genuine spelling variation ("One Team Restoration, Inc." vs "OneTeam Restoration, Inc.") that this will miss.
- `fraudRiskScore` tolerance is `±0.1`, inclusive at the boundary (`<=`).
- Generated output directories/files are gitignored, matching `results.json`'s existing treatment.

---

### Task 1: Add `buildQuestionGradingPrompt` and `parseGraderVerdict` to `scripts/qa-match-assertion.js`

**Files:**
- Modify: `scripts/qa-match-assertion.js`
- Modify: `scripts/qa-match-assertion.test.js`

**Interfaces:**
- Produces: `buildQuestionGradingPrompt(question, actualAnswer)` — `question` is one entry from `context.vars.expected.qa` (`{predefinedQuestionId, question, expectedAnswerSummary, expectedRiskStatus}`); `actualAnswer` is a string. Returns a self-contained prompt string (not a rubric fragment — this prompt is sent directly to a raw provider, not through promptfoo's `<Output>/<Rubric>` template).
- Produces: `parseGraderVerdict(responseOutput)` — `responseOutput` is whatever a provider's `callApi()` returns as its `output` field (a string, possibly wrapped in markdown code fences). Returns `{ matches: boolean, reason: string }`. Throws with a message containing `Could not find a JSON object` if no `{...}` is found in the text, or a message containing `missing matches/reason fields` if the parsed object lacks a boolean `matches` or string `reason`.
- This task is purely additive — it does not change `qaMatchAssertion`, `computeRiskStatusMatch`, or `buildAnswerContentRubric`. All 8 existing tests in `scripts/qa-match-assertion.test.js` must still pass unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/qa-match-assertion.test.js`, after the existing `buildAnswerContentRubric` tests (before the `mockMatchesLlmRubric` helper):

```js
test('buildQuestionGradingPrompt embeds the question, expected answer, and actual answer', () => {
  const question = { predefinedQuestionId: 1, question: 'Is there fraud?', expectedAnswerSummary: 'Yes, per doc X.' };
  const prompt = buildQuestionGradingPrompt(question, 'Yes, doc X confirms it.');

  assert.match(prompt, /Is there fraud\?/);
  assert.match(prompt, /Yes, per doc X\./);
  assert.match(prompt, /Yes, doc X confirms it\./);
  assert.match(prompt, /"matches": boolean, "reason": string/);
});

test('parseGraderVerdict parses a clean JSON response', () => {
  const result = parseGraderVerdict('{"matches": true, "reason": "content matches"}');
  assert.deepEqual(result, { matches: true, reason: 'content matches' });
});

test('parseGraderVerdict extracts JSON even when wrapped in markdown code fences', () => {
  const response = '```json\n{"matches": false, "reason": "no match"}\n```';
  assert.deepEqual(parseGraderVerdict(response), { matches: false, reason: 'no match' });
});

test('parseGraderVerdict throws a clear error when no JSON object is present', () => {
  assert.throws(() => parseGraderVerdict('not json at all'), /Could not find a JSON object/);
});

test('parseGraderVerdict throws a clear error when matches or reason fields are missing or the wrong type', () => {
  assert.throws(() => parseGraderVerdict('{"matches": "yes", "reason": "ok"}'), /missing matches\/reason fields/);
  assert.throws(() => parseGraderVerdict('{"matches": true}'), /missing matches\/reason fields/);
});
```

Add `buildQuestionGradingPrompt` and `parseGraderVerdict` to the destructured require at the top of the file (change the existing line):

```js
const { computeRiskStatusMatch, buildAnswerContentRubric, buildQuestionGradingPrompt, parseGraderVerdict } = require('./qa-match-assertion');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: FAIL — `buildQuestionGradingPrompt is not a function` (the existing 8 tests still pass; only the 5 new ones fail).

- [ ] **Step 3: Write the minimal implementation**

Add to `scripts/qa-match-assertion.js`, directly after `buildAnswerContentRubric` (do not remove `buildAnswerContentRubric` yet — that happens in Task 2):

```js
function buildQuestionGradingPrompt(question, actualAnswer) {
  return [
    `Question: ${question.question}`,
    `Expected answer: ${question.expectedAnswerSummary}`,
    `Model answer: ${actualAnswer}`,
    '',
    "Does the model answer's content and reasoning semantically match the expected answer above",
    '(exact wording does not matter, meaning does)? Respond with only a JSON object, no other text:',
    '{"matches": boolean, "reason": string}.',
  ].join('\n');
}

function parseGraderVerdict(responseOutput) {
  const text = typeof responseOutput === 'string' ? responseOutput : JSON.stringify(responseOutput);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Could not find a JSON object in grader response: ${text}`);
  }
  const parsed = JSON.parse(match[0]);
  if (typeof parsed.matches !== 'boolean' || typeof parsed.reason !== 'string') {
    throw new Error(`Grader response JSON missing matches/reason fields: ${text}`);
  }
  return { matches: parsed.matches, reason: parsed.reason };
}
```

Update the exports at the bottom of `scripts/qa-match-assertion.js`:

```js
module.exports = qaMatchAssertion;
module.exports.computeRiskStatusMatch = computeRiskStatusMatch;
module.exports.buildAnswerContentRubric = buildAnswerContentRubric;
module.exports.buildQuestionGradingPrompt = buildQuestionGradingPrompt;
module.exports.parseGraderVerdict = parseGraderVerdict;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: PASS (13 tests: the 8 existing plus these 5 new ones)

- [ ] **Step 5: Commit**

```bash
git add scripts/qa-match-assertion.js scripts/qa-match-assertion.test.js
git commit -m "feat: add buildQuestionGradingPrompt and parseGraderVerdict helpers"
```

---

### Task 2: Rewrite `qaMatchAssertion` to grade one question per call, adding `perQuestionBreakdown`

**Files:**
- Modify: `scripts/qa-match-assertion.js`
- Modify: `scripts/qa-match-assertion.test.js`

**Interfaces:**
- Consumes: `buildQuestionGradingPrompt`, `parseGraderVerdict` (Task 1), `computeRiskStatusMatch` (unchanged).
- Produces: `qaMatchAssertion(output, context)` (default export, unchanged signature) now returns `{ pass, score, reason, namedScores: { riskStatusMatch, answerContentMatch }, perQuestionBreakdown }`, where `perQuestionBreakdown` is an array with one entry per question: `{ predefinedQuestionId, question, actualAnswer, matches, reason }`.
- `buildAnswerContentRubric` and its two tests are deleted in this task — the batched-rubric mechanism is fully replaced.
- Tests now mock `promptfoo.loadApiProvider` instead of `promptfoo.assertions.matchesLlmRubric`.

- [ ] **Step 1: Write the failing tests**

In `scripts/qa-match-assertion.test.js`, delete these two tests entirely (now superseded — the per-question mechanism no longer builds one combined rubric):
- `'buildAnswerContentRubric embeds every expected question, its expected answer, and the matching actual answer'`
- `'buildAnswerContentRubric marks a question missing from the actual report as no answer provided'`

Also delete `buildAnswerContentRubric` from the destructured require line (restoring it to just the Task 1 additions):

```js
const { computeRiskStatusMatch, buildQuestionGradingPrompt, parseGraderVerdict } = require('./qa-match-assertion');
```

Replace the `mockMatchesLlmRubric` helper and the four `qaMatchAssertion` tests (everything from `function mockMatchesLlmRubric` to the end of the file) with:

```js
function mockLoadApiProvider(t, callApiImpl) {
  const original = promptfoo.loadApiProvider;
  assert.equal(typeof original, 'function', 'mock target must already exist — loadApiProvider moved or was renamed');
  promptfoo.loadApiProvider = async () => ({ callApi: callApiImpl });
  t.after(() => {
    promptfoo.loadApiProvider = original;
  });
}

function fakeContext(overrides) {
  return {
    vars: {
      expected: {
        qa: [
          { predefinedQuestionId: 1, question: 'Q1?', expectedAnswerSummary: 'A1', expectedRiskStatus: 'RISK_DETECTED' },
          { predefinedQuestionId: 2, question: 'Q2?', expectedAnswerSummary: 'A2', expectedRiskStatus: 'UNSURE' },
          { predefinedQuestionId: 3, question: 'Q3?', expectedAnswerSummary: 'A3', expectedRiskStatus: 'RISK_DETECTED' },
        ],
      },
    },
    test: { assert: [{ metric: 'qa_match' }], options: { provider: 'anthropic:messages:claude-sonnet-4-5' } },
    ...overrides,
  };
}

function fakeOutput() {
  return {
    report: {
      questions: [
        { predefinedQuestionId: 1, riskStatus: 'RISK_DETECTED', answer: 'ans1' },
        { predefinedQuestionId: 2, riskStatus: 'RISK_DETECTED', answer: 'ans2' }, // mismatch vs UNSURE
        { predefinedQuestionId: 3, riskStatus: 'RISK_DETECTED', answer: 'ans3' },
      ],
    },
  };
}

test('qaMatchAssertion combines riskStatusMatch and answerContentMatch into namedScores and an averaged score, calling the grader once per question', async (t) => {
  let callCount = 0;
  mockLoadApiProvider(t, async () => {
    callCount += 1;
    const matches = callCount !== 3; // third question mismatches
    return { output: JSON.stringify({ matches, reason: `reason ${callCount}` }) };
  });

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(callCount, 3); // one call per question, not one batched call
  assert.equal(result.namedScores.riskStatusMatch, 2 / 3);
  assert.equal(result.namedScores.answerContentMatch, 2 / 3);
  assert.equal(result.score, (2 / 3 + 2 / 3) / 2);
  assert.equal(result.pass, true);
});

test('qaMatchAssertion returns one perQuestionBreakdown entry per question', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'looks right' }) }));

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(result.perQuestionBreakdown.length, 3);
  assert.deepEqual(result.perQuestionBreakdown[0], {
    predefinedQuestionId: 1,
    question: 'Q1?',
    actualAnswer: 'ans1',
    matches: true,
    reason: 'looks right',
  });
});

test('qaMatchAssertion grades a missing actual answer as NO ANSWER PROVIDED', async (t) => {
  let capturedPrompt;
  mockLoadApiProvider(t, async (prompt) => {
    capturedPrompt = prompt;
    return { output: JSON.stringify({ matches: false, reason: 'no answer' }) };
  });

  const output = { report: { questions: [] } }; // no actual answers exist at all
  await qaMatchAssertion(output, fakeContext());

  assert.match(capturedPrompt, /NO ANSWER PROVIDED/);
});

test('qaMatchAssertion fails when score is below an explicit threshold on the qa_match assert entry', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: false, reason: 'low' }) }));

  const context = fakeContext({ test: { assert: [{ metric: 'qa_match', threshold: 0.9 }], options: {} } });
  const result = await qaMatchAssertion(fakeOutput(), context);

  // riskStatusMatch = 2/3, answerContentMatch = 0, score = (2/3 + 0) / 2 = 1/3, below threshold 0.9
  assert.equal(result.pass, false);
});

test('qaMatchAssertion propagates an error thrown by the grader provider instead of swallowing it', async (t) => {
  mockLoadApiProvider(t, async () => {
    throw new Error('grader provider timed out');
  });

  await assert.rejects(() => qaMatchAssertion(fakeOutput(), fakeContext()), /grader provider timed out/);
});

test('qaMatchAssertion propagates a response.error from the grader provider', async (t) => {
  mockLoadApiProvider(t, async () => ({ error: 'rate limited' }));

  await assert.rejects(() => qaMatchAssertion(fakeOutput(), fakeContext()), /rate limited/);
});

test('qaMatchAssertion propagates a parse error when the grader response has no JSON object', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: 'not json at all' }));

  await assert.rejects(() => qaMatchAssertion(fakeOutput(), fakeContext()), /Could not find a JSON object/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: FAIL — the new tests fail because `qaMatchAssertion` still calls `promptfoo.assertions.matchesLlmRubric` (never invoking the mocked `promptfoo.loadApiProvider`), so e.g. `callCount` stays `0` and the real `matchesLlmRubric` path throws for lack of network access.

- [ ] **Step 3: Write the minimal implementation**

Delete `buildAnswerContentRubric` entirely from `scripts/qa-match-assertion.js` (both the function and its `module.exports.buildAnswerContentRubric = buildAnswerContentRubric;` line).

Replace the `qaMatchAssertion` function with:

```js
async function qaMatchAssertion(output, context) {
  const expectedQa = context.vars.expected.qa;
  const actualQuestions = output.report.questions;

  const riskStatusMatch = computeRiskStatusMatch(output, expectedQa);

  const provider = await promptfoo.loadApiProvider(context.test.options.provider);
  const perQuestionBreakdown = [];
  for (const q of expectedQa) {
    const actual = actualQuestions.find((r) => r.predefinedQuestionId === q.predefinedQuestionId);
    const actualAnswer = actual && actual.answer ? actual.answer : 'NO ANSWER PROVIDED';
    const prompt = buildQuestionGradingPrompt(q, actualAnswer);
    const response = await provider.callApi(prompt);
    if (response.error) {
      throw new Error(response.error);
    }
    const { matches, reason } = parseGraderVerdict(response.output);
    perQuestionBreakdown.push({ predefinedQuestionId: q.predefinedQuestionId, question: q.question, actualAnswer, matches, reason });
  }
  const answerContentMatch = perQuestionBreakdown.filter((v) => v.matches).length / perQuestionBreakdown.length;

  const score = (riskStatusMatch + answerContentMatch) / 2;

  const qaMatchAssert = context.test && Array.isArray(context.test.assert)
    ? context.test.assert.find((a) => a.metric === 'qa_match')
    : undefined;
  const threshold = qaMatchAssert && qaMatchAssert.threshold;
  const pass = threshold === undefined ? score > 0 : score >= threshold;

  return {
    pass,
    score,
    reason: `riskStatusMatch=${riskStatusMatch}, answerContentMatch=${answerContentMatch}`,
    namedScores: { riskStatusMatch, answerContentMatch },
    perQuestionBreakdown,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: PASS (15 tests: `computeRiskStatusMatch` ×2, `buildQuestionGradingPrompt` ×1, `parseGraderVerdict` ×4, `qaMatchAssertion` ×8)

- [ ] **Step 5: Commit**

```bash
git add scripts/qa-match-assertion.js scripts/qa-match-assertion.test.js
git commit -m "feat: grade qa_match one question per LLM call instead of one batched call"
```

---

### Task 3: Create `scripts/metadata-match-assertion.js`

**Files:**
- Create: `scripts/metadata-match-assertion.js`
- Test: `scripts/metadata-match-assertion.test.js`

**Interfaces:**
- Produces: default export `metadataMatchAssertion(output, context)` — `output.report` has `fraudRiskScore` (number), `claimantName`/`defendant`/`insuranceFirm` (strings); `context.vars.expected` has the same four field names. Returns `{ pass, score, reason, namedScores: { fraudRiskScoreMatch, entityFieldsMatch } }`. Not async — no I/O needed.
- Produces named exports `normalize(str)`, `entitiesMatch(actual, expected)`, `fraudRiskScoreMatches(actual, expected)` — used directly by this task's tests and later by `scripts/generate-pdf-report.js` (Task 6) so the PDF's match column can't drift from what the assertion actually computed.

- [ ] **Step 1: Write the failing tests**

Create `scripts/metadata-match-assertion.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const metadataMatchAssertion = require('./metadata-match-assertion');
const { normalize, entitiesMatch, fraudRiskScoreMatches } = require('./metadata-match-assertion');

test('normalize trims, lowercases, and collapses repeated whitespace', () => {
  assert.equal(normalize('  One Team   Restoration, Inc.  '), 'one team restoration, inc.');
});

test('entitiesMatch is true for case/whitespace-only differences', () => {
  assert.equal(entitiesMatch('New York State Insurance Fund (NYSIF)', '  new york state insurance fund (nysif)  '), true);
});

test('entitiesMatch is false for genuinely different spelling, not just case/whitespace', () => {
  assert.equal(entitiesMatch('One Team Restoration, Inc.', 'OneTeam Restoration, Inc.'), false);
});

test('fraudRiskScoreMatches is true at exactly the 0.1 boundary', () => {
  assert.equal(fraudRiskScoreMatches(0.7, 0.8), true);
  assert.equal(fraudRiskScoreMatches(0.8, 0.7), true);
});

test('fraudRiskScoreMatches is false just outside the 0.1 boundary', () => {
  assert.equal(fraudRiskScoreMatches(0.68, 0.8), false);
});

test('metadataMatchAssertion scores 1/1 for both sub-scores when everything matches', () => {
  const output = { report: { fraudRiskScore: 0.7, claimantName: 'Jose Briones', defendant: 'One Team Restoration, Inc.', insuranceFirm: 'NYSIF' } };
  const context = {
    vars: { expected: { fraudRiskScore: 0.68, claimantName: 'jose briones', defendant: 'one team restoration, inc.', insuranceFirm: 'nysif' } },
    test: { assert: [{ metric: 'metadata_match' }] },
  };

  const result = metadataMatchAssertion(output, context);

  assert.equal(result.namedScores.fraudRiskScoreMatch, 1);
  assert.equal(result.namedScores.entityFieldsMatch, 1);
  assert.equal(result.score, 1);
  assert.equal(result.pass, true);
});

test('metadataMatchAssertion computes entityFieldsMatch as a fraction when only some entity fields match', () => {
  const output = { report: { fraudRiskScore: 0.7, claimantName: 'Jose Briones', defendant: 'Wrong Defendant', insuranceFirm: 'NYSIF' } };
  const context = {
    vars: { expected: { fraudRiskScore: 0.7, claimantName: 'Jose Briones', defendant: 'One Team Restoration, Inc.', insuranceFirm: 'NYSIF' } },
    test: { assert: [{ metric: 'metadata_match' }] },
  };

  const result = metadataMatchAssertion(output, context);

  assert.equal(result.namedScores.fraudRiskScoreMatch, 1);
  assert.equal(result.namedScores.entityFieldsMatch, 2 / 3);
});

test('metadataMatchAssertion fails when score is below an explicit threshold on the metadata_match assert entry', () => {
  const output = { report: { fraudRiskScore: 0.1, claimantName: 'Wrong', defendant: 'Wrong', insuranceFirm: 'Wrong' } };
  const context = {
    vars: { expected: { fraudRiskScore: 0.9, claimantName: 'Right', defendant: 'Right', insuranceFirm: 'Right' } },
    test: { assert: [{ metric: 'metadata_match', threshold: 0.5 }] },
  };

  const result = metadataMatchAssertion(output, context);

  assert.equal(result.namedScores.fraudRiskScoreMatch, 0);
  assert.equal(result.namedScores.entityFieldsMatch, 0);
  assert.equal(result.pass, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/metadata-match-assertion.test.js`
Expected: FAIL — `Cannot find module './metadata-match-assertion'` (file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/metadata-match-assertion.js`:

```js
'use strict';

function normalize(str) {
  return (str || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function entitiesMatch(actual, expected) {
  return normalize(actual) === normalize(expected);
}

function fraudRiskScoreMatches(actual, expected) {
  return Math.abs(actual - expected) <= 0.1;
}

function metadataMatchAssertion(output, context) {
  const expected = context.vars.expected;
  const report = output.report;

  const fraudRiskScoreMatch = fraudRiskScoreMatches(report.fraudRiskScore, expected.fraudRiskScore) ? 1 : 0;

  const entityFields = [
    [report.claimantName, expected.claimantName],
    [report.defendant, expected.defendant],
    [report.insuranceFirm, expected.insuranceFirm],
  ];
  const entityMatchCount = entityFields.filter(([actual, exp]) => entitiesMatch(actual, exp)).length;
  const entityFieldsMatch = entityMatchCount / entityFields.length;

  const score = (fraudRiskScoreMatch + entityFieldsMatch) / 2;

  const metadataMatchAssert = context.test && Array.isArray(context.test.assert)
    ? context.test.assert.find((a) => a.metric === 'metadata_match')
    : undefined;
  const threshold = metadataMatchAssert && metadataMatchAssert.threshold;
  const pass = threshold === undefined ? score > 0 : score >= threshold;

  return {
    pass,
    score,
    reason: `fraudRiskScoreMatch=${fraudRiskScoreMatch}, entityFieldsMatch=${entityFieldsMatch}`,
    namedScores: { fraudRiskScoreMatch, entityFieldsMatch },
  };
}

module.exports = metadataMatchAssertion;
module.exports.normalize = normalize;
module.exports.entitiesMatch = entitiesMatch;
module.exports.fraudRiskScoreMatches = fraudRiskScoreMatches;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/metadata-match-assertion.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/metadata-match-assertion.js scripts/metadata-match-assertion.test.js
git commit -m "feat: add metadata_match assertion for fraudRiskScore and entity fields"
```

---

### Task 4: Wire `metadata_match` into `testdata/claims.json`, `generate-tests-vars.js`, `config-shape.test.js`, `promptfooconfig.yaml`

**Files:**
- Modify: `testdata/claims.json`
- Modify: `scripts/generate-tests-vars.js`
- Modify: `scripts/generate-tests-vars.test.js`
- Modify: `config-shape.test.js`
- Modify: `promptfooconfig.yaml`

**Interfaces:**
- Consumes: `scripts/metadata-match-assertion.js`'s default export (Task 3) — referenced by promptfoo via `value: file://scripts/metadata-match-assertion.js`.
- Produces: `context.vars.expected.{fraudRiskScore, claimantName, defendant, insuranceFirm}` for every generated test case — consumed by `metadataMatchAssertion` (Task 3) and later by `scripts/generate-pdf-report.js` (Task 6).

- [ ] **Step 1: Update `testdata/claims.json`**

Add four new fields to the golden claim, directly after `"processingModelId": 9,` and before `"summary":` (values taken from a real report already produced for this claim):

```json
    "expectedFraudRiskScore": 0.6826285714,
    "expectedClaimantName": "Jose Briones",
    "expectedDefendant": "One Team Restoration, Inc.",
    "expectedInsuranceFirm": "New York State Insurance Fund (NYSIF)",
```

- [ ] **Step 2: Update `scripts/generate-tests-vars.js`**

Change the `expected:` block inside `buildTestsVars`:

```js
      expected: {
        summarySynopsis: claim.summary,
        fraudRiskScore: claim.expectedFraudRiskScore,
        claimantName: claim.expectedClaimantName,
        defendant: claim.expectedDefendant,
        insuranceFirm: claim.expectedInsuranceFirm,
        qa: claim.questions.map((q) => ({
          predefinedQuestionId: q.id,
          question: q.question,
          expectedAnswerSummary: q.expectedAnswer,
          expectedRiskStatus: q.expectedRiskStatus,
        })),
      },
```

- [ ] **Step 3: Update `scripts/generate-tests-vars.test.js`**

In `sampleClaim()`, add the four new fields (insert after `tags: [{ tagId: 3, tagValueId: 17 }],`):

```js
    tags: [{ tagId: 3, tagValueId: 17 }],
    expectedFraudRiskScore: 0.5,
    expectedClaimantName: 'Jane Doe',
    expectedDefendant: 'Acme Corp',
    expectedInsuranceFirm: 'Acme Insurance',
    summary: 'Gold summary.',
```

In the `'buildTestsVars maps a flat claim into promptfoo test-case shape'` test, update the expected `expected:` block:

```js
        expected: {
          summarySynopsis: 'Gold summary.',
          fraudRiskScore: 0.5,
          claimantName: 'Jane Doe',
          defendant: 'Acme Corp',
          insuranceFirm: 'Acme Insurance',
          qa: [
            {
              predefinedQuestionId: 1480,
              question: "Are any of the plaintiff's attorneys included in the list of attorneys bad actors?",
              expectedAnswerSummary: 'Yes.',
              expectedRiskStatus: 'RISK_DETECTED',
            },
          ],
        },
```

- [ ] **Step 4: Run `scripts/generate-tests-vars.test.js` to verify it passes**

Run: `node --test scripts/generate-tests-vars.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Update `promptfooconfig.yaml`**

Add a third assert entry after `report_quality`'s block, before the trailing comment about `tests: file://tests.vars.yaml`:

```yaml
    - type: javascript
      metric: metadata_match
      value: file://scripts/metadata-match-assertion.js
```

- [ ] **Step 6: Update `config-shape.test.js`**

In `'every test case\'s vars.expected has a summary and at least one predefined-question entry'`, add after the `summarySynopsis` checks:

```js
    assert.equal(typeof expected.summarySynopsis, 'string');
    assert.ok(expected.summarySynopsis.length > 0);
    assert.equal(typeof expected.fraudRiskScore, 'number');
    assert.equal(typeof expected.claimantName, 'string');
    assert.equal(typeof expected.defendant, 'string');
    assert.equal(typeof expected.insuranceFirm, 'string');
```

Replace `'config declares exactly two assertions: qa_match, report_quality'` with:

```js
test('config declares exactly three assertions: qa_match, report_quality, metadata_match', () => {
  const asserts = config.defaultTest.assert;
  assert.ok(Array.isArray(asserts));
  assert.equal(asserts.length, 3);

  const qaMatch = asserts.find((a) => a.metric === 'qa_match');
  assert.equal(qaMatch.type, 'javascript');
  assert.equal(qaMatch.value, 'file://scripts/qa-match-assertion.js');

  const reportQuality = asserts.find((a) => a.metric === 'report_quality');
  assert.equal(reportQuality.type, 'llm-rubric');
  assert.ok(reportQuality.value.includes('{{expected.summarySynopsis}}'));
  assert.ok(reportQuality.value.toLowerCase().includes('citeddocumentstext'));

  const metadataMatch = asserts.find((a) => a.metric === 'metadata_match');
  assert.equal(metadataMatch.type, 'javascript');
  assert.equal(metadataMatch.value, 'file://scripts/metadata-match-assertion.js');
});
```

- [ ] **Step 7: Run the full test suite to verify it passes**

Run: `npm test`
Expected: 82 tests total (75 baseline + 7 net-new from Tasks 1-2 + 8 new from Task 3, before the `pretest` hook regenerates `tests.vars.yaml` from the updated `testdata/claims.json`), 81 pass, 1 fail — the same pre-existing, unrelated failure on `testdata/claims.json`'s missing `tags` array (`config-shape.test.js`, `'every test case\'s vars.bucket has a sourceBucketId and a newClaim config'`). If you see a *different* failure, stop and investigate before continuing — do not assume it's the known one.

- [ ] **Step 8: Commit**

```bash
git add testdata/claims.json scripts/generate-tests-vars.js scripts/generate-tests-vars.test.js config-shape.test.js promptfooconfig.yaml
git commit -m "feat: wire metadata_match into config, test data, and generated vars"
```

---

### Task 5: Rebalance `scripts/score-dashboard.js`'s `accuracy` to equal fifths

**Files:**
- Modify: `scripts/score-dashboard.js`
- Modify: `scripts/score-dashboard.test.js`
- Modify: `test/fixtures/results.sample.json`

**Interfaces:**
- Consumes: `namedScores.riskStatusMatch`, `namedScores.answerContentMatch`, `namedScores.report_quality` (existing), `namedScores.fraudRiskScoreMatch`, `namedScores.entityFieldsMatch` (new, from `metadataMatchAssertion` — Task 3).

- [ ] **Step 1: Update the fixture file**

In `test/fixtures/results.sample.json`, replace the `namedScores` block:

```json
        "gradingResult": {
          "pass": true,
          "score": 1,
          "namedScores": {
            "riskStatusMatch": 0.9,
            "answerContentMatch": 0.7,
            "report_quality": 0.85,
            "fraudRiskScoreMatch": 1,
            "entityFieldsMatch": 1
          }
        }
```

- [ ] **Step 2: Update `scripts/score-dashboard.test.js`**

In the first test (`'scoreDashboard reads results.json and computes all three dashboard numbers...'`), change:

```js
  // acc = round((100/3)*riskStatusMatch + (100/3)*answerContentMatch + (100/3)*report_quality)
  //     = round((100/3)*0.9 + (100/3)*0.7 + (100/3)*0.85) = round(81.666...) = 82
  assert.equal(dashboard.accuracy, 82);
```
to:
```js
  // accuracy = round(20*(riskStatusMatch + answerContentMatch + report_quality + fraudRiskScoreMatch + entityFieldsMatch))
  //          = round(20*0.9 + 20*0.7 + 20*0.85 + 20*1 + 20*1) = round(89) = 89
  assert.equal(dashboard.accuracy, 89);
```

In the second test (`'scoreDashboard reports ingestionTime and processingTime independently...'`), change the fixture's `namedScores`:
```js
            gradingResult: {
              pass: true,
              score: 1,
              namedScores: {
                riskStatusMatch: 0.9,
                answerContentMatch: 0.7,
                report_quality: 0.85,
                fraudRiskScoreMatch: 1,
                entityFieldsMatch: 1,
              },
            },
```

In the third test (`'scoreDashboard scores every claim in results.json independently...'`), change both claims' fixtures and both `accuracy` assertions:
```js
            gradingResult: { pass: true, score: 1, namedScores: { riskStatusMatch: 0.9, answerContentMatch: 0.7, report_quality: 0.85, fraudRiskScoreMatch: 1, entityFieldsMatch: 1 } },
```
```js
            gradingResult: { pass: true, score: 1, namedScores: { riskStatusMatch: 0.4, answerContentMatch: 0.3, report_quality: 0.5, fraudRiskScoreMatch: 0, entityFieldsMatch: 0.5 } },
```
```js
  assert.equal(dashboards[0].accuracy, 89);
```
```js
  // accuracy = round(20*0.4 + 20*0.3 + 20*0.5 + 20*0 + 20*0.5) = round(34) = 34
  assert.equal(dashboards[1].accuracy, 34);
```

In the fifth test (`'scoreDashboard reports a claim with a NaN accuracy score...'`), change the fixture to add the two new fields while still omitting `report_quality` (the point of this test is one missing score → NaN, regardless of which one):
```js
            gradingResult: {
              pass: false,
              score: 0,
              namedScores: {
                riskStatusMatch: 0.9,
                answerContentMatch: 0.8,
                fraudRiskScoreMatch: 1,
                entityFieldsMatch: 1,
                // report_quality is missing
              },
            },
```

In the sixth test (`'scoreDashboard scores a healthy claim even when another claim in the same file errored'`), change:
```js
            gradingResult: { pass: true, score: 1, namedScores: { riskStatusMatch: 0.4, answerContentMatch: 0.3, report_quality: 0.5, fraudRiskScoreMatch: 0, entityFieldsMatch: 0.5 } },
```
```js
  assert.equal(dashboards[1].accuracy, 34);
```

In the seventh test (`'scoreDashboard reports full scores for a claim that has namedScores even though promptfoo marked it as errored...'`), change:
```js
            gradingResult: {
              pass: false,
              score: 0.65,
              namedScores: { riskStatusMatch: 0.629, answerContentMatch: 0.571, report_quality: 0.7, fraudRiskScoreMatch: 1, entityFieldsMatch: 2 / 3 },
            },
```
```js
  // accuracy = round(20*0.629 + 20*0.571 + 20*0.7 + 20*1 + 20*(2/3)) = round(71.333...) = 71
  assert.equal(dashboards[0].accuracy, 71);
```

The fourth test (`'scoreDashboard throws a clear error when results.json has no results'`) and eighth test (`'scoreDashboard reports the bucketId of a claim whose provider call succeeded but grading errored'`) need no changes — neither references `namedScores` or `accuracy`.

- [ ] **Step 3: Run the dashboard test suite to verify it fails**

Run: `node --test scripts/score-dashboard.test.js`
Expected: FAIL — the formula still divides by 3, so the new expected values (89, 34, 71) don't match what the old formula computes.

- [ ] **Step 4: Update the formula in `scripts/score-dashboard.js`**

Replace:

```js
    const accuracy = Math.round(
      (100 / 3) * namedScores.riskStatusMatch +
      (100 / 3) * namedScores.answerContentMatch +
      (100 / 3) * namedScores.report_quality
    );
```

with:

```js
    const accuracy = Math.round(
      20 * namedScores.riskStatusMatch +
      20 * namedScores.answerContentMatch +
      20 * namedScores.report_quality +
      20 * namedScores.fraudRiskScoreMatch +
      20 * namedScores.entityFieldsMatch
    );
```

- [ ] **Step 5: Run the dashboard test suite to verify it passes**

Run: `node --test scripts/score-dashboard.test.js`
Expected: PASS (9 tests)

- [ ] **Step 6: Commit**

```bash
git add scripts/score-dashboard.js scripts/score-dashboard.test.js test/fixtures/results.sample.json
git commit -m "feat: rebalance accuracy to equal fifths across all five named scores"
```

---

### Task 6: Install `pdfkit` and create `scripts/generate-pdf-report.js`

**Files:**
- Modify: `package.json` (via `npm install`, not hand-edited)
- Create: `scripts/generate-pdf-report.js`
- Test: `scripts/generate-pdf-report.test.js`

**Interfaces:**
- Consumes: `entitiesMatch`, `fraudRiskScoreMatches` (Task 3) — reused so the PDF's match column can never disagree with what `metadata_match` actually computed.
- Consumes: `result.gradingResult.componentResults` — an array where each entry has `assertion.metric` and whatever extra fields that assertion returned (e.g. `qa_match`'s entry has `perQuestionBreakdown`, `report_quality`'s entry has `reason`). This relies on promptfoo's `AssertionsResult.addResult` storing the *whole* object an assertion returns (`this.componentResults[index] = result`), not just recognized fields — already confirmed once this project (see `docs/superpowers/specs/2026-08-12-qa-match-answer-content-scoring-design.md`'s note on `componentResults`). Step 1 below re-confirms it against the exact installed version before this task relies on it again.
- Produces: `generatePdfReports(resultsFilePath, reportsDir)` — async, returns an array of file paths written (one per claim with a `bucketId`; claims without one are skipped). `formatTimestampForFilename(isoTimestamp)` — pure, converts `"2026-08-13T05:52:47.729Z"` to `"2026-08-13T05-52-47"`.

- [ ] **Step 1: Install pdfkit**

```bash
npm install pdfkit --save
```

Verify `package.json`'s `dependencies` now includes a `pdfkit` entry (alongside the existing `dotenv` and `pdf-parse`).

- [ ] **Step 2: Re-confirm `componentResults` preserves whatever an assertion returns**

Run: `grep -n "componentResults\[index\] = result" node_modules/promptfoo/dist/src/evaluator-SSlcaq_U.js`
Expected: one match, confirming this task's assumption that `perQuestionBreakdown` (an extra field beyond `pass`/`score`/`reason`/`namedScores`) survives into `results.json` untouched. If this returns no match, the installed promptfoo version changed this behavior — stop and escalate rather than continuing to build `generate-pdf-report.js` against an assumption that no longer holds.

- [ ] **Step 3: Write the failing tests**

Create `scripts/generate-pdf-report.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFParse } = require('pdf-parse');
const { generatePdfReports, formatTimestampForFilename } = require('./generate-pdf-report');

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
                  { predefinedQuestionId: 1, question: 'Is there fraud?', actualAnswer: 'Yes, per doc X.', matches: true, reason: 'Matches expected reasoning' },
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

test('formatTimestampForFilename converts an ISO timestamp into a filesystem-safe string', () => {
  assert.equal(formatTimestampForFilename('2026-08-13T05:52:47.729Z'), '2026-08-13T05-52-47');
});

test('generatePdfReports writes one PDF per claim with a bucketId, at reports/<bucketId>/report-<timestamp>.pdf', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile()));
  const reportsDir = path.join(tmpDir, 'reports');

  const written = await generatePdfReports(resultsPath, reportsDir);

  assert.equal(written.length, 1);
  assert.equal(written[0], path.join(reportsDir, '32023', 'report-2026-08-13T05-52-47.pdf'));
  assert.ok(fs.existsSync(written[0]));
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

  const written = await generatePdfReports(resultsPath, reportsDir);

  assert.equal(written.length, 0);
  assert.ok(!fs.existsSync(reportsDir));
});

test('generatePdfReports writes a PDF whose text includes the bucketId, question text, entity names, and report_quality reasoning', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify(sampleResultsFile()));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  assert.match(text, /32023/);
  assert.match(text, /Is there fraud\?/);
  assert.match(text, /Summary is complete and grounded\./);
  assert.match(text, /Jose Briones/);
  assert.match(text, /One Team Restoration, Inc\./);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test scripts/generate-pdf-report.test.js`
Expected: FAIL — `Cannot find module './generate-pdf-report'` (file doesn't exist yet).

- [ ] **Step 5: Write the minimal implementation**

Create `scripts/generate-pdf-report.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { entitiesMatch, fraudRiskScoreMatches } = require('./metadata-match-assertion');

const MARGIN = 50;
const COLUMN_GAP = 10;

function formatTimestampForFilename(isoTimestamp) {
  return isoTimestamp.replace(/:/g, '-').replace(/\.\d+Z$/, '');
}

function drawTableRow(doc, columns, colWidths) {
  const heights = columns.map((text, i) => doc.heightOfString(String(text), { width: colWidths[i] }));
  const rowHeight = Math.max(...heights) + 8;
  if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
  const startY = doc.y;
  let x = doc.page.margins.left;
  columns.forEach((text, i) => {
    doc.text(String(text), x, startY, { width: colWidths[i] });
    x += colWidths[i] + COLUMN_GAP;
  });
  doc.y = startY + rowHeight;
}

function findComponent(gradingResult, metric) {
  return (gradingResult.componentResults || []).find((c) => c.assertion && c.assertion.metric === metric);
}

function renderClaimPdf(result, timestamp, filePath) {
  const output = result.response.output;
  const report = output.report;
  const expected = result.vars.expected;
  const namedScores = result.gradingResult.namedScores;
  const qaMatchComponent = findComponent(result.gradingResult, 'qa_match');
  const reportQualityComponent = findComponent(result.gradingResult, 'report_quality');
  const perQuestionBreakdown = (qaMatchComponent && qaMatchComponent.perQuestionBreakdown) || [];

  const bucketId = report.bucketId;
  const ingestionTime = output.ingestion.timeMs / 1000;
  const processingTime = output.processing.timeMs / 1000;
  const accuracy = Math.round(
    20 * namedScores.riskStatusMatch +
    20 * namedScores.answerContentMatch +
    20 * namedScores.report_quality +
    20 * namedScores.fraudRiskScoreMatch +
    20 * namedScores.entityFieldsMatch
  );

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const doc = new PDFDocument({ margin: MARGIN });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  doc.fontSize(18).text(`Claim Report — bucket ${bucketId}`);
  doc.moveDown();
  doc.fontSize(11);
  doc.text(`Ingestion time: ${ingestionTime}s`);
  doc.text(`Processing time: ${processingTime}s`);
  doc.text(`Accuracy: ${accuracy}`);
  doc.text(`Generated at: ${timestamp}`);
  doc.moveDown();

  doc.fontSize(14).text('Question-by-question results');
  doc.moveDown(0.5);
  doc.fontSize(10);
  const qWidths = [170, 170, 40, 100];
  drawTableRow(doc, ['Question', 'Answer', 'Match', 'Reason'], qWidths);
  for (const entry of perQuestionBreakdown) {
    drawTableRow(doc, [entry.question, entry.actualAnswer, entry.matches ? 'YES' : 'NO', entry.reason], qWidths);
  }
  doc.moveDown();

  doc.fontSize(14).text('Claim metadata match');
  doc.moveDown(0.5);
  doc.fontSize(10);
  const mWidths = [110, 150, 150, 50];
  drawTableRow(doc, ['Field', 'Expected', 'Actual', 'Match'], mWidths);
  drawTableRow(doc, [
    'fraudRiskScore',
    String(expected.fraudRiskScore),
    String(report.fraudRiskScore),
    fraudRiskScoreMatches(report.fraudRiskScore, expected.fraudRiskScore) ? 'YES' : 'NO',
  ], mWidths);
  const entityRows = [
    ['claimantName', expected.claimantName, report.claimantName],
    ['defendant', expected.defendant, report.defendant],
    ['insuranceFirm', expected.insuranceFirm, report.insuranceFirm],
  ];
  for (const [field, exp, actual] of entityRows) {
    drawTableRow(doc, [field, exp, actual, entitiesMatch(actual, exp) ? 'YES' : 'NO'], mWidths);
  }
  doc.moveDown();

  doc.fontSize(14).text('Overall summary');
  doc.moveDown(0.5);
  doc.fontSize(10);
  doc.text(reportQualityComponent ? reportQualityComponent.reason : '(no report_quality reasoning available)');

  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function generatePdfReports(resultsFilePath, reportsDir) {
  const raw = fs.readFileSync(resultsFilePath, 'utf8');
  const parsed = JSON.parse(raw);
  const timestamp = parsed.results.timestamp;
  const results = parsed.results.results;

  const written = [];
  for (const result of results) {
    const bucketId = result.response?.output?.report?.bucketId;
    if (bucketId === undefined) {
      continue;
    }
    const fileName = `report-${formatTimestampForFilename(timestamp)}.pdf`;
    const filePath = path.join(reportsDir, String(bucketId), fileName);
    await renderClaimPdf(result, timestamp, filePath);
    written.push(filePath);
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
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

if (require.main === module) {
  main();
}

module.exports = { generatePdfReports, formatTimestampForFilename };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test scripts/generate-pdf-report.test.js`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json scripts/generate-pdf-report.js scripts/generate-pdf-report.test.js
git commit -m "feat: generate a per-claim PDF report from results.json"
```

---

### Task 7: Wire npm scripts, `.gitignore`, and full-suite verification

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `scripts/metadata-match-assertion.test.js` (Task 3), `scripts/generate-pdf-report.test.js` (Task 6), `scripts/generate-pdf-report.js`'s CLI entry point (Task 6, invoked via `node scripts/generate-pdf-report.js`).

- [ ] **Step 1: Update `package.json`'s `test` script**

Change:

```json
    "test": "node --test provider.test.js config-shape.test.js scripts/score-dashboard.test.js scripts/qa-match-assertion.test.js fraudx-client.test.js scripts/generate-tests-vars.test.js",
```

to:

```json
    "test": "node --test provider.test.js config-shape.test.js scripts/score-dashboard.test.js scripts/qa-match-assertion.test.js scripts/metadata-match-assertion.test.js scripts/generate-pdf-report.test.js fraudx-client.test.js scripts/generate-tests-vars.test.js",
```

- [ ] **Step 2: Update `package.json`'s `score` script**

Change:

```json
    "score": "node scripts/score-dashboard.js",
```

to:

```json
    "score": "node scripts/score-dashboard.js && node scripts/generate-pdf-report.js",
```

`&&` (not `;`) is correct here: if `scoreDashboard()` throws (e.g. "No results found in results.json" — a structural problem), there is genuinely nothing for the PDF generator to read, so skipping it is right. `npm run eval` already chains to `npm run score` (`"eval:raw; code=$?; npm run score; exit $code"`), so the PDF is produced automatically on every `npm run eval` with no change needed to that line.

- [ ] **Step 3: Update `.gitignore`**

Add `reports/` to the existing list:

```
node_modules/
.env
results.json
*.log
reports/
# Generated by scripts/generate-tests-vars.js from testdata/claims.json — never hand-edit.
tests.vars.yaml
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: 94 tests total, 93 pass, 1 fail — the same pre-existing, unrelated failure on `testdata/claims.json`'s missing `tags` array (`config-shape.test.js`). If you see a *different* failure, stop and investigate — do not assume it's the known one.

- [ ] **Step 5: Confirm no stray references to the removed batched-rubric mechanism remain**

Run: `grep -rn "buildAnswerContentRubric\|matchesLlmRubric" --include="*.js" .` (excluding `node_modules`)
Expected: no matches outside `node_modules` — that mechanism was fully replaced in Task 2.

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore
git commit -m "feat: wire metadata_match tests, PDF generation, and reports/ into npm scripts"
```
