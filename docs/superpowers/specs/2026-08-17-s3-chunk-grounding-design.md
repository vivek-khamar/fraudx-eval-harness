# S3 Chunk-Grounding for Cited Documents Design

## Goal

`citedDocumentsText` — the map of `fileName → source text` handed to the
`report_quality` rubric so it can check the real summary's claims are actually
grounded in the source documents — is currently built by re-downloading each
*whole* original source PDF via FraudX's own API and OCR/text-extracting it
(`provider.js`'s `getDownloadUrl`/`downloadFile`/`extractPdfText` loop over
`sourceDocs`). This has two problems:

- Citations reference **chunk-level, GX-internal filenames** (e.g.
  `..._part18-26-36.pdf`) that don't match any name in `sourceDocs` (the
  original whole-file uploads), so `sourceDocs.find((d) => d.fileName ===
  fileName)` fails and the citation is silently skipped — `citedDocumentsText`
  ends up missing content for exactly the citations that matter most.
- Even when a fileName does match, re-OCRing the entire original PDF gives
  noisy, untargeted text rather than the specific passage the model actually
  cited.

FraudX separately writes a per-claim JSON file to S3
(`fraudx-qa-claim-processor/{bucketId}.json`) containing, for every question,
a `source_ref[]` array that maps each citation's `document_uuid` +
`chunk_uuid` directly to the exact `chunk_text` GX extracted and grounded the
answer in. This design replaces the whole-PDF-download approach with a direct
lookup against that file.

## Background

A real citation tag looks like:

```
<InTextCitation url="..." chunkId="9804f994-de09-4efb-b1d2-72ec3b70f543"
  fileName="JOSE%2BBRIONES...part18-26-36.pdf" fileType="pdf"
  documentId="09d28bcb-2347-4f2a-9e78-b2fce1f6f387" sourceIndex="1"
  occurrenceIndex="1"></InTextCitation>
```

Today only `fileName` is extracted (`scripts/extract-cited-file-names.js`).
`documentId` and `chunkId` are discarded — but they are exactly the keys
needed to look up the grounding text in the S3 file:

```json
{
  "questionnaire": [
    {
      "question_id": 119,
      "source_ref": [
        {
          "document": {
            "chunk_uuid": "cca06afa-...",
            "document_uuid": "5b77d0ad-...",
            "filename": "Erick+Barrezueta_EFROI.pdf",
            "url": "https://upload.groundx.ai/file/.../....pdf"
          },
          "chunk_text": "The following text excerpt is from a document named '...'  ..."
        }
      ]
    }
  ]
}
```

`document.document_uuid` == the citation tag's `documentId`; `document.chunk_uuid`
== the citation tag's `chunkId`. Confirmed against a real captured file for
bucket 22997 (a different golden claim's processing run than the one used in
the earlier citation-match design doc, but the same schema).

## Decisions

### Scope: full replacement, no fallback

The existing whole-PDF-download cited-document step in `provider.js`
(`getDownloadUrl`/`downloadFile`/`extractPdfText` over `sourceDocs`, keyed on
`citedFileNames`) is deleted entirely, not kept as a fallback. If a citation's
`(documentId, chunkId)` isn't found in the S3 file, it is skipped — same
"skip and don't fail the run" policy the current code already applies to
citations it can't match. `extractPdfText` and `DOCUMENT_TEXT_CHAR_LIMIT`
remain in `fraudx-client.js`/`provider.js` (the former is still directly unit
tested in `fraudx-client.test.js`, the latter is reused for the new
truncation step below) — only their one call site in the cited-document loop
is removed.

### New module: `s3-client.js`

A new file parallel to `fraudx-client.js`, exporting:

```js
async function fetchChunkGroundingData(bucketId, timeoutMs)
```

- Uses `@aws-sdk/client-s3` (new dependency) to `GetObjectCommand` the key
  `${bucketId}.json` from the fixed bucket name `fraudx-qa-claim-processor`
  (hardcoded constant, not configurable — it's a single fixed bucket, not a
  per-environment setting).
- Credentials come from new env vars: `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` — added to `.env.example`, `.env`, and
  as new GitHub Actions secrets (`eval-workflow.yml`'s `full-eval` job `env:`
  block), following the exact same pattern as `FRAUDX_LOGIN_EMAIL`/
  `FRAUDX_LOGIN_PASSWORD`.
