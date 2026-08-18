# Bucket-Driven Golden Baseline Design

## Goal

`claimsdata/claims.json` is a hand-curated golden dataset: someone runs a
claim once, then manually transcribes its summary, entity fields, fraud risk
score, per-question expected answers/risk statuses, and gold citation
passages into a JSON file that every future eval run is scored against. This
is slow to author and drifts from reality as the platform's own answers
evolve.

This design replaces that entirely. Instead of hand-curated data, the eval
takes a single **existing, already-processed bucket** as input (`bucketId`)
and treats that bucket's own already-existing report as the ground truth.
The harness copies that bucket's source documents into a fresh bucket,
re-processes them (through whatever ingestion/processing model this run is
checking), and validates the fresh report against the existing bucket's own
report — same documents, same platform-defined questions, compared
model-output-to-model-output instead of model-output-to-hand-typed-answer.

This is a **regression/consistency check** ("does re-processing the same
documents produce the same report?"), not a check against a human-labeled
absolute truth. The three existing assertions (`qa_match`, `report_quality`,
`metadata_match`) keep their exact current scoring mechanics — only where
`context.vars.expected` comes from changes.

Bundled into this same design: since a real existing bucket's documents are
now the copy source (rather than a small, hand-picked fixture set), one
document transiently failing to copy into the fresh bucket shouldn't abort
the whole comparison — `src/provider.js`'s document-copy loop changes to
skip and record a failed document instead of aborting the run, unless every
document fails.

## Decisions

### Single bucket per run

One `bucketId` in, one promptfoo test case out — no more array-of-claims.
Checking multiple buckets means running the workflow multiple times (or
multiple parallel dispatches), not one CI run scoring several claims at
once. This matches how GitHub Actions `workflow_dispatch` inputs naturally
work (a single text field) and removes an entire layer of "one test case per
claim" plumbing that no longer has a reason to exist.

### New workflow input: `sourceBucketId`

Added alongside the existing `newClaimName` / `ingestionModelName` /
`processingModelName` inputs in `.github/workflows/eval-workflow.yml`,
mapped to a new `SOURCE_BUCKET_ID` env var — same pattern as the three
existing ones. `scripts/build-tests-vars.js` (below) reads it directly; there
is no more `apply-claim-config.js` step mutating a committed data file in
place.

### Existing-bucket lookup: confirmed real API shape

Captured from a real `list-buckets` call against bucket 31804:

```json
{
  "response": {
    "content": [
      {
        "bucketId": 31804,
        "bucketStatus": "SUCCESS",
        "tags": [
          { "tagId": 5, "tagKey": "RenamedTag", "tagStatus": "ACTIVE", "mandatory": true, "tagValueId": 13, "value": "Normal" },
          { "tagId": 3, "tagKey": "Client Update", "tagStatus": "ACTIVE", "mandatory": true, "tagValueId": 17, "value": "Test B" }
        ],
        "claimCategoryId": 23,
        "claimCategoryName": "ABC",
        "latestReportId": "f3b854f4-707c-4338-9385-f7f2ef50c113"
      }
    ]
  }
}
```

(Additional fields — `ingestionModel`, `latestProcessingModel`,
`processingHistory`, bucket-level `fraudRiskScore`, `fileMetrics`, etc. —
exist but are irrelevant to this design: the actual "expected" report data
comes from `fetchReport(bucket.latestReportId)`, the same call already used
for the freshly-created bucket today, not from this bucket-list response.)

Confirms:
- `claimCategoryId` is a plain number at the top level, exactly as assumed.
- `tags` is present but in a **richer shape** than `createClaim` accepts
  (`createClaim`'s body only wants `{tagId, tagValueId}` pairs, matching
  today's `claims.json` convention — confirmed by reading `createClaim` in
  `fraudx-client.js`, which passes its `claimConfig` argument straight
  through as the POST body with no transformation). The existing bucket's
  richer tag objects must be mapped down before reuse:

  ```js
  const tags = Array.isArray(bucket.tags) && bucket.tags.length > 0
    ? bucket.tags.map((t) => ({ tagId: t.tagId, tagValueId: t.tagValueId }))
    : undefined;
  ```

  `undefined` (rather than `[]`) so the field can be spread away entirely
  when absent — **tags are optional**: use them if the existing bucket has
  any, don't fail if it doesn't.

### Error handling

- **`bucketStatus !== 'SUCCESS'` or missing `latestReportId`**: throw
  immediately. A bucket that was never fully processed (or is still
  processing) cannot serve as ground truth — same "fail fast and loud"
  posture the codebase already applies to real infrastructure problems
  (e.g. `FRAUDX_ENDPOINT_URI is not set`).
- **Existing report has zero questions**: throw immediately, for the same
  reason. `qa-match-assertion.js`'s scoring divides by `expectedQa.length`
  (`matched / expectedQa.length`); an empty `expected.qa` would silently
  produce `NaN` scores three ways downstream instead of a clear error at the
  one place that actually knows why — this bucket has no usable
  questionnaire to validate against.
- **Existing bucket's own S3 chunk-grounding file is missing**
  (`s3Client.fetchChunkGroundingData(sourceBucketId, ...)` returns `null`):
  degrade exactly the way `provider.js` already tolerates this today for the
  *new* report — no citations resolve, so no question gets an
  `expectedChunkText`, so `citationMatch` simply isn't graded for the run.
  Not a hard failure.
- **Existing bucket has `tags` missing/empty**: not an error at all — the
  new bucket is created without a `tags` field (optional, see above).

### Per-document ingestion resilience (`src/provider.js`)

Today, `callApi`'s document-copy loop is a bare `Promise.all` over
`sourceDocs` — the moment any single document's download, upload-URL
request, upload, or `waitForDocumentUpload` throws, the whole `Promise.all`
rejects and `callApi` throws, aborting the entire run even though the other
documents might have copied fine. With a real existing bucket as the source
(potentially several documents, any one of which can transiently fail), one
flaky document shouldn't sink the whole comparison.

Each per-document pipeline gets its own try/catch; a failure is logged and
recorded, not rethrown, so `Promise.all` still resolves once every document
has either succeeded or failed:

```js
const ingestionStart = Date.now();
const failedDocuments = [];
await Promise.all(sourceDocs.map(async (doc) => {
  try {
    const contentType = fraudxClient.contentTypeForExtension(doc.extension);
    const downloadUrl = await fraudxClient.getDownloadUrl(base, doc.gxMasterId, auth, timeoutMs);
    const bytes = await fraudxClient.downloadFile(downloadUrl, timeoutMs);
    const uploads = await fraudxClient.requestUploadUrls(base, auth, [{ fileName: doc.fileName, contentType }], newBucketId, timeoutMs);
    const upload = uploads.find((u) => u.fileName === doc.fileName);
    if (!upload) {
      throw new Error(`No upload URL returned for file "${doc.fileName}"`);
    }
    await fraudxClient.uploadFile(upload.uploadUrl, bytes, contentType, timeoutMs);
    await fraudxClient.triggerJobProcessing(base, auth, [upload.jobId], timeoutMs);
    await fraudxClient.waitForDocumentUpload(base, newBucketId, upload.jobId, auth, timeoutMs, uploadPollConfig);
  } catch (err) {
    console.error(`Skipping document "${doc.fileName}": ${err.message}`);
    failedDocuments.push({ fileName: doc.fileName, error: err.message });
  }
}));
const ingestionTimeMs = Date.now() - ingestionStart;

if (failedDocuments.length === sourceDocs.length) {
  throw new Error(
    `All ${sourceDocs.length} document(s) failed to copy into the new bucket — nothing was ingested: ` +
    failedDocuments.map((f) => `${f.fileName}: ${f.error}`).join('; ')
  );
}
```

- **Zero successes → fail fast.** If every document failed, triggering claim
  processing on an empty bucket would produce meaningless noise, not a
  useful (if degraded) comparison — same "fail fast and loud" posture used
  elsewhere in this design.
- **At least one success → proceed.** Claim processing is triggered with
  whatever subset of documents made it in.
- **Surfaced, not silent.** `output` gains `failedDocuments` — always an
  array (empty when nothing failed, matching the shape convention other
  always-present arrays like `perQuestionBreakdown` already use, so
  consumers don't need an `?? []` check). `scripts/generate-pdf-report.js`
  renders a "Failed documents" section listing `fileName`/`error` pairs when
  the array is non-empty, so a reviewer comparing the new report to the
  existing one can see "this document didn't make it in" instead of
  wondering why an answer that depended on it changed. The section is
  omitted entirely (not printed empty) when `failedDocuments` is `[]`,
  keeping today's reports visually unchanged for the common case.
- This is orthogonal to (and does not replace or duplicate) `fetchWithRetry`,
  which already retries `downloadFile` internally — this change is about not
  aborting the whole run after those retries are exhausted for one document,
  not about adding new retry layers to the other calls in this loop.

### New script: `scripts/build-tests-vars.js`

Replaces `scripts/apply-claim-config.js` and `scripts/generate-tests-vars.js`
(both deleted, along with their tests) with a single script, split the same
way the old `generate-tests-vars.js` was — a pure, synchronous builder
function plus a thin async I/O wrapper — for the same testability reason:

```js
'use strict';

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const fraudxClient = require('../src/fraudx-client');
const s3Client = require('../src/s3-client');
const resolveModelId = require('../src/lib/resolve-model-id');
const { extractCitedCitationsFromText } = require('../src/lib/extract-cited-file-names');

// Pure. Builds this run's one promptfoo test case in exactly the vars shape
// qa-match-assertion.js / metadata-match-assertion.js / provider.js already
// expect today — only how these values are sourced changes, not their shape.
function buildTestsVars({
  sourceBucketId, claimCategoryId, tags, newClaimName,
  ingestionModelId, processingModelId, existingReport, expectedQa,
}) {
  return [{
    vars: {
      bucket: {
        sourceBucketId,
        newClaim: {
          bucketName: newClaimName,
          claimCategoryId,
          ingestionModelId,
          processingModelId,
          ...(tags ? { tags } : {}),
        },
      },
      expected: {
        summarySynopsis: existingReport.summary,
        fraudRiskScore: existingReport.fraudRiskScore,
        claimantName: existingReport.claimantName,
        defendant: existingReport.defendant,
        insuranceFirm: existingReport.insuranceFirm,
        qa: expectedQa,
      },
    },
  }];
}

// Pure. Turns the existing report's own questions into the qa[] shape,
// resolving each question's own cited chunks' TEXT via the existing bucket's
// own S3 grounding file — the exact same citation-resolution approach
// provider.js already uses for the freshly-created bucket's report, just
// pointed at the existing bucket's grounding file instead.
function buildExpectedQa(existingQuestions, existingGroundingData) {
  return existingQuestions.map((q) => {
    const citations = extractCitedCitationsFromText(q.answer);
    const expectedChunkText = [];
    if (existingGroundingData) {
      for (const { documentId, chunkId } of citations) {
        const chunkText = existingGroundingData.get(s3Client.chunkKey(documentId, chunkId));
        if (chunkText) expectedChunkText.push(chunkText);
      }
    }
    return {
      predefinedQuestionId: q.predefinedQuestionId,
      question: q.question,
      expectedAnswerSummary: q.answer,
      expectedRiskStatus: q.riskStatus,
      ...(expectedChunkText.length > 0 ? { expectedChunkText } : {}),
    };
  });
}

// Async. Fetches everything the pure functions above need from the existing
// bucket: its claimCategoryId/tags (list-buckets), its own already-existing
// report (fetchReport), and its own chunk-grounding data (S3).
async function fetchExistingBucketBaseline(base, sourceBucketId, auth, timeoutMs) {
  const bucket = await fraudxClient.getBucketDetails(base, sourceBucketId, auth, timeoutMs);
  if (bucket.bucketStatus !== 'SUCCESS' || !bucket.latestReportId) {
    throw new Error(
      `Existing bucket ${sourceBucketId} has no completed report ` +
      `(bucketStatus: ${bucket.bucketStatus}) — it can't serve as ground truth.`
    );
  }
  const existingReport = await fraudxClient.fetchReport(base, bucket.latestReportId, auth, timeoutMs);
  if (!Array.isArray(existingReport.questions) || existingReport.questions.length === 0) {
    throw new Error(`Existing bucket ${sourceBucketId}'s report has no questions — it can't serve as ground truth.`);
  }
  const existingGroundingData = await s3Client.fetchChunkGroundingData(sourceBucketId, timeoutMs);
  const tags = Array.isArray(bucket.tags) && bucket.tags.length > 0
    ? bucket.tags.map((t) => ({ tagId: t.tagId, tagValueId: t.tagValueId }))
    : undefined;
  return { claimCategoryId: bucket.claimCategoryId, tags, existingReport, existingGroundingData };
}

