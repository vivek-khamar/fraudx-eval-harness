# qa_match Answer-Content Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `qa_match` promptfoo assertion so it produces two named sub-scores — `riskStatusMatch` (existing deterministic enum-match, unchanged) and `answerContentMatch` (new: one LLM-rubric call per claim grading every question's actual answer text against its expected answer) — instead of adding a separate third assertion.

**Architecture:** `qa_match`'s inline YAML value moves to `scripts/qa-match-assertion.js`, a CommonJS module exporting `async function(output, context)`. It computes `riskStatusMatch` synchronously, builds one rubric prompt embedding all expected Q&A pairs plus the actual answers, grades it in a single call to `promptfoo`'s own `matchesLlmRubric` (the same function that powers the existing `report_quality` assertion), and returns `{ pass, score, reason, namedScores: { riskStatusMatch, answerContentMatch } }`. `scripts/score-dashboard.js`'s `acc` formula changes from 50/50 (qa_match/report_quality) to equal thirds across `riskStatusMatch`, `answerContentMatch`, and `report_quality`.

**Tech Stack:** Node.js (`>=20.16.0 <21 || >=22.3.0`), `node:test` + `node:assert/strict` (existing test runner, no new test framework), `promptfoo` (already a devDependency, exposes `matchesLlmRubric` as a public export), `js-yaml` (already a devDependency, used only in existing test files to parse `promptfooconfig.yaml`/`tests.vars.yaml`).

## Global Constraints

- Node engines: `>=20.16.0 <21 || >=22.3.0` (from `package.json:20-22`) — don't use syntax/APIs newer than that.
- No new npm dependencies — `promptfoo` (devDependency) and `js-yaml` (devDependency) already provide everything needed.
- Follow the existing mocking convention: monkey-patch the *module object's* property (not a destructured binding), with `t.after(() => { ... })` to restore it — see `provider.test.js:9-20` (`mockFraudxClient`). Never destructure `matchesLlmRubric` out of `require('promptfoo')` in the new module, or the test's monkey-patch won't be visible to it.
- Match the existing `scripts/*.js` convention: implementation file paired with a sibling `scripts/*.test.js`, using `'use strict'`, `module.exports = <primary fn>` plus named exports for internal helpers used directly in tests (see `provider.js:107-108`).

---

### Task 1: `riskStatusMatch` — pure function, extracted from the inline YAML value

**Files:**
- Create: `scripts/qa-match-assertion.js`
- Test: `scripts/qa-match-assertion.test.js`

**Interfaces:**
- Produces: `computeRiskStatusMatch(output, expectedQa)` — `output` is the parsed provider output object (shape: `{ report: { questions: [{ predefinedQuestionId, riskStatus, answer, ... }] }, ... }`); `expectedQa` is `context.vars.expected.qa` (array of `{ predefinedQuestionId, question, expectedAnswerSummary, expectedRiskStatus, expectedCitationFileNames }`). Returns a number in `[0, 1]`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/qa-match-assertion.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRiskStatusMatch } = require('./qa-match-assertion');

test('computeRiskStatusMatch returns the fraction of matching risk determinations', () => {
  const expectedQa = [
    { predefinedQuestionId: 1, expectedRiskStatus: 'RISK_DETECTED' },
    { predefinedQuestionId: 2, expectedRiskStatus: 'UNSURE' },
    { predefinedQuestionId: 3, expectedRiskStatus: 'RISK_DETECTED' },
  ];
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 1, riskStatus: 'RISK_DETECTED' },
        { predefinedQuestionId: 2, riskStatus: 'RISK_DETECTED' }, // mismatch vs UNSURE
        { predefinedQuestionId: 3, riskStatus: 'RISK_DETECTED' },
      ],
    },
  };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 2 / 3);
});