- If the object doesn't exist (S3 `NoSuchKey`), returns `null` rather than
  throwing — the caller treats this as "no grounding data for this claim",
  matching the missing-file decision below. Any other S3 error (auth
  failure, network error, wrong bucket/region) propagates as a thrown error —
  same treatment as `FRAUDX_ENDPOINT_URI is not set` elsewhere in this
  codebase: fail fast and loud, don't swallow real infrastructure problems.
- If the object exists but its body isn't valid JSON, or lacks a
  `questionnaire` array, throws — a parse failure here is a real bug (schema
  changed upstream), not a "missing data" case, so it must not be silently
  swallowed into an empty grounding set.
- Builds and returns a plain lookup object/`Map` keyed by
  `` `${document_uuid}:${chunk_uuid}` `` → `chunk_text`, flattening every
  `questionnaire[].source_ref[]` entry across the whole file (a chunk cited
  from one question's answer may legitimately also ground a citation in
  another question or in the top-level summary).

### Citation extraction: capture `documentId` + `chunkId`

`scripts/extract-cited-file-names.js` gains a new exported function:

```js
function extractCitedCitationsFromText(text)
// returns [{ fileName, documentId, chunkId }, ...], deduplicated by
// (documentId, chunkId) pair, in order of first appearance. Same
// null/undefined/no-tags handling as the existing function.
```

The existing `extractCitedFileNamesFromText(text)` is **deleted**, along with
its tests in `scripts/extract-cited-file-names.test.js`. Its only two
callers — `provider.js`'s `extractCitedFileNames(report)` (removed by this
same design, see below) and `qa-match-assertion.js`'s fileName-based
`citationMatch` check (removed by "Chunk-text semantic citation matching"
below) — are both going away, and `extractCitedCitationsFromText` is a strict
superset (it returns `fileName` alongside `documentId`/`chunkId`), so keeping
both functions around would just be redundant, unused-in-production surface
area. Any caller that only needs the fileName list can map over
`extractCitedCitationsFromText`'s result (`citations.map((c) => c.fileName)`).

### `provider.js` changes

Replace the current cited-document block:

```js
const citedFileNames = extractCitedFileNames(report);
const citedDocumentsText = {};
for (const fileName of citedFileNames) {
  const citedDoc = sourceDocs.find((d) => d.fileName === fileName);
  if (!citedDoc) continue;
  const citedDownloadUrl = await fraudxClient.getDownloadUrl(...);
  const citedBytes = await fraudxClient.downloadFile(citedDownloadUrl, timeoutMs);
  const text = await fraudxClient.extractPdfText(citedBytes);
  citedDocumentsText[fileName] = text.slice(0, DOCUMENT_TEXT_CHAR_LIMIT);
}
```

with:

```js
const citations = report.questions.flatMap((q) => extractCitedCitationsFromText(q.answer));
const groundingData = await s3Client.fetchChunkGroundingData(report.bucketId, timeoutMs);
const citedDocumentsText = {};
if (groundingData) {
  const chunksByFileName = new Map();
  for (const { fileName, documentId, chunkId } of citations) {
    const chunkText = groundingData.get(`${documentId}:${chunkId}`);
    if (!chunkText) continue; // not found — skip, no fallback
    if (!chunksByFileName.has(fileName)) chunksByFileName.set(fileName, []);
    chunksByFileName.get(fileName).push(chunkText);
  }
  for (const [fileName, texts] of chunksByFileName) {
    citedDocumentsText[fileName] = texts.join('\n\n').slice(0, DOCUMENT_TEXT_CHAR_LIMIT);
  }
}
```

- `sourceDocs` remains used elsewhere (the ingestion loop) — this change only
  touches the cited-document step, which no longer references `sourceDocs`,
  `getDownloadUrl`, `downloadFile`, or `extractPdfText` at all.
- Same citation *selection* scope as today: only `report.questions[].answer`
  is scanned for citations, not `report.summary` itself (which carries its
  own separate citation tags in the raw data but has never been included
  here). This design changes how grounding text is fetched for the citations
  already being collected, not which citations get collected.
- `extractCitedFileNames(report)` (the exported, file-level union function in
  `provider.js`) has no callers outside the block being removed and its own
  two unit tests (confirmed by grep across the repo) — it becomes pure dead
  code and is deleted, along with its `module.exports.extractCitedFileNames`
  line and its two tests in `provider.test.js` (`extractCitedFileNames
  collects unique, decoded fileNames...`, `extractCitedFileNames returns an
  empty array...`).
- `output` gains a new field, `chunkGroundingData`, set to the raw
  `groundingData` map (or `null` if the S3 file was missing) —
  `qa-match-assertion.js`'s chunk-text semantic match (below) reuses this
  instead of fetching the same S3 object a second time per claim.