async function generateTestsVars(outputPath) {
  const base = process.env.FRAUDX_ENDPOINT_URI;
  if (!base) throw new Error('FRAUDX_ENDPOINT_URI is not set. Copy .env.example to .env and fill it in.');
  const sourceBucketId = Number(process.env.SOURCE_BUCKET_ID);
  if (!process.env.SOURCE_BUCKET_ID || Number.isNaN(sourceBucketId)) {
    throw new Error('SOURCE_BUCKET_ID must be set to an existing, already-processed bucket id.');
  }
  const timeoutMs = Number(process.env.FRAUDX_HTTP_TIMEOUT_MS || 900000);
  const auth = await fraudxClient.login(base, timeoutMs);

  const { claimCategoryId, tags, existingReport, existingGroundingData } =
    await fetchExistingBucketBaseline(base, sourceBucketId, auth, timeoutMs);

  const ingestionModelId = await resolveModelId(base, auth, process.env.INGESTION_MODEL_NAME, 'INGESTION', timeoutMs);
  const processingModelId = await resolveModelId(base, auth, process.env.PROCESSING_MODEL_NAME, 'PROCESSING', timeoutMs);

  const expectedQa = buildExpectedQa(existingReport.questions, existingGroundingData);
  const testsVars = buildTestsVars({
    sourceBucketId, claimCategoryId, tags,
    newClaimName: process.env.CLAIM_NAME,
    ingestionModelId, processingModelId,
    existingReport, expectedQa,
  });

  fs.writeFileSync(
    outputPath,
    '# GENERATED FILE — do not hand-edit. Produced by scripts/build-tests-vars.js from a live\n' +
    '# fetch of the existing bucket named by SOURCE_BUCKET_ID.\n' +
    yaml.dump(testsVars)
  );
}

