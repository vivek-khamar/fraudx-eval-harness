# Citation-Correctness Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-question `citationMatch` check to the `qa_match` assertion that verifies the real report cited the correct source document(s) for each answer, not just that the answer text and risk status were right.

**Architecture:** A new shared helper (`scripts/extract-cited-file-names.js`) extracts `fileName`s from `<InTextCitation>` tags in a single answer's raw text; `provider.js`'s existing extractor is refactored to reuse it. `qa-match-assertion.js` uses the same helper per-question to compute `citationMatches` against an optional `expectedCitedFileNames` array authored per question in `testdata/claims.json`, folding the result into a new `citationMatch` named score. `score-dashboard.js`'s `computeAccuracy` and `generate-pdf-report.js`'s per-question rendering both pick this new score up.

**Tech Stack:** Node.js built-in `node:test`/`node:assert/strict`, existing `pdf-parse`/`pdfkit`/`js-yaml` already used by this repo. No new dependencies.

## Global Constraints

- `documentId` on a citation tag is per-ingestion and MUST NOT be used as a stable identifier — only `fileName` is stable across re-ingestion runs (see spec background). Every task below extracts/compares `fileName` only.
- Citation matching is **"at least one expected fileName cited"** — not exact-set, not all-of. A question with `expectedCitedFileNames: ['a.pdf', 'b.pdf']` passes if the actual answer cites `a.pdf`, `b.pdf`, or both; citing additional files beyond the expected set never counts against it.
- `expectedCitedFileNames` is **optional per question**. A question without it must never appear in the `citationMatch` fraction's denominator (it is excluded, not scored as failing).
- When **zero** questions in a claim have `expectedCitedFileNames` set, `citationMatch` must be `undefined` — not `0`, not `NaN` — for that claim, and `computeAccuracy` must fall back to the pre-existing 5-signal equal-fifths formula for that claim.
- When `citationMatch` is a number, `computeAccuracy` uses an equal 6-way split (`100/6` per signal) instead of equal fifths. `acc` numbers computed under the 6-signal formula are not directly comparable to `acc` numbers computed under the 5-signal formula — document this, don't try to normalize it in code.
- `provider.test.js`'s two existing `extractCitedFileNames` tests, and every other currently-passing test, must still pass unchanged after the `provider.js` refactor in Task 2 — it is a pure internal refactor with no behavior change.

---

### Task 1: Shared citation-extraction helper

**Files:**
- Create: `scripts/extract-cited-file-names.js`
- Test: `scripts/extract-cited-file-names.test.js`

**Interfaces:**
- Produces: `extractCitedFileNamesFromText(text: string | null | undefined): string[]` — regex-extracts `fileName="..."` from every `<InTextCitation ...>` tag in `text`, `decodeURIComponent`s each, dedupes, returns in order of first appearance. Returns `[]` for falsy input. This is the function Tasks 2 and 3 both import.

- [ ] **Step 1: Write the failing tests**

Create `scripts/extract-cited-file-names.test.js`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCitedFileNamesFromText } = require('./extract-cited-file-names');

test('extractCitedFileNamesFromText returns the decoded fileName from a single citation tag', () => {
  const text = 'see <InTextCitation fileName="JOSE%2BBRIONES.pdf" documentId="abc-123"></InTextCitation>';
  assert.deepEqual(extractCitedFileNamesFromText(text), ['JOSE+BRIONES.pdf']);
});

test('extractCitedFileNamesFromText dedupes repeated citations of the same file, keeping first-appearance order', () => {
  const text = [
    '<InTextCitation fileName="b.pdf" documentId="1"></InTextCitation>',
    '<InTextCitation fileName="a.pdf" documentId="2"></InTextCitation>',
    '<InTextCitation fileName="b.pdf" documentId="3"></InTextCitation>',
  ].join(' ');
  assert.deepEqual(extractCitedFileNamesFromText(text), ['b.pdf', 'a.pdf']);
});

test('extractCitedFileNamesFromText returns an empty array when there are no citation tags', () => {
  assert.deepEqual(extractCitedFileNamesFromText('No sources found to answer this query!'), []);
});

test('extractCitedFileNamesFromText returns an empty array for null, undefined, or empty-string input', () => {
  assert.deepEqual(extractCitedFileNamesFromText(null), []);
  assert.deepEqual(extractCitedFileNamesFromText(undefined), []);
  assert.deepEqual(extractCitedFileNamesFromText(''), []);
});

test('extractCitedFileNamesFromText ignores documentId and every other tag attribute, extracting only fileName', () => {
  const text = '<InTextCitation url="https://x" chunkId="c1" fileName="report.pdf" fileType="pdf" documentId="doc-guid-1" sourceIndex="1" occurrenceIndex="1"></InTextCitation>';
  assert.deepEqual(extractCitedFileNamesFromText(text), ['report.pdf']);
});