### Config additions

- `.env.example`: new `AWS_ACCESS_KEY_ID=`, `AWS_SECRET_ACCESS_KEY=`,
  `AWS_REGION=` lines, with a comment noting they're for reading the
  `fraudx-qa-claim-processor` S3 bucket (chunk-grounding data), separate from
  the FraudX gateway credentials above them.
- `.github/workflows/eval-workflow.yml`: add the same three as new `env:`
  entries on the `full-eval` job, sourced from new repo secrets.
- `package.json`: add `@aws-sdk/client-s3` to `dependencies`.

## Testing

- `scripts/extract-cited-file-names.test.js`: rewritten (not extended) for
  `extractCitedCitationsFromText`, replacing every `extractCitedFileNamesFromText`
  test with an equivalent — multiple citations (dedup by `documentId`+`chunkId`
  pair, not just `fileName`, since two citations of the same file but
  different chunks must **not** be deduped away — this is a genuine behavior
  change from the old function), URL-decoding of `fileName`, no tags (`[]`),
  `null`/`undefined`/empty-string input, reusable-across-calls (no leaked
  regex state).
- `s3-client.test.js` (new): mocks the AWS SDK client's `send` method —
  returns a well-formed grounding JSON (verify the returned lookup map's
  keys/values), `NoSuchKey` error (returns `null`), malformed JSON body
  (throws), other S3 errors (propagate).
- `provider.test.js`: update the existing cited-document tests (`callApi
  fetches text only for documents actually cited...`, `callApi skips a cited
  fileName it cannot match...`, `callApi returns an empty citedDocumentsText
  when the report has no citations`) to mock `s3Client.fetchChunkGroundingData`
  instead of `getDownloadUrl`/`downloadFile`/`extractPdfText`. Add: multiple
  chunks for the same `fileName` get concatenated; a citation whose
  `(documentId, chunkId)` isn't in the grounding map is skipped without
  failing the run; `groundingData === null` (file missing) yields an empty
  `citedDocumentsText`, not a thrown error.

## Chunk-text semantic citation matching (supersedes fileName-based `citationMatch`)

### Goal

The shipped `citationMatch` (2026-08-14 design) only checks that the model
*cited some file from an expected list* — it can't tell whether the model
cited the *right passage* within that file, and it can't be more specific
than file-level because `documentId` (and, it turns out, `chunkId`) aren't
stable across re-ingestion runs, so an ID-based expected value in
`claims.json` would never match on a fresh run. Now that per-citation
grounding text is fetchable (see above), the check can move from "did it cite
an allowed file" to "does the actually-cited passage semantically match the
correct passage" — strictly more precise, and it doesn't depend on any ID
being stable, since both sides of the comparison are compared as text.

### Data model

- `testdata/claims.json` question objects: `expectedCitedFileNames: string[]`
  is replaced by `expectedChunkText: string` — one curated golden passage
  per question, authored by running the claim once, finding the chunk that
  actually should ground that question's answer, and copying its
  `chunk_text` verbatim (from the same S3 file this design already reads).
  Optional, same incremental opt-in as today: omitted entirely for questions
  not (yet) graded for citation content.
- **Migration**: the 21 of 35 questions in the committed golden claim that
  already have `expectedCitedFileNames` (added in commit `ad85d5a`) need to be
  re-authored as `expectedChunkText` — the old fileName lists don't carry
  enough information to derive the new field automatically. This is real,
  manual re-authoring work, not a mechanical rename; out of scope for the
  implementation plan to do for all 21 (matching how `ad85d5a` itself only
  backfilled a subset, not all 35, when the field was first introduced).
- `scripts/generate-tests-vars.js`'s `buildTestsVars` passes
  `expectedChunkText` through unchanged (same pattern as every other optional
  per-question field), replacing its current `expectedCitedFileNames` line.

### `scripts/qa-match-assertion.js` changes

- The current fileName-based block (`actualCitedFileNames = extractCitedFileNamesFromText(actualAnswer); citationMatches = ...some(f => expectedCitedFileNames.includes(f))`)
  is deleted.
