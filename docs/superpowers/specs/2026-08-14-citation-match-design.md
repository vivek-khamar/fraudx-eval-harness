# Citation-Correctness Scoring Design

## Goal

Add a per-question check that the real FraudX report cited the *correct* source
document for each answer, not just that the answer text itself was right. Today
`qa_match` only checks `riskStatus` and answer-text semantics
(`riskStatusMatch`/`answerContentMatch`) — an answer can be worded correctly while
citing the wrong (or no) supporting document, and nothing currently catches that.

## Background

Every question's real answer text already embeds citation tags, e.g.:

```
...Notice of Objection <InTextCitation url="..." chunkId="..."
  fileName="JOSE%2BBRIONES%2BWC%2BFILE%2BCOMPLETE_part10.pdf" fileType="pdf"
  documentId="7ef537e1-175d-425f-9e57-7a870afbb551" sourceIndex="1" occurrenceIndex="1">
  </InTextCitation>...
```

(confirmed against a real captured `results.json` for bucket 31662). Each tag carries
several attributes, but only **`fileName`** is stable across runs — `documentId` is
assigned per-ingestion (a fresh claim/bucket is created on every eval run, so the same
source PDF gets a new `documentId` every time). `provider.js`'s existing
`extractCitedFileNames(report)` already keys off `fileName` for the same reason, to
fetch `citedDocumentsText` for the `report_quality` rubric. This design reuses that
same stable identifier, extended to per-question granularity.

## Decisions

### Data model

- `testdata/claims.json` question objects gain an **optional**
  `expectedCitedFileNames: string[]` — the exact source `fileName`(s) (as listed by
  `fraudxClient.listBucketDocuments`) that support that question's answer. Omitted
  entirely for questions not yet graded for citations — this is an incremental,
  per-question opt-in, not a required field. None of the existing 35 questions in the
  committed golden claim have it yet; this spec does not require backfilling them.
- `scripts/generate-tests-vars.js`'s `buildTestsVars` passes `expectedCitedFileNames`
  through unchanged into each `qa` entry (`expectedCitedFileNames: q.expectedCitedFileNames`).
  Same as every other optional field already flowing through this mapping: `undefined`
  when absent, which `js-yaml`'s `dump` silently omits from the written YAML (already
  relied on elsewhere in this codebase).

### Citation extraction (shared helper)

- New `scripts/extract-cited-file-names.js` exports
  `extractCitedFileNamesFromText(text)`: regex-matches `<InTextCitation\b([^>]*)>`
  tags in a single string, extracts `fileName="..."` from each tag's attributes,
  `decodeURIComponent`s it, and returns a deduplicated array in order of first
  appearance. Returns `[]` for text with no citation tags or `null`/`undefined` input.
- `provider.js`'s existing `extractCitedFileNames(report)` (which loops
  `report.questions`, running the same regex against each question's `answer` and
  unioning the file names for `citedDocumentsText`) is refactored to call
  `extractCitedFileNamesFromText` per question and union the results, instead of
  inlining its own copy of the regex. This is a pure internal refactor — external
  behavior and `provider.js`'s exported `extractCitedFileNames(report)` signature are
  unchanged, so `provider.test.js`'s existing tests continue to apply unmodified.

### `scripts/qa-match-assertion.js`

For each question in `expectedQa`:

- If `q.expectedCitedFileNames` is a non-empty array: compute
  `actualCitedFileNames = extractCitedFileNamesFromText(actualAnswer)`, then
  `citationMatches = actualCitedFileNames.some((f) => q.expectedCitedFileNames.includes(f))`
  — **at least one** expected file cited is a pass; extra actual citations beyond the
  expected set do not count against it.
- If `q.expectedCitedFileNames` is absent or empty: `citationMatches` is `undefined`
  (not graded) — excluded from the fraction below.