test('extractCitedFileNamesFromText is reusable across multiple calls without leaking regex state', () => {
  // Guards against a module-level `g`-flag RegExp whose lastIndex isn't reset between calls,
  // which would silently make every other call return [] regardless of its own input.
  const first = extractCitedFileNamesFromText('<InTextCitation fileName="one.pdf"></InTextCitation>');
  const second = extractCitedFileNamesFromText('no citations here');
  const third = extractCitedFileNamesFromText('<InTextCitation fileName="two.pdf"></InTextCitation>');
  assert.deepEqual(first, ['one.pdf']);
  assert.deepEqual(second, []);
  assert.deepEqual(third, ['two.pdf']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/extract-cited-file-names.test.js`
Expected: FAIL — `Cannot find module './extract-cited-file-names'`

- [ ] **Step 3: Write the implementation**

Create `scripts/extract-cited-file-names.js`:

```javascript
'use strict';

const TAG_REGEX = /<InTextCitation\b([^>]*)>/g;
const FILE_NAME_ATTR_REGEX = /fileName="([^"]*)"/;

// Extracts every fileName= attribute from <InTextCitation ...> tags in a single
// answer's raw text, decodeURIComponent-ing each (the real report URL-encodes
// fileName, e.g. "JOSE%2BBRIONES...pdf" -> "JOSE+BRIONES...pdf"), deduplicated
// in order of first appearance. documentId (also present on the tag) is
// intentionally NOT extracted here — it's assigned per-ingestion and differs
// on every eval run, so it can't be used as a stable identifier the way
// fileName can (see docs/superpowers/specs/2026-08-14-citation-match-design.md).
function extractCitedFileNamesFromText(text) {
  if (!text) {
    return [];
  }
  const fileNames = [];
  const seen = new Set();
  TAG_REGEX.lastIndex = 0;
  let match;
  while ((match = TAG_REGEX.exec(text)) !== null) {
    const fileNameMatch = FILE_NAME_ATTR_REGEX.exec(match[1]);
    if (fileNameMatch) {
      const fileName = decodeURIComponent(fileNameMatch[1]);
      if (!seen.has(fileName)) {
        seen.add(fileName);
        fileNames.push(fileName);
      }
    }
  }
  return fileNames;
}

module.exports = { extractCitedFileNamesFromText };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/extract-cited-file-names.test.js`
Expected: PASS — 6/6 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/extract-cited-file-names.js scripts/extract-cited-file-names.test.js
git commit -m "feat: add shared extractCitedFileNamesFromText helper"
```

---

### Task 2: Refactor `provider.js` to use the shared helper

**Files:**
- Modify: `provider.js:1-20` (the `extractCitedFileNames` function and its `require`s)
- Test: `provider.test.js` (no new tests — this is a pure refactor; existing tests must still pass unchanged)

**Interfaces:**
- Consumes: `extractCitedFileNamesFromText` from Task 1 (`./scripts/extract-cited-file-names`).
- Produces: `provider.js`'s exported `extractCitedFileNames(report)` keeps its exact existing signature and behavior — Task 3 does not depend on this function directly (it uses `extractCitedFileNamesFromText` itself), so this task only matters for not regressing `provider.js`.

- [ ] **Step 1: Confirm the current behavior with a passing baseline**

Run: `node --test provider.test.js`
Expected: PASS — all existing tests pass, including:
- `extractCitedFileNames collects unique, decoded fileNames from every answer's citations`
- `extractCitedFileNames returns an empty array when no answers have citations`

- [ ] **Step 2: Refactor `extractCitedFileNames` to delegate to the shared helper**

In `provider.js`, replace:

```javascript
'use strict';

const fraudxClient = require('./fraudx-client');

const DOCUMENT_TEXT_CHAR_LIMIT = 15000;

function extractCitedFileNames(report) {
  const fileNames = new Set();
  const tagRegex = /<InTextCitation\b([^>]*)>/g;
  for (const q of report.questions) {
    let match;
    while ((match = tagRegex.exec(q.answer)) !== null) {
      const fileNameMatch = /fileName="([^"]*)"/.exec(match[1]);
      if (fileNameMatch) {
        fileNames.add(decodeURIComponent(fileNameMatch[1]));
      }
    }
  }
  return [...fileNames];
}
```

with:

```javascript
'use strict';

const fraudxClient = require('./fraudx-client');
const { extractCitedFileNamesFromText } = require('./scripts/extract-cited-file-names');

const DOCUMENT_TEXT_CHAR_LIMIT = 15000;

function extractCitedFileNames(report) {
  const fileNames = [];
  const seen = new Set();
  for (const q of report.questions) {
    for (const fileName of extractCitedFileNamesFromText(q.answer)) {
      if (!seen.has(fileName)) {
        seen.add(fileName);
        fileNames.push(fileName);
      }
    }
  }
  return fileNames;
}
```

Nothing else in `provider.js` changes — the rest of the file (from `class FraudXClaimProvider` onward) is untouched.

- [ ] **Step 3: Run the tests to verify no regression**

Run: `node --test provider.test.js`
Expected: PASS — same tests as Step 1, unchanged, still passing (in particular the two `extractCitedFileNames` tests and `callApi fetches text only for documents actually cited in the real report, truncated to 15000 chars`, which exercises this function indirectly through `callApi`).

- [ ] **Step 4: Commit**

```bash
git add provider.js
git commit -m "refactor: delegate provider.js's extractCitedFileNames to the shared helper"
```

---

### Task 3: `citationMatch` in `qa-match-assertion.js`

**Files:**
- Modify: `scripts/qa-match-assertion.js` (whole file, currently 82 lines)
- Modify: `scripts/qa-match-assertion.test.js:116-130` (the existing exact-shape `perQuestionBreakdown` test needs its expected object updated for the two new fields) plus new tests appended

**Interfaces:**
- Consumes: `extractCitedFileNamesFromText` from Task 1. Reads an optional `q.expectedCitedFileNames: string[]` off each entry of `context.vars.expected.qa` (already flows from `testdata/claims.json` once Task 5 wires it up — for this task, tests set it directly on the fake context, independent of Task 5's ordering).
- Produces: `namedScores.citationMatch: number | undefined`. `perQuestionBreakdown` entries gain `actualCitedFileNames: string[]`, `expectedCitedFileNames: string[] | undefined`, `citationMatches: boolean | undefined`. Task 6 (PDF) consumes exactly these three new field names.

- [ ] **Step 1: Update the existing exact-shape test and add new failing tests**

In `scripts/qa-match-assertion.test.js`, replace the existing test:

```javascript
test('qaMatchAssertion returns one perQuestionBreakdown entry per question', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'looks right' }) }));

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(result.perQuestionBreakdown.length, 3);
  assert.deepEqual(result.perQuestionBreakdown[0], {
    predefinedQuestionId: 1,
    question: 'Q1?',
    actualAnswer: 'ans1',
    riskStatus: 'RISK_DETECTED',
    matches: true,
    reason: 'looks right',
  });
});
```

with:

```javascript
test('qaMatchAssertion returns one perQuestionBreakdown entry per question', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'looks right' }) }));

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(result.perQuestionBreakdown.length, 3);
  assert.deepEqual(result.perQuestionBreakdown[0], {
    predefinedQuestionId: 1,
    question: 'Q1?',
    actualAnswer: 'ans1',
    riskStatus: 'RISK_DETECTED',
    matches: true,
    reason: 'looks right',
    actualCitedFileNames: [],
    expectedCitedFileNames: undefined,
    citationMatches: undefined,
  });
});
```

(`fakeOutput()`'s answers are plain strings like `'ans1'` with no `<InTextCitation>` tags, so `actualCitedFileNames` is `[]`; `fakeContext()`'s questions have no `expectedCitedFileNames`, so it and `citationMatches` are `undefined`.)

Then append these new tests to the end of the file:

```javascript
function fakeContextWithCitations() {
  return {
    vars: {
      expected: {
        qa: [
          { predefinedQuestionId: 1, question: 'Q1?', expectedAnswerSummary: 'A1', expectedRiskStatus: 'RISK_DETECTED', expectedCitedFileNames: ['a.pdf', 'b.pdf'] },
          { predefinedQuestionId: 2, question: 'Q2?', expectedAnswerSummary: 'A2', expectedRiskStatus: 'UNSURE', expectedCitedFileNames: ['c.pdf'] },
          { predefinedQuestionId: 3, question: 'Q3?', expectedAnswerSummary: 'A3', expectedRiskStatus: 'RISK_DETECTED' }, // no expectedCitedFileNames — not graded for citations
        ],
      },
    },
    test: { assert: [{ metric: 'qa_match' }], options: { provider: 'anthropic:messages:claude-sonnet-4-5' } },
  };
}

function fakeOutputWithCitations() {
  return {
    report: {
      questions: [
        { predefinedQuestionId: 1, riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="b.pdf"></InTextCitation>' }, // cites b.pdf — one of the two expected — matches
        { predefinedQuestionId: 2, riskStatus: 'UNSURE', answer: 'see <InTextCitation fileName="wrong.pdf"></InTextCitation>' }, // expected c.pdf, cited wrong.pdf — no match
        { predefinedQuestionId: 3, riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="anything.pdf"></InTextCitation>' }, // no expectedCitedFileNames — excluded
      ],
    },
  };
}

test('qaMatchAssertion computes citationMatch as the fraction of graded questions citing at least one expected fileName', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const result = await qaMatchAssertion(fakeOutputWithCitations(), fakeContextWithCitations());

  // question 1: matched; question 2: not matched; question 3: excluded (ungraded) -> 1/2 graded.
  assert.equal(result.namedScores.citationMatch, 0.5);
  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
  assert.equal(result.perQuestionBreakdown[1].citationMatches, false);
  assert.equal(result.perQuestionBreakdown[2].citationMatches, undefined);
  assert.deepEqual(result.perQuestionBreakdown[0].actualCitedFileNames, ['b.pdf']);
});

test('qaMatchAssertion treats citing any one of several expectedCitedFileNames as a match, not requiring all of them', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  // question 1's expectedCitedFileNames is ['a.pdf', 'b.pdf'] but the actual answer only cites
  // b.pdf — this must still count as a match ("at least one", not "all of them").
  const result = await qaMatchAssertion(fakeOutputWithCitations(), fakeContextWithCitations());

  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
});

test('qaMatchAssertion sets namedScores.citationMatch to undefined when no question has expectedCitedFileNames', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(result.namedScores.citationMatch, undefined);
  assert.ok(result.perQuestionBreakdown.every((v) => v.citationMatches === undefined));
  // falls back to the 2-signal average exactly as before this feature existed
  assert.equal(result.score, (result.namedScores.riskStatusMatch + result.namedScores.answerContentMatch) / 2);
});

test('qaMatchAssertion folds citationMatch into its own score as a 3-way average when at least one question is graded for it', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const result = await qaMatchAssertion(fakeOutputWithCitations(), fakeContextWithCitations());

  const { riskStatusMatch, answerContentMatch, citationMatch } = result.namedScores;
  assert.equal(result.score, (riskStatusMatch + answerContentMatch + citationMatch) / 3);
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: FAIL — the updated exact-shape test fails on missing keys; the four new tests fail with `undefined` where a number/boolean was expected, since `citationMatch`/`citationMatches`/`actualCitedFileNames` don't exist yet.

- [ ] **Step 3: Implement `citationMatch`**

Replace the full contents of `scripts/qa-match-assertion.js` with:

```javascript
'use strict';

const promptfoo = require('promptfoo');
const { extractCitedFileNamesFromText } = require('./extract-cited-file-names');

function computeRiskStatusMatch(output, expectedQa) {
  const actualQuestions = output.report.questions;
  const matched = expectedQa.filter((q) => {
    const actual = actualQuestions.find((r) => r.predefinedQuestionId === q.predefinedQuestionId);
    return actual && actual.riskStatus === q.expectedRiskStatus;
  }).length;
  return matched / expectedQa.length;
}

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
    const riskStatus = actual && actual.riskStatus;

    const actualCitedFileNames = extractCitedFileNamesFromText(actualAnswer);
    const expectedCitedFileNames = q.expectedCitedFileNames;
    const citationMatches = Array.isArray(expectedCitedFileNames) && expectedCitedFileNames.length > 0
      ? actualCitedFileNames.some((f) => expectedCitedFileNames.includes(f))
      : undefined;

    perQuestionBreakdown.push({
      predefinedQuestionId: q.predefinedQuestionId,
      question: q.question,
      actualAnswer,
      riskStatus,
      matches,
      reason,
      actualCitedFileNames,
      expectedCitedFileNames,
      citationMatches,
    });
  }
  const answerContentMatch = perQuestionBreakdown.filter((v) => v.matches).length / perQuestionBreakdown.length;

  const gradedForCitation = perQuestionBreakdown.filter((v) => v.citationMatches !== undefined);
  const citationMatch = gradedForCitation.length > 0
    ? gradedForCitation.filter((v) => v.citationMatches).length / gradedForCitation.length
    : undefined;

  const score = citationMatch === undefined
    ? (riskStatusMatch + answerContentMatch) / 2
    : (riskStatusMatch + answerContentMatch + citationMatch) / 3;

  const qaMatchAssert = context.test && Array.isArray(context.test.assert)
    ? context.test.assert.find((a) => a.metric === 'qa_match')
    : undefined;
  const threshold = qaMatchAssert && qaMatchAssert.threshold;
  const pass = threshold === undefined ? score > 0 : score >= threshold;

  return {
    pass,
    score,
    reason: `riskStatusMatch=${riskStatusMatch}, answerContentMatch=${answerContentMatch}, citationMatch=${citationMatch === undefined ? 'n/a' : citationMatch}`,
    namedScores: { riskStatusMatch, answerContentMatch, citationMatch },
    perQuestionBreakdown,
  };
}