function main() {
  const outputPath = process.argv[2] || path.join(__dirname, '..', 'tests.vars.yaml');
  generateTestsVars(outputPath).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

if (require.main === module) {
  main();
}

module.exports = { buildTestsVars, buildExpectedQa, fetchExistingBucketBaseline, generateTestsVars };
```

Every call shown above is checked against the real current exports:
`resolveModelId(base, auth, displayName, typeName, timeoutMs)`,
`getBucketDetails(base, bucketId, auth, timeoutMs)`,
`fetchReport(base, reportId, auth, timeoutMs)`,
`fetchChunkGroundingData(bucketId, timeoutMs)`, `chunkKey(documentId,
chunkId)` — all match exactly, so this is close to final code, not a rough
sketch.

### `preeval` decouples from `pretest`

Today:

```json
"pretest": "npm run generate:tests",
"preeval": "node scripts/apply-claim-config.js && npm run generate:tests",
```

Both hooks call the same generation step — safe today because generation is
a pure, offline, synchronous transform of a committed JSON file. It is no
longer safe once generation means "log into FraudX and fetch a live bucket's
report": the `unit-tests` CI job (`npm ci && npm test`) has **no FraudX
credentials in its environment at all** (only the `full-eval` job's `env:`
block has them), so a `pretest` hook that requires live API access would
break plain `npm test` entirely, in CI and locally without a populated
`.env`.

New:

```json
"pretest": "",
"generate:tests": "node scripts/build-tests-vars.js",
"preeval": "npm run generate:tests",
```

`npm run eval`'s `preeval` hook remains the only place `tests.vars.yaml` gets
(re)generated — exactly the moment real FraudX credentials and a target
bucket are already required for the eval itself to run at all.

### `config-shape.test.js` narrows scope

Currently loads and asserts on the **generated** `tests.vars.yaml` from disk
at module scope — this only worked because generation was offline. Four of
its current tests (`tests.vars.yaml declares one test case per golden claim
bucket fixture`, `every test case's vars.bucket has a sourceBucketId and a
newClaim config`, `every test case's vars.expected has a summary and at
least one predefined-question entry`, plus the module-scope
`yaml.load(fs.readFileSync(testsVarsPath))` itself) move to
`scripts/build-tests-vars.test.js` as direct unit tests of the exported
`buildTestsVars`/`buildExpectedQa` pure functions, fed fake existing-report
data — no file I/O, no live API, matching how `generate-tests-vars.test.js`
already tests `buildTestsVars` today.

`config-shape.test.js` keeps only the tests that are actually about
`promptfooconfig.yaml`'s own static structure (provider id, assert list,
grader-provider env reference, the `tests: file://tests.vars.yaml`
whole-file reference) — none of which require `tests.vars.yaml` to exist on
disk.