- `perQuestionBreakdown` gains two fields on every entry: `actualCitedFileNames`
  (always populated, for visibility even on ungraded questions) and `citationMatches`
  (`true`/`false`/`undefined`).
- `citationMatch` named score = (count of entries where `citationMatches === true`) /
  (count of entries where `citationMatches !== undefined`). If that denominator is 0
  (no question in this claim has `expectedCitedFileNames` set), `citationMatch` is
  `undefined` for the whole claim — not `0`, not `NaN`.
- The assertion's own local `score` (currently
  `(riskStatusMatch + answerContentMatch) / 2`, used for this assertion's own
  `pass`/`threshold`) becomes the average of `riskStatusMatch`, `answerContentMatch`,
  and `citationMatch` **when `citationMatch` is defined**; otherwise it stays the
  2-signal average exactly as today. Same exclude-if-no-data rule as the dashboard
  accuracy formula below, applied at the assertion's own scope.
- `namedScores` gains `citationMatch` (which may be `undefined` — promptfoo and
  `computeAccuracy` must both tolerate that).

### `scripts/score-dashboard.js` (`computeAccuracy`)

- When `namedScores.citationMatch` is a number: 6-way equal split —
  `acc = round(100/6 × (riskStatusMatch + answerContentMatch + report_quality + fraudRiskScoreMatch + entityFieldsMatch + citationMatch))`.
- When `namedScores.citationMatch` is `undefined` (claim has zero questions graded
  for citations): falls back to the existing 5-way equal-fifths formula, unchanged.
- As with the earlier fifths-to-thirds re-weighting, `acc` numbers from before this
  change are not directly comparable to `acc` numbers computed with the 6-signal
  formula — noted in the README, not enforced in code.

### PDF report (`scripts/generate-pdf-report.js`)

- Each question's block gains a `Citation Match: ✓` / `Citation Match: ✗` /
  `Citation Match: Not graded` line (placed after the existing `Risk Status` field).
- On `✗`, the line also shows what was expected vs. what was actually cited, e.g.
  `Citation Match: ✗ (expected one of: a.pdf, b.pdf; got: c.pdf)` — reusing
  `expectedCitedFileNames` and `actualCitedFileNames` from `perQuestionBreakdown`.
- `Not graded` (no color/pass-fail styling) when `citationMatches === undefined`.

## Testing

- `scripts/extract-cited-file-names.test.js` (new): multiple tags in one string
  (dedup + order-of-first-appearance), URL-encoded fileName decoding, no tags present
  (`[]`), `null`/`undefined`/empty-string input.
- `scripts/qa-match-assertion.test.js`: a question with a matching citation, a
  question with a non-matching citation (still fails even if the answer text itself
  matches), a question with multiple expected files where only one is actually cited
  (passes — "at least one"), a question with no `expectedCitedFileNames` (excluded
  from the fraction, `citationMatches: undefined` in the breakdown), a claim where
  *no* question has `expectedCitedFileNames` (`citationMatch: undefined` in
  `namedScores`, local `score` falls back to the 2-signal average).
- `scripts/score-dashboard.test.js`: `computeAccuracy` with `citationMatch` present
  (6-way split) and with `citationMatch: undefined` (5-way fallback, matches today's
  existing behavior/tests exactly).
- `scripts/generate-pdf-report.test.js`: renders `✓`, `✗` (with expected/actual file
  lists), and `Not graded` cases.
- `scripts/generate-tests-vars.test.js`: `expectedCitedFileNames` passes through
  when present, is absent from the generated YAML when the source claim omits it.
- `provider.test.js`: unchanged — the `extractCitedFileNames(report)` refactor to
  delegate to the new shared helper must not change its existing test outcomes.

## Documentation

Update the README's scoring section (`## Design`, around the `qa_match` assertion
bullet) to describe `citationMatch`, the new optional `expectedCitedFileNames`
question field, and the accuracy formula's conditional 6th signal — matching the
level of detail already given to `riskStatusMatch`/`answerContentMatch` there.
