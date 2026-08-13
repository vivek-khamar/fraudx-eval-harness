# Per-claim PDF report

## Problem

`npm run score` prints a JSON dashboard (`bucketId`, `ingestionTime`, `processingTime`,
`accuracy`) to the console. That's enough to see the number, but not enough to see *why* a
claim scored the way it did — the underlying per-question answers, which ones matched their
gold answer and which didn't, or `report_quality`'s own reasoning about the summary. Right now
that detail only exists buried in `results.json`.

## Decision: additive, not a replacement

The PDF is written to disk as a new artifact. The console JSON dashboard from
`scripts/score-dashboard.js` is untouched — nothing that currently reads/parses that output
breaks.

## Decision: per-question grading moves from 1 batched call to 35 individual calls

Today, `scripts/qa-match-assertion.js`'s `buildAnswerContentRubric` builds one rubric
covering all of a claim's predefined questions, graded in a single
`promptfoo.assertions.matchesLlmRubric` call that returns one aggregate fraction
(`answerContentMatch`). No per-question score or reasoning exists anywhere today — only the
aggregate.

That was the right call when only the aggregate mattered (see the design rationale in
`docs/superpowers/specs/2026-08-12-qa-match-answer-content-scoring-design.md`). It stops being
the right call once per-question reasoning becomes a *user-facing deliverable* in the PDF: one
LLM call asked to reason carefully about 35 things at once is more prone to shallow, repetitive,
or inconsistent output than 35 focused calls, each judging one question. The added latency is
modest relative to the run's dominant cost (real document ingestion/processing already takes
~35-40 minutes per claim) — a minute or two of additional sequential grading calls doesn't change
the run's character.

**New mechanism**, replacing the single `matchesLlmRubric` call:

```js
const provider = await promptfoo.loadApiProvider(context.test.options.provider); // loaded once
const verdicts = [];
for (const q of expectedQa) {
  const actualAnswer = findActualAnswer(actualQuestions, q.predefinedQuestionId); // 'NO ANSWER PROVIDED' if missing
  const prompt = buildQuestionGradingPrompt(q, actualAnswer);
  const response = await provider.callApi(prompt);
  if (response.error) throw new Error(response.error);
  const { matches, reason } = parseGraderVerdict(response.output); // strips ```json fences, JSON.parse, validates shape
  verdicts.push({ predefinedQuestionId: q.predefinedQuestionId, question: q.question, actualAnswer, matches, reason });
}
const answerContentMatch = verdicts.filter((v) => v.matches).length / verdicts.length;
```

`promptfoo.loadApiProvider` is a real, public top-level export (confirmed via
`node_modules/promptfoo/dist/src/index.d.ts:24435`:
`declare function loadApiProvider(providerPath: string, context?): Promise<ApiProvider>`, and
empirically: `typeof require('promptfoo').loadApiProvider === 'function'`). `ApiProvider` exposes
`callApi: CallApiFunction` (`index.d.ts:85`). `context.test.options.provider` is the same string
(`GRADER_PROVIDER`, e.g. `"openai:gpt-5.1"`) already passed as `grading` to `matchesLlmRubric`
today — no new config needed.

`buildQuestionGradingPrompt(q, actualAnswer)` returns a self-contained prompt (not a rubric
fragment meant for promptfoo's `<Output>/<Rubric>` template, since we're calling the provider
directly now):

```
Question: {q.question}
Expected answer: {q.expectedAnswerSummary}
Model answer: {actualAnswer}

