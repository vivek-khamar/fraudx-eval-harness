# qa_match: add answer-content scoring alongside risk-status matching

## Problem

`qa_match` (in `promptfooconfig.yaml`) currently only compares each predefined
question's `riskStatus` enum (`RISK_DETECTED` / `RISK_NOT_DETECTED` / `UNSURE`)
against the golden claim's `expectedRiskStatus`. It never looks at the actual
answer *text* the pipeline produced, even though every golden question already
carries an `expectedAnswer` in `testdata/claims.json` (propagated to
`expected.qa[].expectedAnswerSummary` in `tests.vars.yaml`).

That means two failure modes are currently invisible to scoring:
- A question lands on the right `riskStatus` for the wrong reason (hallucinated
  or miscited justification).
- A question's answer content drifts from the expected reasoning even when the
  enum happens to match.

`report_quality` doesn't cover this either — it grades the claim-level
narrative summary (`report.summary`) against the claim-level
`summarySynopsis`, not individual question answers.

## Decision: extend `qa_match`, don't add a third assertion

`qa_match` becomes two named sub-scores computed in one assertion, not two
separate `assert:` entries:

- `riskStatusMatch` — the existing deterministic enum-match logic, unchanged.
- `answerContentMatch` — new: one LLM-rubric call per claim that grades every
  question's actual answer text against `expectedAnswerSummary` for semantic
  (not exact-wording) match, and returns the fraction that match as a single
  0–1 score.

Rationale for one assertion instead of two:
- Verified in promptfoo's evaluator source (`evaluator-SSlcaq_U.js:1148-1171`)
  that when a `javascript` assertion's result object includes its own
  `namedScores`, those keys are merged directly into the eval's top-level
  `gradingResult.namedScores` — in addition to the assert entry's own
  `metric:` score. So one assertion returning
  `{ score, namedScores: { riskStatusMatch, answerContentMatch } }` naturally
  produces two independently-readable scores. A second `assert:` entry isn't
  needed to get that.
- `riskStatusMatch` (classification correctness) and `answerContentMatch`
  (grounding/reasoning correctness) are different failure modes worth
  diagnosing independently — collapsing them into one number would hide which
  one regressed on a given run. Splitting into two named scores (rather than
  one blended number) preserves that diagnostic value.
- Citations (`expectedCitationFileNames`) are explicitly **out of scope** for
  now — `answerContentMatch` grades answer text only.

Net effect: `namedScores` after this change contains four keys —
`qa_match` (the assertion's own averaged score, a byproduct of how promptfoo
merges named scores — not used by the dashboard), `riskStatusMatch`,
`answerContentMatch`, and `report_quality` (unchanged, from the separate
`report_quality` assertion).

## LLM call budget

`answerContentMatch` grades all questions for a claim (35, in the current
golden claims) in a **single LLM call**, not one call per question. The
rubric prompt embeds every `{question, expectedAnswerSummary, actual answer
text}` triple and asks the grader to return the fraction of questions whose
actual answer content semantically matches the expected answer, as one 0–1
score. A question with no matching actual answer is included in the rubric
as "no answer provided" so the grader can penalize it, rather than being
silently skipped.

Trade-off accepted: batching 35 judgments into one call is far cheaper and
faster than 35 separate calls, at the cost of relying on the grader model to
reliably track all 35 items in a single pass. Given the eval already runs
sequentially against a real backend and takes tens of minutes per claim
(see ingestion/processing timings from recent runs), the cost of 35x'ing the
grading calls was judged not worth the reliability gain.

The call is made via `matchesLlmRubric(rubric, llmOutput, grading, vars,
assertion)`, a function the `promptfoo` package exports publicly and already
uses internally to power the existing `report_quality` assertion — no new
grading infrastructure needed, just reuse of promptfoo's own mechanism.

## Architecture

`qa_match`'s `value` in `promptfooconfig.yaml` changes from an inline
multi-line JS string to a file reference:

```yaml
- type: javascript
  metric: qa_match
  value: file://scripts/qa-match-assertion.js
```

The logic moves into `scripts/qa-match-assertion.js`, matching this repo's
existing convention of extracting non-trivial logic into `scripts/*.js` with
a sibling `*.test.js` (see `score-dashboard.js`, `generate-tests-vars.js`).
This isn't strictly required by promptfoo (its `new Function(...)` execution
path for inline values does support returning a Promise), but an inline YAML
string is a poor home for logic that now requires a `require('promptfoo')`
import, a multi-line rubric template, and an async call.