### Removed

- `claimsdata/claims.json` and the `claimsdata/` directory
- `scripts/apply-claim-config.js`, `scripts/apply-claim-config.test.js`
- `scripts/generate-tests-vars.js`, `scripts/generate-tests-vars.test.js`
- `claimsdata/` mentions in `.gitignore`'s comment, `README.md`,
  `.env.example`'s `CLAIM_NAME` comment

### `.env.example` additions

```
# Required for `npm run eval`. The id of an existing, already-processed bucket
# whose own report becomes the ground truth this run is validated against.
SOURCE_BUCKET_ID=
```

`CLAIM_NAME`, `INGESTION_MODEL_NAME`, `PROCESSING_MODEL_NAME` stay as-is —
they configure the fresh copy, not the existing bucket.

### `.github/workflows/eval-workflow.yml`

Add `sourceBucketId` to `workflow_dispatch.inputs` (same shape as the
existing three), map it to `SOURCE_BUCKET_ID` in the `full-eval` job's `env:`
block.

## Testing

- `scripts/build-tests-vars.test.js` (new, replaces
  `apply-claim-config.test.js` + `generate-tests-vars.test.js`):
  - `buildTestsVars` maps fetched existing-bucket data into the exact
    documented vars shape.
  - `tags` omitted entirely from `newClaim` when the existing bucket had
    none; included (mapped to `{tagId, tagValueId}` pairs) when present.
  - `buildExpectedQa` resolves each question's own citations via the
    existing bucket's grounding map; a question with no resolvable citations
    gets no `expectedChunkText` key at all (same "omitted, not empty array"
    convention already used); a citation whose `(documentId, chunkId)` isn't
    in the grounding map is skipped, not treated as a mismatch.
  - `fetchExistingBucketBaseline` throws a clear error when `bucketStatus`
    isn't `SUCCESS` or `latestReportId` is missing, and when the existing
    report's `questions` array is missing or empty; succeeds when all are
    present, propagating `claimCategoryId`/mapped `tags`/`existingReport`/
    `existingGroundingData` through.
  - `existingGroundingData === null` (S3 file missing): every question ends
    up with no `expectedChunkText`, not a thrown error.