Does the model answer's content and reasoning semantically match the expected answer above
(exact wording does not matter, meaning does)? Respond with only a JSON object, no other text:
{"matches": boolean, "reason": string}.
```

**Error handling:** no try/catch swallowing. If `provider.callApi` throws, if `response.error`
is set, or if `parseGraderVerdict` can't extract valid JSON, the error propagates immediately —
consistent with this codebase's existing philosophy (see the critical-bug lesson from the
answer-content-scoring work: a swallowed grading failure is worse than a loud one). A failure on
question 12 of 35 does not continue grading 13-35 and produce a partial/inconsistent breakdown;
the whole assertion fails for that claim, exactly like any other assertion error today.

**What doesn't change:** `riskStatusMatch`'s computation (still deterministic, unchanged), the
threshold/`pass` logic (`pass = threshold === undefined ? score > 0 : score >= threshold`,
`score = (riskStatusMatch + answerContentMatch) / 2`), and the non-destructured
`require('promptfoo')` convention (mocking now targets `promptfoo.loadApiProvider` instead of
`promptfoo.assertions.matchesLlmRubric`, same principle).

**Carrying the breakdown through to `results.json`:** `qaMatchAssertion` returns a fifth key
alongside the existing four:

```js
return { pass, score, reason, namedScores: { riskStatusMatch, answerContentMatch }, perQuestionBreakdown: verdicts };
```

promptfoo's `AssertionsResult.addResult` stores the *entire* object an assertion returns into
`componentResults[index]` (`node_modules/promptfoo/dist/src/evaluator-SSlcaq_U.js:1161`:
`this.componentResults[index] = result`), not just the fields it recognizes (`pass`, `score`,
`reason`, `namedScores`). `perQuestionBreakdown` rides along untouched and ends up at
`result.gradingResult.componentResults[i].perQuestionBreakdown` in `results.json`, where
`generate-pdf-report.js` reads it from. **This must be verified empirically** during
implementation (write a throwaway script that runs a mocked/real assertion and inspects the
resulting object shape) before relying on it, the same way the `matchesLlmRubric` real path was
verified empirically rather than assumed, earlier this project.

## New assertion: `metadata_match`

The real report response includes claim-level fields nothing currently checks: `fraudRiskScore`,
`claimantName`, `defendant`, `insuranceFirm` (confirmed present on `output.report` — the same raw
object `report.bucketId`/`report.questions` are already read from today; no changes needed to
`provider.js` or `fraudx-client.js` to expose them).

**Two named sub-scores from one assertion**, following the same pattern established for
`qa_match` (`riskStatusMatch` + `answerContentMatch` from one assertion, not two):

- **`fraudRiskScoreMatch`** — binary (1 or 0): does `|output.report.fraudRiskScore -
  expected.fraudRiskScore| ≤ 0.1`?
- **`entityFieldsMatch`** — fraction matched, out of 3: `claimantName`, `defendant`,
  `insuranceFirm`, each compared case- and whitespace-insensitively (`trim().toLowerCase()`,
  collapse repeated whitespace) — not fuzzy/similarity-based. Real data already shows the same
  entity spelled two ways in one report ("One Team Restoration, Inc." vs "OneTeam Restoration,
  Inc.") — that specific case would still count as a mismatch under this rule; only
  case/whitespace differences are tolerated.

**Mechanism** (`scripts/metadata-match-assertion.js`, deterministic — no LLM call, no
`promptfoo.loadApiProvider` needed):

```js
function normalize(str) {
  return (str || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function metadataMatchAssertion(output, context) {
  const expected = context.vars.expected;
  const report = output.report;

  const fraudRiskScoreMatch = Math.abs(report.fraudRiskScore - expected.fraudRiskScore) <= 0.1 ? 1 : 0;

  const entityFields = [
    [report.claimantName, expected.claimantName],
    [report.defendant, expected.defendant],
    [report.insuranceFirm, expected.insuranceFirm],
  ];
  const entityMatches = entityFields.filter(([actual, exp]) => normalize(actual) === normalize(exp)).length;
  const entityFieldsMatch = entityMatches / entityFields.length;

  const score = (fraudRiskScoreMatch + entityFieldsMatch) / 2;
  // threshold/pass logic identical in shape to qa-match-assertion.js's convention
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
```

**`promptfooconfig.yaml`** gets a third assert entry:

```yaml
    - type: javascript
      metric: metadata_match
      value: file://scripts/metadata-match-assertion.js
```

**New expected fields in `testdata/claims.json`** (top-level per claim, alongside `summary`):
`expectedFraudRiskScore` (number), `expectedClaimantName`, `expectedDefendant`,
`expectedInsuranceFirm` (strings) — need to be filled in for the existing golden claim(s), since
no such reference data exists today.

**`scripts/generate-tests-vars.js`** maps these into `vars.expected` alongside `summarySynopsis`
and `qa`:

```js
expected: {
  summarySynopsis: claim.summary,
  fraudRiskScore: claim.expectedFraudRiskScore,
  claimantName: claim.expectedClaimantName,
  defendant: claim.expectedDefendant,
  insuranceFirm: claim.expectedInsuranceFirm,
  qa: claim.questions.map(...), // unchanged
},
```

**Accuracy formula changes from equal thirds to equal fifths** — `scripts/score-dashboard.js`:

```js
const accuracy = Math.round(
  20 * namedScores.riskStatusMatch +
  20 * namedScores.answerContentMatch +
  20 * namedScores.report_quality +
  20 * namedScores.fraudRiskScoreMatch +
  20 * namedScores.entityFieldsMatch
);
```

All five signals weighted identically — the two new metadata scores don't get a smaller share
just because there are now more of them.

## New script: `scripts/generate-pdf-report.js`

A new, focused module — matching the existing pattern of `scripts/generate-tests-vars.js` /
`scripts/score-dashboard.js`: one job, its own sibling test file.

**Input:** `results.json` (same file `score-dashboard.js` reads).

**Per claim in `results.json`:**
- If the claim has no `bucketId` (`result.response?.output?.report?.bucketId` is undefined —
  it errored before a report ever existed, e.g. the recurring `INGESTION model is not found`
  case), **skip it entirely**. No PDF, no placeholder, nothing written for that claim.
- Otherwise, write one PDF to `reports/<bucketId>/report-<timestamp>.pdf` (path relative to the
  project root, alongside `results.json`), where `<timestamp>`
  is `results.json`'s own top-level `results.timestamp` field (the eval run's timestamp, e.g.
  `"2026-08-13T05:52:47.729Z"`), formatted filesystem-safe by replacing `:` with `-` and
  dropping milliseconds: `2026-08-13T05-52-47.pdf`. Using the eval run's own timestamp (not
  "now, when the PDF script happens to run") means regenerating the PDF later from the same
  `results.json` reproduces the same filename rather than accumulating duplicates, while still
  distinguishing genuinely different eval runs against the same claim (each of which creates a
  fresh `bucketId` anyway, so the folder is already effectively run-unique — the timestamp adds
  a human-readable label when browsing, not disambiguation).
- Uses `pdfkit` (new `dependencies` entry in `package.json` — it's used at runtime by this
  script, not just in tests).
- `reports/` is generated output, like `results.json` — add it to `.gitignore` (currently:
  `node_modules/`, `.env`, `results.json`, `*.log`, `tests.vars.yaml`).

**PDF content, per claim:**

1. **Header** — `bucketId`, `ingestionTime`, `processingTime`, `accuracy`, and a "generated at"
   line showing the eval run's timestamp.
2. **Question-by-question table** — one compact row per entry in `perQuestionBreakdown`:
   *Question | Answer | Match (✓/✗) | Reason*. Text-wrapped within cells; spans multiple pages
   as needed for 35 rows × 4 columns of text. Row height is computed from wrapped text height
   per cell (pdfkit has no built-in flowing table — this is manual layout code, an
   implementation-level detail, not a design decision).
3. **Claim metadata table** — one row per metadata field (`fraudRiskScore`, `claimantName`,
   `defendant`, `insuranceFirm`): *Field | Expected | Actual | Match (✓/✗)*, sourced from
   `output.report` and `context.vars.expected` the same way `metadata_match` computes them (not
   re-derived independently — same tolerance/normalization rules).
4. **Overall summary** — `report_quality`'s `reason` text (the "overall LLM summary") alongside
   its own `score` and the claim's final `accuracy`, restated for context.

## Wiring into npm scripts

```json
"score": "node scripts/score-dashboard.js && node scripts/generate-pdf-report.js",
```

`&&` (not `;`) is correct here, unlike the `eval:raw`/`score` chain fixed earlier: if
`scoreDashboard()` itself throws (e.g. "No results found in results.json" — a structural
problem, not a per-claim assertion failure), there is genuinely nothing for the PDF generator to
read, so skipping it is right. `npm run eval` already chains to `npm run score`
(`"eval:raw; code=$?; npm run score; exit $code"`), so the PDF is produced automatically on every
`npm run eval`, with no change needed to that line.

## Testing

- **`scripts/qa-match-assertion.test.js`** — the 4 existing `qaMatchAssertion` tests are rewritten
  to mock `promptfoo.loadApiProvider` (returning a fake `{ callApi }` provider object) instead of
  `promptfoo.assertions.matchesLlmRubric`, with canned per-question JSON responses. New tests
  cover: `answerContentMatch` computed correctly as the fraction of `matches: true` verdicts
  across multiple calls; `perQuestionBreakdown` contains one entry per question with
  `predefinedQuestionId`/`question`/`actualAnswer`/`matches`/`reason`; a missing actual answer is
  graded as `'NO ANSWER PROVIDED'`; an error from any single per-question call propagates
  immediately without grading the remaining questions.
- **`scripts/generate-pdf-report.test.js`** (new) — generates a PDF from a synthetic
  `results.json` fixture (mirroring `test/fixtures/results.sample.json`'s pattern, extended with
  a `perQuestionBreakdown`), then re-parses the written PDF with `pdf-parse` (already a
  dependency, used elsewhere in this repo for extracting PDF text) to assert specific expected
  substrings appear — the `bucketId`, a question's text, a `report_quality` reason fragment, and
  the claim metadata table's fields. Also covers: a claim with no `bucketId` produces no file;
  the output path matches `reports/<bucketId>/report-<timestamp>.pdf` with the timestamp taken
  from `results.timestamp`, not wall-clock time.
- **`scripts/metadata-match-assertion.test.js`** (new) — covers: `fraudRiskScoreMatch` is 1
  within the ±0.1 tolerance and 0 outside it (including boundary cases at exactly 0.1);
  `entityFieldsMatch` counts case/whitespace-insensitive matches correctly (0/3, 1/3, 2/3, 3/3);
  the same entity spelled two genuinely different ways (e.g. "One Team" vs "OneTeam") counts as a
  mismatch, confirming normalization does *not* extend to fuzzy matching; the threshold/`pass`
  logic (no threshold → `score > 0`; threshold set → `score >= threshold`), same shape as
  `qa-match-assertion.test.js`'s coverage.

## Out of scope

- `riskStatusMatch`'s computation and `report_quality`'s mechanism are both unchanged.
  `scripts/score-dashboard.js`'s console JSON *format* is unchanged (still a dashboard array),
  but its `accuracy` formula changes (equal thirds → equal fifths, see `metadata_match` above).
- No PDF (or any output) for claims that errored before producing a report.
- No consolidated multi-claim PDF — one PDF per scoreable claim, matching the per-`bucketId`
  folder structure.
- Fuzzy/similarity-based entity matching — explicitly rejected in favor of
  case/whitespace-insensitive exact match, despite real data showing genuine spelling variation
  that this choice will miss.