- New logic per question, only when `q.expectedChunkText` is set:
  1. `const citations = extractCitedCitationsFromText(actualAnswer);` — this
     question's own citations only, not the whole report.
  2. For each citation, look up `output.chunkGroundingData?.get(`${documentId}:${chunkId}`)`.
     Citations that don't resolve (missing grounding data entirely, or that
     specific chunk not in the map) are skipped, same "just skip" policy as
     the fetch-side design above.
  3. For each resolved chunk text, call the grader provider (the same
     `provider` already loaded once via `promptfoo.loadApiProvider` earlier
     in this function) with a new prompt:
     ```
     Expected source passage: {expectedChunkText}
     Actual cited passage: {chunkText}

     Does the actual cited passage semantically support/match the expected
     source passage above (exact wording does not matter, meaning does)?
     Respond with only a JSON object, no other text:
     {"matches": boolean, "reason": string}.
     ```
     Reuses the existing `parseGraderVerdict` unchanged (same `{matches,
     reason}` shape as the answer-content grader call).
  4. `citationMatches = true` if **any** resolved chunk's grader call returns
     `matches: true` — same "at least one" semantics the old fileName check
     used. `reason` on the entry is the reason from whichever call decided
     the outcome (first `true` if any passed; the last-checked `false`'s
     reason otherwise). If **no citation resolved at all** (none extracted,
     or none found in `chunkGroundingData`), `citationMatches = false` with
     no grader call made, and `reason` is a fixed string, e.g. `"No cited
     chunk resolved to compare against the expected passage."` — there is
     nothing to show a grader's opinion on, but the field must still be a
     string per this same file's own `parseGraderVerdict`-shaped conventions.
- `q.expectedChunkText` absent → `citationMatches: undefined`, unchanged
  "not graded" behavior.
- `perQuestionBreakdown` entries: `actualCitedFileNames` (still populated,
  still useful for visibility) stays; nothing about `namedScores.citationMatch`,
  the assertion's own `score`, or `computeAccuracy` in `score-dashboard.js`
  changes shape — they only ever consumed `citationMatches`/`citationMatch`
  as a boolean/number-or-undefined, so this is a swap of *how* that value is
  computed, not what shape it has downstream.
- **Cost/latency note**: this adds one extra grader-provider LLM call per
  question that has `expectedChunkText` set (on top of the existing
  riskStatus/answerContent call already made per question) — worth watching
  on the next real run, though the bulk of eval wall-clock time is FraudX's
  own ingestion/processing, not grading.

### `scripts/generate-pdf-report.js` changes

`formatCitationMatch`'s `NO` case currently renders
`(expected one of: a.pdf, b.pdf; got: c.pdf)` — a filename diff that no
longer makes sense once the check is content-based. It's replaced with the
grader's `reason` (same rendering pattern already used for the per-question
`Reason:` line elsewhere in this file): `Citation Match: NO ({reason})`. The
`YES` and `N/A` (`citationMatches == null`) cases are unchanged.

### Testing

- `scripts/qa-match-assertion.test.js`: replace the existing fileName-based
  `citationMatch` tests with: a question whose actual answer cites a chunk
  that resolves via `chunkGroundingData` and the grader says matches (pass);
  cites a chunk that resolves but the grader says it doesn't match (fail,
  with `reason` populated); cites multiple chunks where only one matches
  (still passes — "at least one"); a citation whose `(documentId, chunkId)`
  isn't in `chunkGroundingData` (skipped, doesn't crash); `chunkGroundingData`
  is `null` (all citations skipped, `citationMatches: false` since zero
  matched, not `undefined` — only *absence of `expectedChunkText`* makes it
  `undefined`); no `expectedChunkText` on the question (excluded from the
  fraction, as today).
- `scripts/generate-tests-vars.test.js`: `expectedChunkText` passes through
  when present, absent from generated YAML when the source claim omits it
  (replacing the equivalent existing `expectedCitedFileNames` tests).
- `scripts/generate-pdf-report.test.js`: `NO` case renders the grader reason,
  not a filename list; `YES`/`N/A` cases unchanged from today's tests.
- `provider.test.js`: new assertion that `output.chunkGroundingData` is the
  raw map returned by `s3Client.fetchChunkGroundingData` (or `null`), so
  `qa-match-assertion.js` can be tested independently of a real S3 call.

## Documentation

- Update the README's citation section (the paragraph starting "Citations
  are parsed out of free-text answers...") to describe the S3 chunk-grounding
  lookup replacing whole-PDF download for `citedDocumentsText`, and note the
  three new required env vars alongside the existing `.env.example`
  walkthrough.
- Update the README's `citationMatch` description (added by the 2026-08-14
  design) to describe the new chunk-text semantic check, the
  `expectedChunkText` field replacing `expectedCitedFileNames`, and the extra
  grader-provider call this adds per graded question.