- `qa-match-assertion.test.js`, `metadata-match-assertion.test.js`:
  **unchanged** — they exercise `context.vars.expected` shapes that don't
  change.
- `provider.test.js`: mostly unchanged (still exercises `context.vars.bucket`
  unchanged), plus new tests for the ingestion-resilience change: one failing
  document (`getDownloadUrl`/`downloadFile`/`requestUploadUrls`/`uploadFile`/
  `triggerJobProcessing`/`waitForDocumentUpload` — pick one call site to
  reject) doesn't stop the others from completing, and shows up in
  `output.failedDocuments`; `output.failedDocuments` is `[]` when nothing
  failed; every document failing throws instead of proceeding to
  `triggerClaimProcessing` (assert `triggerClaimProcessing` was never
  called).
- `scripts/generate-pdf-report.test.js`: a claim with a non-empty
  `failedDocuments` renders a "Failed documents" section listing each
  `fileName`/`error`; a claim with an empty (or absent, for
  backward-compatibility with old `results.json` files) `failedDocuments`
  renders no such section.
- `config-shape.test.js`: keeps only the promptfooconfig.yaml-shape tests
  described above; no longer touches the filesystem for `tests.vars.yaml`.

## Documentation

- README: remove the "Test cases are generated from claimsdata/claims.json"
  framing throughout; describe the new `SOURCE_BUCKET_ID` input and the
  regression-check framing ("validated against the existing bucket's own
  report", not "hand-curated golden answers"). Update the "Trying it locally
  without hitting real infra" mock-server walkthrough, since the mock server
  will need a `list-buckets` response that includes `claimCategoryId` and a
  `fetchReport` response with real `questions[]`/`summary`/entity fields for
  this flow to exercise end to end (mock-server updates are in scope for the
  implementation plan, not detailed further here).