### `scripts/qa-match-assertion.js`

Exports an async function `(output, context) => GradingResult` (the same
signature promptfoo's javascript assertions receive). Per claim:

1. **`riskStatusMatch`** (unchanged): loop `context.vars.expected.qa`, match
   each entry to `output.report.questions` by `predefinedQuestionId`, compare
   `riskStatus` exactly. Score = matched / total.
2. **`answerContentMatch`** (new): build the rubric prompt described above,
   call `matchesLlmRubric(...)` once, get back a 0–1 score.
3. Compute `score = (riskStatusMatch + answerContentMatch) / 2`.
4. Compute `pass`, mirroring promptfoo's own default behavior for numeric
   assertion results (`normalizeJavascriptAssertionResult` in promptfoo's
   `index.js`): `pass = assertion.threshold === undefined ? score > 0 :
   score >= assertion.threshold`. This preserves today's exact (weak, always-
   true-unless-total-failure) behavior by default, and lets a future
   `threshold:` in `promptfooconfig.yaml` opt into a real bar with no code
   change.
5. Return `{ pass, score, reason, namedScores: { riskStatusMatch,
   answerContentMatch } }`.

Note: returning an object (required to carry `namedScores`) means promptfoo's
automatic `score > 0` default no longer applies — that default only fires for
plain-number returns. Step 4 exists specifically to replicate it explicitly.

### Error handling

No new try/catch. If `matchesLlmRubric` throws (timeout, API error), let it
propagate — promptfoo already surfaces assertion errors as a failed result
with an error reason, consistent with how upstream provider failures (e.g.
the `INGESTION model is not found` 404 seen in a recent run) surface today.

## Dashboard changes

`scripts/score-dashboard.js`'s `acc` formula changes from:

```js
const acc = Math.round(50 * namedScores.qa_match + 50 * namedScores.report_quality);
```

to equal thirds across the three diagnostic signals:

```js
const acc = Math.round(
  (100 / 3) * namedScores.riskStatusMatch +
  (100 / 3) * namedScores.answerContentMatch +
  (100 / 3) * namedScores.report_quality
);
```

reading the two granular keys directly and ignoring the redundant rolled-up
`namedScores.qa_match`.

**Migration note:** this is a scoring-methodology change. `acc` numbers from
before this change aren't directly comparable to `acc` numbers after it
(different weighting, different underlying signals) — worth calling out in
the PR description.

## Testing changes

- **New `scripts/qa-match-assertion.test.js`** (added to the `test` script
  in `package.json`), covering:
  - `riskStatusMatch` computed correctly (partial match, missing question →
    0 — same cases `config-shape.test.js` covers today).
  - `answerContentMatch` wiring with `matchesLlmRubric` mocked/stubbed — no
    real API calls in unit tests; verifies the rubric is built with all
    expected Q&A pairs and the returned score flows into
    `namedScores.answerContentMatch`.
  - The `pass` threshold logic, both branches (no threshold → `score > 0`;
    threshold set → `score >= threshold`).
  - A missing actual answer is included in the rubric as "no answer
    provided" rather than silently dropped.

- **`config-shape.test.js` changes:**
  - The two tests that reconstruct `qa_match`'s inline value via
    `new Function('output', 'context', qaMatch.value)` and call it
    synchronously (current lines 101–133) are deleted — that coverage moves
    to `qa-match-assertion.test.js`, testing the real module directly.
  - `'config declares exactly two assertions'` still asserts
    `asserts.length === 2` (unchanged: `qa_match` + `report_quality`), but
    now asserts `qaMatch.value === 'file://scripts/qa-match-assertion.js'`
    instead of checking for a multi-line inline string.

- **`score-dashboard.test.js` changes:**
  - Every fixture (inline JSON blocks + `test/fixtures/results.sample.json`)
    that sets `namedScores: { qa_match, report_quality }` is updated to
    `{ riskStatusMatch, answerContentMatch, report_quality }`, with expected
    `acc` values recalculated for the equal-thirds formula.
  - The "missing named score → NaN → error entry" test still applies, with
    one of the three new keys omitted instead of `report_quality`.

## Out of scope

- Citation validation (`expectedCitationFileNames` vs. actual citations) —
  explicitly deferred.
- Per-question LLM calls — rejected in favor of one batched call per claim.
- Changing `report_quality` — untouched by this change.