module.exports = qaMatchAssertion;
module.exports.computeRiskStatusMatch = computeRiskStatusMatch;
module.exports.buildQuestionGradingPrompt = buildQuestionGradingPrompt;
module.exports.parseGraderVerdict = parseGraderVerdict;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: PASS — all existing tests plus the 4 new ones (total should be 4 more than the pre-task count).

- [ ] **Step 5: Commit**

```bash
git add scripts/qa-match-assertion.js scripts/qa-match-assertion.test.js
git commit -m "feat: add citationMatch scoring to qa-match-assertion.js"
```

---

### Task 4: `computeAccuracy` 6-way/5-way conditional formula

**Files:**
- Modify: `scripts/score-dashboard.js:8-16`
- Test: `scripts/score-dashboard.test.js:8-30` (add two new tests near the existing `computeAccuracy` tests)

**Interfaces:**
- Consumes: `namedScores.citationMatch: number | undefined` (from Task 3, or absent entirely from any fixture that hasn't been updated — both must work identically).
- Produces: `computeAccuracy(namedScores): number` — unchanged signature, now inspects `citationMatch` to decide 5-way vs. 6-way weighting. `generate-pdf-report.js` already imports and calls `computeAccuracy` (Task 6 needs no changes to that call site).

- [ ] **Step 1: Write the failing tests**

Add these two tests to `scripts/score-dashboard.test.js`, directly after the existing `computeAccuracy rounds a fractional weighted sum to the nearest integer` test (before the `scoreDashboard reads results.json...` test):

```javascript
test('computeAccuracy folds citationMatch in as an equal sixth when it is present', () => {
  const namedScores = {
    riskStatusMatch: 0.9,
    answerContentMatch: 0.7,
    report_quality: 0.85,
    fraudRiskScoreMatch: 1,
    entityFieldsMatch: 1,
    citationMatch: 0.5,
  };
  // sum = 0.9+0.7+0.85+1+1+0.5 = 4.95; (100/6) * 4.95 = 82.5 -> rounds to 83
  assert.equal(computeAccuracy(namedScores), 83);
});

test('computeAccuracy falls back to the five-signal equal-fifths formula when citationMatch is undefined', () => {
  const namedScores = {
    riskStatusMatch: 0.9,
    answerContentMatch: 0.7,
    report_quality: 0.85,
    fraudRiskScoreMatch: 1,
    entityFieldsMatch: 1,
    citationMatch: undefined,
  };
  // Same inputs as the very first computeAccuracy test in this file, minus citationMatch.
  assert.equal(computeAccuracy(namedScores), 89);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/score-dashboard.test.js`
Expected: FAIL — `computeAccuracy folds citationMatch in as an equal sixth...` fails because the current implementation ignores `citationMatch` entirely and returns 89 (the 5-way result) instead of 83.

- [ ] **Step 3: Implement the conditional formula**

In `scripts/score-dashboard.js`, replace:

```javascript
function computeAccuracy(namedScores) {
  return Math.round(
    20 * namedScores.riskStatusMatch +
    20 * namedScores.answerContentMatch +
    20 * namedScores.report_quality +
    20 * namedScores.fraudRiskScoreMatch +
    20 * namedScores.entityFieldsMatch
  );
}
```

with:

```javascript
function computeAccuracy(namedScores) {
  const scores = [
    namedScores.riskStatusMatch,
    namedScores.answerContentMatch,
    namedScores.report_quality,
    namedScores.fraudRiskScoreMatch,
    namedScores.entityFieldsMatch,
  ];
  // citationMatch is optional — a claim with no question graded for citations has no such
  // signal to fold in, so it must not be forced into the weighting (see Global Constraints).
  if (typeof namedScores.citationMatch === 'number') {
    scores.push(namedScores.citationMatch);
  }
  const weight = 100 / scores.length;
  return Math.round(scores.reduce((sum, s) => sum + weight * s, 0));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/score-dashboard.test.js`
Expected: PASS — all existing tests (the 5-way ones are unaffected since `citationMatch` is simply absent from their `namedScores` fixtures, which `typeof undefined === 'number'` correctly treats as "not present") plus the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add scripts/score-dashboard.js scripts/score-dashboard.test.js
git commit -m "feat: fold citationMatch into computeAccuracy as a conditional 6th signal"
```

---

### Task 5: `expectedCitedFileNames` passthrough in `generate-tests-vars.js`

**Files:**
- Modify: `scripts/generate-tests-vars.js:6-22` (the `buildTestsVars` function)
- Modify: `scripts/generate-tests-vars.test.js:36-69` (existing exact-shape test needs the new key added) plus new tests appended

**Interfaces:**
- Consumes: `claim.questions[i].expectedCitedFileNames: string[] | undefined` from `testdata/claims.json`.
- Produces: `qa[i].expectedCitedFileNames` in the object `buildTestsVars` returns — the exact field name Task 3's `qaMatchAssertion` reads off `context.vars.expected.qa[i].expectedCitedFileNames`.

- [ ] **Step 1: Update the existing exact-shape test and add new tests**

In `scripts/generate-tests-vars.test.js`, in the `buildTestsVars maps a flat claim into promptfoo test-case shape` test, change the expected `qa` entry from:

```javascript
          qa: [
            {
              predefinedQuestionId: 1480,
              question: "Are any of the plaintiff's attorneys included in the list of attorneys bad actors?",
              expectedAnswerSummary: 'Yes.',
              expectedRiskStatus: 'RISK_DETECTED',
            },
          ],
```

to:

```javascript
          qa: [
            {
              predefinedQuestionId: 1480,
              question: "Are any of the plaintiff's attorneys included in the list of attorneys bad actors?",
              expectedAnswerSummary: 'Yes.',
              expectedRiskStatus: 'RISK_DETECTED',
              expectedCitedFileNames: undefined,
            },
          ],
```

(`sampleClaim()`'s one question doesn't set `expectedCitedFileNames`, and `buildTestsVars` will now always emit the key — `undefined` when absent — matching how `bucketName`/`ingestionModelId`/`tags` already behave in this same function.)

Then append these two tests to the end of the file:

```javascript
test('buildTestsVars passes expectedCitedFileNames through when a question sets it', () => {
  const claim = sampleClaim({
    questions: [
      {
        id: 1480,
        question: 'Q?',
        expectedAnswer: 'A.',
        expectedRiskStatus: 'RISK_DETECTED',
        expectedCitedFileNames: ['source-doc.pdf'],
      },
    ],
  });
  const result = buildTestsVars([claim]);
  assert.deepEqual(result[0].vars.expected.qa[0].expectedCitedFileNames, ['source-doc.pdf']);
});

test('generateTestsVars omits expectedCitedFileNames from the written YAML when a question does not set it', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-tests-vars-'));
  const claimsPath = path.join(tmpDir, 'claims.json');
  const outputPath = path.join(tmpDir, 'tests.vars.yaml');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  fs.writeFileSync(claimsPath, JSON.stringify([sampleClaim()])); // sampleClaim()'s question has no expectedCitedFileNames
  generateTestsVars(claimsPath, outputPath);

  const written = yaml.load(fs.readFileSync(outputPath, 'utf8'));
  assert.equal('expectedCitedFileNames' in written[0].vars.expected.qa[0], false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/generate-tests-vars.test.js`
Expected: FAIL — the updated exact-shape test fails (extra key in expected vs. actual), and `buildTestsVars passes expectedCitedFileNames through...` fails since the field isn't mapped yet.

- [ ] **Step 3: Implement the passthrough**

In `scripts/generate-tests-vars.js`, inside `buildTestsVars`, replace:

```javascript
        qa: claim.questions.map((q) => ({
          predefinedQuestionId: q.id,
          question: q.question,
          expectedAnswerSummary: q.expectedAnswer,
          expectedRiskStatus: q.expectedRiskStatus,
        })),
```

with:

```javascript
        qa: claim.questions.map((q) => ({
          predefinedQuestionId: q.id,
          question: q.question,
          expectedAnswerSummary: q.expectedAnswer,
          expectedRiskStatus: q.expectedRiskStatus,
          expectedCitedFileNames: q.expectedCitedFileNames,
        })),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/generate-tests-vars.test.js`
Expected: PASS — all existing tests plus the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-tests-vars.js scripts/generate-tests-vars.test.js
git commit -m "feat: pass expectedCitedFileNames through generate-tests-vars.js"
```

---

### Task 6: PDF report Citation Match field

**Files:**
- Modify: `scripts/generate-pdf-report.js` (add a `formatCitationMatch` function, export it, and call it from `renderClaimPdf`)
- Test: `scripts/generate-pdf-report.test.js` (add unit tests for `formatCitationMatch` and an integration test through `generatePdfReports`)

**Interfaces:**
- Consumes: `entry.citationMatches: boolean | undefined`, `entry.expectedCitedFileNames: string[] | undefined`, `entry.actualCitedFileNames: string[] | undefined` — the exact `perQuestionBreakdown` field names Task 3 produces.
- Produces: `formatCitationMatch(entry): string` — exported alongside the file's other formatting helpers (`formatRiskStatus`, `stripRiskStatusPrefix`, etc.) for direct unit testing.

Note: the approved design used "✓/✗" for brevity in conversation, but this implementation uses `'YES'`/`'NO'` to match the PDF's existing `Match: ` field (`entry.matches ? 'YES' : 'NO'`, `scripts/generate-pdf-report.js` current line 189) — consistent styling, and avoids relying on the built-in Helvetica font (pdfkit's default, no custom font embedded) actually having checkmark/cross glyphs.

- [ ] **Step 1: Write the failing tests**

Add these tests to `scripts/generate-pdf-report.test.js`, after the existing `sortByRiskStatus does not mutate the input array` test and before `uniqueFilePath returns the given path unchanged...`:

```javascript
test('formatCitationMatch renders YES for a matching citation', () => {
  assert.equal(formatCitationMatch({ citationMatches: true }), 'YES');
});

test('formatCitationMatch renders NO with expected/actual fileNames for a non-matching citation', () => {
  assert.equal(
    formatCitationMatch({ citationMatches: false, expectedCitedFileNames: ['a.pdf', 'b.pdf'], actualCitedFileNames: ['c.pdf'] }),
    'NO (expected one of: a.pdf, b.pdf; got: c.pdf)'
  );
});

test('formatCitationMatch shows (none) when a non-matching question actually cited nothing', () => {
  assert.equal(
    formatCitationMatch({ citationMatches: false, expectedCitedFileNames: ['a.pdf'], actualCitedFileNames: [] }),
    'NO (expected one of: a.pdf; got: (none))'
  );
});

test('formatCitationMatch renders Not graded when citationMatches is undefined', () => {
  assert.equal(formatCitationMatch({ citationMatches: undefined }), 'Not graded');
});
```

Update the import at the top of the file from:

```javascript
const {
  generatePdfReports,
  formatTimestampForFilename,
  formatLocalTimestamp,
  humanizeFieldName,
  formatRiskStatus,
  stripRiskStatusPrefix,
  sortByRiskStatus,
  uniqueFilePath,
} = require('./generate-pdf-report');
```

to:

```javascript
const {
  generatePdfReports,
  formatTimestampForFilename,
  formatLocalTimestamp,
  humanizeFieldName,
  formatRiskStatus,
  stripRiskStatusPrefix,
  sortByRiskStatus,
  uniqueFilePath,
  formatCitationMatch,
} = require('./generate-pdf-report');
```

Then add one assertion to the existing `generatePdfReports writes a PDF whose text includes the bucketId, question text, entity names, and report_quality reasoning` test — after the line `assert.doesNotMatch(text, /RISK DETECTED: Yes, per doc X\./, ...)`, add:

```javascript
  assert.match(text, /Citation Match: Not graded/);
```

(`sampleResultsFile()`'s one question doesn't set `citationMatches`, so it must render as "Not graded" by default.)

Finally, append this integration test to the end of the file:

```javascript
test('generatePdfReports renders Citation Match as YES, NO (with expected/actual fileNames), and Not graded per question', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const qaMatchComponent = fixture.results.results[0].gradingResult.componentResults.find(
    (c) => c.assertion.metric === 'qa_match'
  );
  qaMatchComponent.perQuestionBreakdown = [
    { predefinedQuestionId: 1, question: 'MATCHED-QUESTION', actualAnswer: 'a', riskStatus: 'RISK_DETECTED', matches: true, reason: 'r', actualCitedFileNames: ['a.pdf'], expectedCitedFileNames: ['a.pdf'], citationMatches: true },
    { predefinedQuestionId: 2, question: 'MISMATCHED-QUESTION', actualAnswer: 'a', riskStatus: 'UNSURE', matches: true, reason: 'r', actualCitedFileNames: ['c.pdf'], expectedCitedFileNames: ['a.pdf', 'b.pdf'], citationMatches: false },
    { predefinedQuestionId: 3, question: 'UNGRADED-QUESTION', actualAnswer: 'a', riskStatus: 'RISK_NOT_DETECTED', matches: true, reason: 'r', actualCitedFileNames: ['z.pdf'], expectedCitedFileNames: undefined, citationMatches: undefined },
  ];
  fs.writeFileSync(resultsPath, JSON.stringify(fixture));
  const reportsDir = path.join(tmpDir, 'reports');

  const [filePath] = await generatePdfReports(resultsPath, reportsDir, FIXED_NOW);

  const parser = new PDFParse({ data: fs.readFileSync(filePath) });
  let text;
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy();
  }

  // Risk-status ordering puts MATCHED (RISK_DETECTED) first, MISMATCHED (UNSURE) second,
  // UNGRADED (RISK_NOT_DETECTED) third — so these markers already appear in this order.
  assert.match(text, /MATCHED-QUESTION[\s\S]*?Citation Match: YES/);
  assert.match(text, /MISMATCHED-QUESTION[\s\S]*?Citation Match: NO \(expected one of: a\.pdf, b\.pdf; got: c\.pdf\)/);
  assert.match(text, /UNGRADED-QUESTION[\s\S]*?Citation Match: Not graded/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/generate-pdf-report.test.js`
Expected: FAIL — `formatCitationMatch is not defined` / not exported, and the "Citation Match" text doesn't appear anywhere in the rendered PDF yet.

- [ ] **Step 3: Implement `formatCitationMatch` and wire it into `renderClaimPdf`**

In `scripts/generate-pdf-report.js`, add this function directly after `formatRiskStatus`:

```javascript
function formatCitationMatch(entry) {
  if (entry.citationMatches === undefined) {
    return 'Not graded';
  }
  if (entry.citationMatches) {
    return 'YES';
  }
  const expected = (entry.expectedCitedFileNames || []).join(', ') || '(none)';
  const actual = (entry.actualCitedFileNames || []).join(', ') || '(none)';
  return `NO (expected one of: ${expected}; got: ${actual})`;
}
```

Then, inside `renderClaimPdf`'s `orderedQuestions.forEach(...)` block, change:

```javascript
    field('Risk Status: ', formatRiskStatus(entry.riskStatus));
    field('Match: ', entry.matches ? 'YES' : 'NO');
```

to:

```javascript
    field('Risk Status: ', formatRiskStatus(entry.riskStatus));
    field('Citation Match: ', formatCitationMatch(entry));
    field('Match: ', entry.matches ? 'YES' : 'NO');
```

Finally, add `formatCitationMatch` to the `module.exports` block at the bottom of the file:

```javascript
module.exports = {
  generatePdfReports,
  formatTimestampForFilename,
  formatLocalTimestamp,
  humanizeFieldName,
  formatRiskStatus,
  stripRiskStatusPrefix,
  sortByRiskStatus,
  uniqueFilePath,
  formatCitationMatch,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/generate-pdf-report.test.js`
Expected: PASS — all existing tests plus the 4 new `formatCitationMatch` unit tests and the new integration test.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-pdf-report.js scripts/generate-pdf-report.test.js
git commit -m "feat: render Citation Match per question in the PDF report"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md` (the `qa_match` bullet around line 25-37, the accuracy-formula bullet around line 50-56, the citations bullet around line 67, and the PDF-report bullet around line 81)

**Interfaces:** None — this task only updates prose to describe what Tasks 1-6 built. No code changes.

- [ ] **Step 1: Update the `qa_match` assertion description**

In `README.md`, replace:

```markdown
  - `qa_match` (`javascript`, `scripts/qa-match-assertion.js`) computes two independent signals
    and reports both as named scores from a single assertion:
    - `riskStatusMatch` (deterministic): the fraction of that claim's predefined questions whose
      `riskStatus` exactly matches the gold `expectedRiskStatus`.
    - `answerContentMatch` (LLM-graded): one rubric call PER QUESTION (not one batched call for
      all of a claim's questions) that judges that question's actual answer text against its gold
      `expectedAnswerSummary` for semantic (not exact-wording) match, and returns the fraction of
      questions that match. The assertion also returns a `perQuestionBreakdown` array — one entry
      per question with its `predefinedQuestionId`, `question`, `actualAnswer`, `matches`
      (boolean), and `reason` (the grader's per-question reasoning) — which is what
      `scripts/generate-pdf-report.js` renders in the question-by-question section of the PDF.
    The assertion's own score is the average of the two; `pass` defaults to `score > 0` unless
    a `threshold` is set on the `qa_match` assert entry in `promptfooconfig.yaml`.
```

with:

```markdown
  - `qa_match` (`javascript`, `scripts/qa-match-assertion.js`) computes up to three independent
    signals and reports them as named scores from a single assertion:
    - `riskStatusMatch` (deterministic): the fraction of that claim's predefined questions whose
      `riskStatus` exactly matches the gold `expectedRiskStatus`.
    - `answerContentMatch` (LLM-graded): one rubric call PER QUESTION (not one batched call for
      all of a claim's questions) that judges that question's actual answer text against its gold
      `expectedAnswerSummary` for semantic (not exact-wording) match, and returns the fraction of
      questions that match.
    - `citationMatch` (deterministic, optional per question): a question in `testdata/claims.json`
      can set an `expectedCitedFileNames` array — the source document `fileName`(s) that support
      its answer. For every question that sets it, `citationMatch` checks whether the real
      answer's `<InTextCitation fileName="...">` tags include **at least one** of the expected
      files (citing additional files beyond that doesn't count against it) — `documentId` on
      those tags is per-ingestion and changes every run, so it's never used for comparison, only
      `fileName` is. Questions that don't set `expectedCitedFileNames` are excluded from this
      fraction. If *no* question in a claim sets it, `citationMatch` is `undefined` for that
      claim (not `0`) and the accuracy formula below falls back to five signals.

    The assertion also returns a `perQuestionBreakdown` array — one entry per question with its
    `predefinedQuestionId`, `question`, `actualAnswer`, `matches` (boolean), `reason` (the
    grader's per-question reasoning), `actualCitedFileNames`, `expectedCitedFileNames`, and
    `citationMatches` (boolean, or `undefined` if that question wasn't graded for citations) —
    which is what `scripts/generate-pdf-report.js` renders in the question-by-question section
    of the PDF.

    The assertion's own score is the average of `riskStatusMatch` and `answerContentMatch`, plus
    `citationMatch` as a third term whenever at least one question in the claim was graded for
    it; `pass` defaults to `score > 0` unless a `threshold` is set on the `qa_match` assert entry
    in `promptfooconfig.yaml`.
```

- [ ] **Step 2: Update the accuracy-formula description**

Replace:

```markdown
  `scripts/score-dashboard.js` (via its exported `computeAccuracy(namedScores)`, also reused by
  `scripts/generate-pdf-report.js` so the two never drift apart) combines all five named scores as
  equal fifths:
  `acc = round(20×riskStatusMatch + 20×answerContentMatch + 20×report_quality + 20×fraudRiskScoreMatch + 20×entityFieldsMatch)`.
  `acc` numbers from before this scoring change (three signals, equal thirds) are not directly
  comparable to `acc` numbers after it (five signals, equal fifths) — the weighting and underlying
  signals both changed.
```

with:

```markdown
  `scripts/score-dashboard.js` (via its exported `computeAccuracy(namedScores)`, also reused by
  `scripts/generate-pdf-report.js` so the two never drift apart) combines the named scores as an
  equal split. When `citationMatch` is a number (at least one question in the claim was graded
  for citations), that's a 6-way split:
  `acc = round((100/6)×(riskStatusMatch + answerContentMatch + report_quality + fraudRiskScoreMatch + entityFieldsMatch + citationMatch))`.
  When `citationMatch` is `undefined` (no question in the claim sets `expectedCitedFileNames`),
  it falls back to the original 5-way equal-fifths formula:
  `acc = round(20×riskStatusMatch + 20×answerContentMatch + 20×report_quality + 20×fraudRiskScoreMatch + 20×entityFieldsMatch)`.
  `acc` numbers computed under one formula are not directly comparable to `acc` numbers computed
  under the other — the weighting and underlying signal count both differ.
```

- [ ] **Step 3: Update the citations bullet and the PDF-report bullet**

Replace:

```markdown
- **Citations are parsed out of free-text answers.** The real report embeds citations as inline `<InTextCitation fileName="...">` tags inside each answer's text, not a structured field — `provider.js`'s `extractCitedFileNames` regex-extracts them (to decide which documents to fetch text for), and `report_quality` checks claims against that fetched text rather than matching on filename alone.
```

with:

```markdown
- **Citations are parsed out of free-text answers.** The real report embeds citations as inline `<InTextCitation fileName="..." documentId="...">` tags inside each answer's text, not a structured field. `scripts/extract-cited-file-names.js`'s `extractCitedFileNamesFromText` is the one place that regex-extracts `fileName` from these tags — `provider.js`'s `extractCitedFileNames` (to decide which documents to fetch text for `citedDocumentsText`) and `qa-match-assertion.js`'s `citationMatch` (per question) both call it. Only `fileName` is ever compared — `documentId` is assigned per-ingestion and differs on every eval run, so it can't identify a document across runs the way `fileName` can.
```

Then, in the PDF-report bullet, replace:

```markdown
  first. Each block has a heading followed by labeled Risk Status, Match, Answer, and Reason
```

with:

```markdown
  first. Each block has a heading followed by labeled Risk Status, Citation Match, Match, Answer,
  and Reason
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: describe citationMatch scoring, expectedCitedFileNames, and the PDF's Citation Match field"
```