test('computeRiskStatusMatch returns 0 for a question missing from the real report entirely', () => {
  const expectedQa = [{ predefinedQuestionId: 1, expectedRiskStatus: 'RISK_DETECTED' }];
  const output = { report: { questions: [] } };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: FAIL — `Cannot find module './qa-match-assertion'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/qa-match-assertion.js`:

```js
'use strict';

function computeRiskStatusMatch(output, expectedQa) {
  const actualQuestions = output.report.questions;
  const matched = expectedQa.filter((q) => {
    const actual = actualQuestions.find((r) => r.predefinedQuestionId === q.predefinedQuestionId);
    return actual && actual.riskStatus === q.expectedRiskStatus;
  }).length;
  return matched / expectedQa.length;
}

module.exports.computeRiskStatusMatch = computeRiskStatusMatch;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/qa-match-assertion.js scripts/qa-match-assertion.test.js
git commit -m "feat: extract riskStatusMatch into scripts/qa-match-assertion.js"
```

---

### Task 2: `buildAnswerContentRubric` — the rubric prompt builder

**Files:**
- Modify: `scripts/qa-match-assertion.js`
- Test: `scripts/qa-match-assertion.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 directly (independent pure function), but lives in the same file.
- Produces: `buildAnswerContentRubric(expectedQa, actualQuestions)` — `expectedQa` same shape as Task 1; `actualQuestions` is `output.report.questions` (array of `{ predefinedQuestionId, answer, ... }`). Returns a single string: the rubric prompt to hand to `matchesLlmRubric`.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/qa-match-assertion.test.js`:

```js
const { buildAnswerContentRubric } = require('./qa-match-assertion');

test('buildAnswerContentRubric embeds every expected question, its expected answer, and the matching actual answer', () => {
  const expectedQa = [
    { predefinedQuestionId: 1, question: 'Is there fraud?', expectedAnswerSummary: 'Yes, per doc X.' },
  ];
  const actualQuestions = [{ predefinedQuestionId: 1, answer: 'Yes, doc X confirms it.' }];

  const rubric = buildAnswerContentRubric(expectedQa, actualQuestions);

  assert.match(rubric, /Is there fraud\?/);
  assert.match(rubric, /Yes, per doc X\./);
  assert.match(rubric, /Yes, doc X confirms it\./);
  assert.match(rubric, /fraction of pairs that match/);
});

test('buildAnswerContentRubric marks a question missing from the actual report as no answer provided', () => {
  const expectedQa = [
    { predefinedQuestionId: 99, question: 'Missing question?', expectedAnswerSummary: 'Some expected answer.' },
  ];
  const actualQuestions = [];

  const rubric = buildAnswerContentRubric(expectedQa, actualQuestions);

  assert.match(rubric, /NO ANSWER PROVIDED/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: FAIL — `buildAnswerContentRubric is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/qa-match-assertion.js` (above the `module.exports` lines):

```js
function buildAnswerContentRubric(expectedQa, actualQuestions) {
  const pairs = expectedQa.map((q) => {
    const actual = actualQuestions.find((r) => r.predefinedQuestionId === q.predefinedQuestionId);
    const actualAnswer = actual && actual.answer ? actual.answer : 'NO ANSWER PROVIDED';
    return [
      `Question ${q.predefinedQuestionId}: ${q.question}`,
      `Expected answer: ${q.expectedAnswerSummary}`,
      `Model answer: ${actualAnswer}`,
    ].join('\n');
  });

  return [
    "The output above lists report.questions, each with a predefinedQuestionId and an answer.",
    'For each of the following expected question/answer pairs, judge whether the model answer\'s',
    'content and reasoning semantically match the expected answer below (exact wording does not',
    'matter, meaning does). Then return the fraction of pairs that match as a single number',
    'between 0 and 1 — output only that number.',
    '',
    ...pairs,
  ].join('\n');
}
```

Update the exports at the bottom of the file:

```js
module.exports.computeRiskStatusMatch = computeRiskStatusMatch;
module.exports.buildAnswerContentRubric = buildAnswerContentRubric;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/qa-match-assertion.js scripts/qa-match-assertion.test.js
git commit -m "feat: add buildAnswerContentRubric to scripts/qa-match-assertion.js"
```

---

### Task 3: Wire the full assertion — `riskStatusMatch` + `matchesLlmRubric` call + pass/threshold + `namedScores`

**Files:**
- Modify: `scripts/qa-match-assertion.js`
- Test: `scripts/qa-match-assertion.test.js`

**Interfaces:**
- Consumes: `computeRiskStatusMatch` (Task 1), `buildAnswerContentRubric` (Task 2), `promptfoo.matchesLlmRubric(rubric, llmOutput, grading, vars)` — called via `require('promptfoo')` **without destructuring** (see Global Constraints — the test mocks `promptfoo.matchesLlmRubric` in place).
- Produces: `module.exports` — the default export, an `async function qaMatchAssertion(output, context)` returning `{ pass, score, reason, namedScores: { riskStatusMatch, answerContentMatch } }`. This is the function promptfoo will call directly (via `value: file://scripts/qa-match-assertion.js` — confirmed from `promptfoo`'s `loadFromJavaScriptFile`, in `node_modules/promptfoo/dist/src/graders-B_if87De.js:485-490`: since our export has no `:functionName` suffix and is a bare function, promptfoo calls it as `qaMatchAssertion(output, context)` with the **parsed** output object, not a JSON string). `context.vars.expected.qa` is the expected Q&A array; `context.test.options` is passed straight through as `matchesLlmRubric`'s `grading` argument, exactly mirroring how promptfoo's built-in `llm-rubric` type calls it internally for `report_quality` (`node_modules/promptfoo/dist/src/index.js:2481`); `context.test.assert` (if present) is searched for the `qa_match` entry's own `threshold`.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/qa-match-assertion.test.js` (add `const promptfoo = require('promptfoo');` and `const qaMatchAssertion = require('./qa-match-assertion');` near the top, alongside the existing named-export requires):

```js
const promptfoo = require('promptfoo');
const qaMatchAssertion = require('./qa-match-assertion');

function mockMatchesLlmRubric(t, impl) {
  const original = promptfoo.matchesLlmRubric;
  promptfoo.matchesLlmRubric = impl;
  t.after(() => {
    promptfoo.matchesLlmRubric = original;
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

test('qaMatchAssertion combines riskStatusMatch and answerContentMatch into namedScores and an averaged score', async (t) => {
  mockMatchesLlmRubric(t, async () => ({ pass: true, score: 0.75, reason: 'llm reason' }));

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(result.namedScores.riskStatusMatch, 2 / 3);
  assert.equal(result.namedScores.answerContentMatch, 0.75);
  assert.equal(result.score, (2 / 3 + 0.75) / 2);
  assert.equal(result.pass, true); // score > 0, no threshold configured
});

test('qaMatchAssertion passes context.test.options through to matchesLlmRubric as the grading config', async (t) => {
  let capturedGrading;
  mockMatchesLlmRubric(t, async (rubric, llmOutput, grading) => {
    capturedGrading = grading;
    return { pass: true, score: 1, reason: 'ok' };
  });

  await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.deepEqual(capturedGrading, { provider: 'anthropic:messages:claude-sonnet-4-5' });
});

test('qaMatchAssertion fails when score is below an explicit threshold on the qa_match assert entry', async (t) => {
  mockMatchesLlmRubric(t, async () => ({ pass: true, score: 0.1, reason: 'low' }));

  const context = fakeContext({ test: { assert: [{ metric: 'qa_match', threshold: 0.9 }], options: {} } });
  const result = await qaMatchAssertion(fakeOutput(), context);

  // score = (2/3 + 0.1) / 2 ≈ 0.383, below threshold 0.9
  assert.equal(result.pass, false);
});

test('qaMatchAssertion propagates errors from matchesLlmRubric instead of swallowing them', async (t) => {
  mockMatchesLlmRubric(t, async () => {
    throw new Error('grader provider timed out');
  });

  await assert.rejects(() => qaMatchAssertion(fakeOutput(), fakeContext()), /grader provider timed out/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: FAIL — `qaMatchAssertion is not a function` (module currently only exports named helpers, no default export).

- [ ] **Step 3: Write minimal implementation**

Replace the bottom of `scripts/qa-match-assertion.js` (the `module.exports.*` lines) with:

```js
async function qaMatchAssertion(output, context) {
  const expectedQa = context.vars.expected.qa;
  const actualQuestions = output.report.questions;

  const riskStatusMatch = computeRiskStatusMatch(output, expectedQa);

  const rubric = buildAnswerContentRubric(expectedQa, actualQuestions);
  const llmOutput = JSON.stringify(actualQuestions);
  const grading = context.test && context.test.options;
  const rubricResult = await promptfoo.matchesLlmRubric(rubric, llmOutput, grading, context.vars);
  const answerContentMatch = rubricResult.score;

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
  };
}

module.exports = qaMatchAssertion;
module.exports.computeRiskStatusMatch = computeRiskStatusMatch;
module.exports.buildAnswerContentRubric = buildAnswerContentRubric;
```

Add the require at the top of `scripts/qa-match-assertion.js` (below `'use strict';`):

```js
const promptfoo = require('promptfoo');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: PASS (8 tests total: 2 from Task 1, 2 from Task 2, 4 from this task)

- [ ] **Step 5: Commit**

```bash
git add scripts/qa-match-assertion.js scripts/qa-match-assertion.test.js
git commit -m "feat: assemble qaMatchAssertion combining riskStatusMatch and answerContentMatch"
```

---

### Task 4: Wire `promptfooconfig.yaml` to the new module; update `config-shape.test.js`

**Files:**
- Modify: `promptfooconfig.yaml`
- Modify: `config-shape.test.js`
- Modify: `package.json` (add the new test file to the `test` script)

**Interfaces:**
- Consumes: `scripts/qa-match-assertion.js`'s default export (Task 3) — referenced by promptfoo via `value: file://scripts/qa-match-assertion.js`.

- [ ] **Step 1: Update `promptfooconfig.yaml`**

In `promptfooconfig.yaml`, replace the `qa_match` assertion block:

```yaml
    - type: javascript
      metric: qa_match
      value: |-
        const matched = context.vars.expected.qa.filter((q) => {
          const actual = output.report.questions.find((r) => r.predefinedQuestionId === q.predefinedQuestionId);
          return actual && actual.riskStatus === q.expectedRiskStatus;
        }).length;
        return matched / context.vars.expected.qa.length;
```

with:

```yaml
    - type: javascript
      metric: qa_match
      value: file://scripts/qa-match-assertion.js
```

- [ ] **Step 2: Update `config-shape.test.js`**

Delete these two tests entirely (currently at lines 101–133):
- `'qa_match assertion, executed the way promptfoo runs it, computes the fraction of matching risk determinations'`
- `'qa_match assertion returns 0 for a question missing from the real report entirely'`

(That coverage now lives in `scripts/qa-match-assertion.test.js`, testing the real module directly instead of reconstructing it from a YAML string.)

In the remaining `'config declares exactly two assertions: qa_match, report_quality'` test, change:

```js
  const qaMatch = asserts.find((a) => a.metric === 'qa_match');
  assert.equal(qaMatch.type, 'javascript');
```

to:

```js
  const qaMatch = asserts.find((a) => a.metric === 'qa_match');
  assert.equal(qaMatch.type, 'javascript');
  assert.equal(qaMatch.value, 'file://scripts/qa-match-assertion.js');
```

- [ ] **Step 3: Add the new test file to `package.json`'s `test` script**

In `package.json`, change:

```json
    "test": "node --test provider.test.js config-shape.test.js scripts/score-dashboard.test.js fraudx-client.test.js scripts/generate-tests-vars.test.js",
```

to:

```json
    "test": "node --test provider.test.js config-shape.test.js scripts/score-dashboard.test.js scripts/qa-match-assertion.test.js fraudx-client.test.js scripts/generate-tests-vars.test.js",
```

- [ ] **Step 4: Run the full test suite to verify it passes**

Run: `npm test`
Expected: PASS — all suites green, including `config-shape.test.js` (now 5 tests instead of 7) and `scripts/qa-match-assertion.test.js` (8 tests).

- [ ] **Step 5: Commit**

```bash
git add promptfooconfig.yaml config-shape.test.js package.json
git commit -m "feat: wire qa_match assertion to scripts/qa-match-assertion.js"
```

---

### Task 5: Update `score-dashboard.js`'s `acc` formula to equal thirds

**Files:**
- Modify: `scripts/score-dashboard.js:28`
- Modify: `scripts/score-dashboard.test.js`
- Modify: `test/fixtures/results.sample.json`

**Interfaces:**
- Consumes: `namedScores.riskStatusMatch`, `namedScores.answerContentMatch`, `namedScores.report_quality` (produced by the `qa_match` and `report_quality` assertions at eval time — Task 3 makes the first two available; `report_quality` already exists).

- [ ] **Step 1: Update the fixture file**

In `test/fixtures/results.sample.json`, replace:

```json
        "gradingResult": {
          "pass": true,
          "score": 1,
          "namedScores": {
            "qa_match": 0.9,
            "report_quality": 0.85
          }
        }
```

with:

```json
        "gradingResult": {
          "pass": true,
          "score": 1,
          "namedScores": {
            "riskStatusMatch": 0.9,
            "answerContentMatch": 0.7,
            "report_quality": 0.85
          }
        }
```

- [ ] **Step 2: Update the failing assertions in `scripts/score-dashboard.test.js`**

In the first test (`'scoreDashboard reads results.json and computes all four dashboard numbers...'`), change:

```js
  // acc = round(50*qa_match + 50*report_quality) = round(50*0.9 + 50*0.85) = round(87.5) = 88
  assert.equal(dashboard.acc, 88);
```

to:

```js
  // acc = round((100/3)*riskStatusMatch + (100/3)*answerContentMatch + (100/3)*report_quality)
  //     = round((100/3)*0.9 + (100/3)*0.7 + (100/3)*0.85) = round(81.666...) = 82
  assert.equal(dashboard.acc, 82);
```

In the second test (`'scoreDashboard reports ingestTime and claimProcTime independently...'`), change:

```js
            gradingResult: {
              pass: true,
              score: 1,
              namedScores: {
                qa_match: 0.9,
                report_quality: 0.85,
              },
            },
```

to:

```js
            gradingResult: {
              pass: true,
              score: 1,
              namedScores: {
                riskStatusMatch: 0.9,
                answerContentMatch: 0.7,
                report_quality: 0.85,
              },
            },
```

(This test only checks `ingestTime`/`claimProcTime`, not `acc` — no assertion changes needed beyond the fixture shape.)

In the third test (`'scoreDashboard scores every claim in results.json independently...'`), change both claims' fixtures and the two `acc` assertions:

```js
            gradingResult: { pass: true, score: 1, namedScores: { qa_match: 0.9, report_quality: 0.85 } },
```
→
```js
            gradingResult: { pass: true, score: 1, namedScores: { riskStatusMatch: 0.9, answerContentMatch: 0.7, report_quality: 0.85 } },
```

```js
            gradingResult: { pass: true, score: 1, namedScores: { qa_match: 0.4, report_quality: 0.5 } },
```
→
```js
            gradingResult: { pass: true, score: 1, namedScores: { riskStatusMatch: 0.4, answerContentMatch: 0.3, report_quality: 0.5 } },
```

```js
  assert.equal(dashboards[0].acc, 88);
```
→
```js
  assert.equal(dashboards[0].acc, 82);
```

```js
  // acc = round(50*0.4 + 50*0.5) = round(45) = 45
  assert.equal(dashboards[1].acc, 45);
```
→
```js
  // acc = round((100/3)*0.4 + (100/3)*0.3 + (100/3)*0.5) = round(40.0) = 40
  assert.equal(dashboards[1].acc, 40);
```

In the fifth test (`'scoreDashboard reports a claim with a NaN accuracy score...'`), change:

```js
            gradingResult: {
              pass: false,
              score: 0,
              namedScores: {
                qa_match: 0.9,
                // report_quality is missing
              },
            },
```

to:

```js
            gradingResult: {
              pass: false,
              score: 0,
              namedScores: {
                riskStatusMatch: 0.9,
                answerContentMatch: 0.8,
                // report_quality is missing
              },
            },
```

In the sixth test (`'scoreDashboard scores a healthy claim even when another claim in the same file errored'`), change:

```js
            gradingResult: { pass: true, score: 1, namedScores: { qa_match: 0.4, report_quality: 0.5 } },
```
→
```js
            gradingResult: { pass: true, score: 1, namedScores: { riskStatusMatch: 0.4, answerContentMatch: 0.3, report_quality: 0.5 } },
```

```js
  assert.equal(dashboards[1].acc, 45);
```
→
```js
  assert.equal(dashboards[1].acc, 40);
```

The fourth test (`'scoreDashboard throws a clear error when results.json has no results'`) and seventh test (`'scoreDashboard reports the bucketId of a claim whose provider call succeeded but grading errored'`) need no changes — neither references `namedScores` or `acc`.

- [ ] **Step 3: Run the dashboard test suite to verify it still fails (fixtures updated, formula not yet)**

Run: `node --test scripts/score-dashboard.test.js`
Expected: FAIL — `dashboard.acc` computed under the old 50/50 formula won't match the new expected values (e.g. `NaN` for the first test, since `namedScores.qa_match` no longer exists — `Math.round(50 * undefined + 50 * 0.85)` is `NaN`, not `82`).

- [ ] **Step 4: Update the formula in `scripts/score-dashboard.js`**

In `scripts/score-dashboard.js`, replace:

```js
    const acc = Math.round(50 * namedScores.qa_match + 50 * namedScores.report_quality);
```

with:

```js
    const acc = Math.round(
      (100 / 3) * namedScores.riskStatusMatch +
      (100 / 3) * namedScores.answerContentMatch +
      (100 / 3) * namedScores.report_quality
    );
```

- [ ] **Step 5: Run the dashboard test suite to verify it passes**

Run: `node --test scripts/score-dashboard.test.js`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add scripts/score-dashboard.js scripts/score-dashboard.test.js test/fixtures/results.sample.json
git commit -m "feat: score acc as equal thirds of riskStatusMatch, answerContentMatch, report_quality"
```

---

### Task 6: Full test suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — every suite green: `provider.test.js`, `config-shape.test.js`, `scripts/score-dashboard.test.js`, `scripts/qa-match-assertion.test.js`, `fraudx-client.test.js`, `scripts/generate-tests-vars.test.js`.

- [ ] **Step 2: Confirm no stray references to the old inline `qa_match` value remain**

Run: `grep -rn "context.vars.expected.qa.filter" .` (excluding `node_modules`)
Expected: no matches — that logic now only exists as `computeRiskStatusMatch` in `scripts/qa-match-assertion.js`.

No commit for this task — it's verification of Tasks 1–5, which are already committed.
