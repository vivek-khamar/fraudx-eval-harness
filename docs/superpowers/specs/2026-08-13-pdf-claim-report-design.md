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
3. **Overall summary** — `report_quality`'s `reason` text (the "overall LLM summary") alongside
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
  substrings appear — the `bucketId`, a question's text, a `report_quality` reason fragment.
  Also covers: a claim with no `bucketId` produces no file; the output path matches
  `reports/<bucketId>/report-<timestamp>.pdf` with the timestamp taken from
  `results.timestamp`, not wall-clock time.

## Out of scope

- `riskStatusMatch`'s computation, `report_quality`'s mechanism, and the console JSON dashboard
  are all unchanged.
- No PDF (or any output) for claims that errored before producing a report.
- No consolidated multi-claim PDF — one PDF per scoreable claim, matching the per-`bucketId`
  folder structure.
