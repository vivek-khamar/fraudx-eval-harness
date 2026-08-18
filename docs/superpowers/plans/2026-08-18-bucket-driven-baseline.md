# Bucket-Driven Golden Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `claimsdata/claims.json` (hand-curated golden data) with a single `bucketId` input whose own already-existing report becomes the ground truth for a fresh reprocessing run, and make document ingestion resilient to one document failing.

**Architecture:** `scripts/build-tests-vars.js` (new) fetches an existing bucket's `claimCategoryId`/`tags`/latest report/chunk-grounding data live via the FraudX/S3 APIs and writes `tests.vars.yaml` directly — no more static JSON → YAML transform. `src/provider.js`'s document-copy loop tolerates individual document failures. Everything downstream (`qa-match-assertion.js`, `metadata-match-assertion.js`, `report_quality`) is unchanged — they only ever read `context.vars.expected`, whose shape doesn't change.

**Tech Stack:** Node.js, `node:test`, `js-yaml`, existing `fraudx-client.js`/`s3-client.js`/`resolve-model-id.js`.

**Spec:** `docs/superpowers/specs/2026-08-18-bucket-driven-baseline-design.md`

## Global Constraints

- No change to `qa-match-assertion.js`, `metadata-match-assertion.js`, `provider.js`'s `context.vars.bucket`/`context.vars.expected` consumption, or any threshold/pass-fail logic — only where `expected` data comes from changes.
- `tags` are optional on the existing bucket: use if present (mapped to `{tagId, tagValueId}` pairs), omit `newClaim.tags` entirely if absent/empty. Never fail because of missing tags.
- Fail fast (throw, don't degrade) when: the existing bucket's `bucketStatus !== 'SUCCESS'` or has no `latestReportId`; the existing report has zero questions; every source document fails to copy into the new bucket.
- Degrade gracefully (don't fail) when: the existing bucket's own S3 chunk-grounding file is missing — affected questions just get no `expectedChunkText`.
- `src/provider.js`'s per-document ingestion failures are surfaced via `output.failedDocuments` (always an array), never silently swallowed.
- `npm test` (plain unit tests) must never require live FraudX API access or a populated `.env` — only `npm run eval`'s `preeval` hook may.

---

### Task 1: Per-document ingestion resilience in `src/provider.js`

**Files:**
- Modify: `src/provider.js`
- Test: `src/provider.test.js`

**Interfaces:**
- Produces: `output.failedDocuments` — `Array<{fileName: string, error: string}>`, always present (empty when nothing failed). Consumed later by the PDF-report-restructure plan; not used by anything else yet.

- [ ] **Step 1: Write the two failing tests**

Add to `src/provider.test.js`, after the existing `'callApi throws when no upload URL matches a source document\'s fileName'` test:

```js
test('callApi continues copying other documents when one document\'s pipeline fails, recording it in output.failedDocuments', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  mockFraudxClient(t, {
    ...happyPathMocks([]),
    listBucketDocuments: async () => [
      { gxMasterId: 1, fileName: 'a.pdf', extension: 'pdf' },
      { gxMasterId: 2, fileName: 'b.pdf', extension: 'pdf' },
    ],
    requestUploadUrls: async (base, auth, files) => {
      if (files[0].fileName === 'b.pdf') {
        throw new Error('upload URL service unavailable');
      }
      return [{ fileName: files[0].fileName, jobId: 1, uploadUrl: 'https://s3.example/put' }];
    },
  });

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.deepEqual(result.output.failedDocuments, [{ fileName: 'b.pdf', error: 'upload URL service unavailable' }]);
});

test('callApi throws when every document fails to copy, without triggering claim processing', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  let triggerClaimProcessingCalled = false;
  mockFraudxClient(t, {
    ...happyPathMocks([]),
    requestUploadUrls: async () => {
      throw new Error('upload URL service unavailable');
    },
    triggerClaimProcessing: async () => {
      triggerClaimProcessingCalled = true;
      return 'task-1';
    },
  });

  const provider = new Provider();
  await assert.rejects(
    () => provider.callApi('FX-GOLD-5K-v1', fakeContext()),
    /All 1 document\(s\) failed to copy into the new bucket/
  );
  assert.equal(triggerClaimProcessingCalled, false, 'claim processing must not be triggered on an empty bucket');
});

test('callApi sets output.failedDocuments to an empty array when every document copies successfully', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  mockFraudxClient(t, happyPathMocks([]));

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.deepEqual(result.output.failedDocuments, []);
});
```

- [ ] **Step 2: Run and verify all three fail**

Run: `node --test src/provider.test.js`
Expected: the 3 new tests FAIL — the first two with `TypeError: Cannot read properties of undefined (reading 'failedDocuments')` or similar (the field doesn't exist yet), the third the same way. All other existing tests in this file still PASS unchanged.

- [ ] **Step 3: Implement**

In `src/provider.js`, replace:

```js
    const ingestionStart = Date.now();
    await Promise.all(sourceDocs.map(async (doc) => {
      const contentType = fraudxClient.contentTypeForExtension(doc.extension);
      const downloadUrl = await fraudxClient.getDownloadUrl(base, doc.gxMasterId, auth, timeoutMs);
      const bytes = await fraudxClient.downloadFile(downloadUrl, timeoutMs);
      // Requested here, immediately before use, rather than batched for all documents upfront —
      // presigned upload URLs go stale within minutes on the real platform. Each document still
      // requests its own URL right before uploading; only the documents now run concurrently
      // with each other instead of waiting their turn.
      const uploads = await fraudxClient.requestUploadUrls(base, auth, [{ fileName: doc.fileName, contentType }], newBucketId, timeoutMs);
      const upload = uploads.find((u) => u.fileName === doc.fileName);
      if (!upload) {
        throw new Error(`No upload URL returned for file "${doc.fileName}"`);
      }
      await fraudxClient.uploadFile(upload.uploadUrl, bytes, contentType, timeoutMs);
      await fraudxClient.triggerJobProcessing(base, auth, [upload.jobId], timeoutMs);
      await fraudxClient.waitForDocumentUpload(base, newBucketId, upload.jobId, auth, timeoutMs, uploadPollConfig);
    }));
    const ingestionTimeMs = Date.now() - ingestionStart;
```

with:

```js
    const ingestionStart = Date.now();
    const failedDocuments = [];
    await Promise.all(sourceDocs.map(async (doc) => {
      try {
        const contentType = fraudxClient.contentTypeForExtension(doc.extension);
        const downloadUrl = await fraudxClient.getDownloadUrl(base, doc.gxMasterId, auth, timeoutMs);
        const bytes = await fraudxClient.downloadFile(downloadUrl, timeoutMs);
        // Requested here, immediately before use, rather than batched for all documents upfront —
        // presigned upload URLs go stale within minutes on the real platform. Each document still
        // requests its own URL right before uploading; only the documents now run concurrently
        // with each other instead of waiting their turn.
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

Then update the `return` statement at the end of `callApi`, replacing:

```js
    return {
      output: {
        ingestion: { timeMs: ingestionTimeMs },
        processing: { timeMs: processingTimeMs },
        report,
        citedDocumentsText,
        chunkGroundingData,
      },
    };
```

with:

```js
    return {
      output: {
        ingestion: { timeMs: ingestionTimeMs },
        processing: { timeMs: processingTimeMs },
        report,
        citedDocumentsText,
        chunkGroundingData,
        failedDocuments,
      },
    };
```

- [ ] **Step 4: Run and verify all pass**

Run: `node --test src/provider.test.js`
Expected: all tests PASS, including the 3 new ones and every pre-existing one — **no changes needed** to `'callApi throws when no upload URL matches a source document\'s fileName'`: that document's failure is now caught by the new try/catch and pushed into `failedDocuments`, and since it's the *only* document in that test's fixture, `failedDocuments.length === sourceDocs.length` (1 === 1) still triggers the new all-failed throw — whose message (`All 1 document(s) failed to copy into the new bucket — nothing was ingested: a.pdf: No upload URL returned for file "a.pdf"`) still *contains* the substring `No upload URL returned for file "a.pdf"`, so the test's existing `assert.rejects(..., /No upload URL returned for file "a\.pdf"/)` still matches unchanged (the regex isn't anchored, so a substring match is enough).

Run: `npm test`
Expected: full suite passes.

- [ ] **Step 5: Commit**

```bash
git add src/provider.js src/provider.test.js
git commit -m "feat: tolerate individual document ingestion failures, fail only if all fail"
```

---

### Task 2: New script `scripts/build-tests-vars.js`

**Files:**
- Create: `scripts/build-tests-vars.js`
- Create: `scripts/build-tests-vars.test.js`

**Interfaces:**
- Consumes: `fraudxClient.getBucketDetails(base, bucketId, auth, timeoutMs)`, `fraudxClient.fetchReport(base, reportId, auth, timeoutMs)`, `fraudxClient.login(base, timeoutMs)`, `resolveModelId(base, auth, displayName, typeName, timeoutMs)` (from `src/lib/resolve-model-id.js`), `s3Client.fetchChunkGroundingData(bucketId, timeoutMs)`, `s3Client.chunkKey(documentId, chunkId)`, `extractCitedCitationsFromText(text)` (from `src/lib/extract-cited-file-names.js`).
- Produces: `tests.vars.yaml` on disk (same consumers as today: `promptfooconfig.yaml`'s `tests: file://tests.vars.yaml`, `config-shape.test.js`).

- [ ] **Step 1: Write the failing tests for `buildTestsVars`**

Create `scripts/build-tests-vars.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const fraudxClient = require('../src/fraudx-client');
const s3Client = require('../src/s3-client');
const {
  buildTestsVars,
  buildExpectedQa,
  fetchExistingBucketBaseline,
  generateTestsVars,
} = require('./build-tests-vars');

function mockFraudxClient(t, overrides) {
  const originals = {};
  for (const [name, impl] of Object.entries(overrides)) {
    originals[name] = fraudxClient[name];
    fraudxClient[name] = impl;
  }
  t.after(() => {
    for (const name of Object.keys(overrides)) {
      fraudxClient[name] = originals[name];
    }
  });
}

function mockS3Client(t, impl) {
  const original = s3Client.fetchChunkGroundingData;
  s3Client.fetchChunkGroundingData = impl;
  t.after(() => {
    s3Client.fetchChunkGroundingData = original;
  });
}

test('buildTestsVars maps fetched existing-bucket data into the documented vars shape', () => {
  const result = buildTestsVars({
    sourceBucketId: 31804,
    claimCategoryId: 23,
    tags: [{ tagId: 3, tagValueId: 17 }],
    newClaimName: 'my-run',
    ingestionModelId: 1,
    processingModelId: 9,
    existingReport: {
      summary: 'Gold summary.',
      fraudRiskScore: 0.5,
      claimantName: 'Jane Doe',
      defendant: 'Acme Corp',
      insuranceFirm: 'Acme Insurance',
    },
    expectedQa: [{ predefinedQuestionId: 1, question: 'Q?', expectedAnswerSummary: 'A.', expectedRiskStatus: 'RISK_DETECTED' }],
  });

  assert.deepEqual(result, [{
    vars: {
      bucket: {
        sourceBucketId: 31804,
        newClaim: {
          bucketName: 'my-run',
          claimCategoryId: 23,
          ingestionModelId: 1,
          processingModelId: 9,
          tags: [{ tagId: 3, tagValueId: 17 }],
        },
      },
      expected: {
        summarySynopsis: 'Gold summary.',
        fraudRiskScore: 0.5,
        claimantName: 'Jane Doe',
        defendant: 'Acme Corp',
        insuranceFirm: 'Acme Insurance',
        qa: [{ predefinedQuestionId: 1, question: 'Q?', expectedAnswerSummary: 'A.', expectedRiskStatus: 'RISK_DETECTED' }],
      },
    },
  }]);
});

test('buildTestsVars omits newClaim.tags entirely when tags is undefined', () => {
  const result = buildTestsVars({
    sourceBucketId: 1, claimCategoryId: 23, tags: undefined, newClaimName: 'x',
    ingestionModelId: 1, processingModelId: 9,
    existingReport: { summary: 's', fraudRiskScore: 0.5, claimantName: 'a', defendant: 'b', insuranceFirm: 'c' },
    expectedQa: [],
  });
  assert.equal('tags' in result[0].vars.bucket.newClaim, false);
});

test('buildExpectedQa resolves each question\'s own citations via the existing bucket\'s grounding map', () => {
  const questions = [{
    predefinedQuestionId: 1,
    question: 'Q1?',
    answer: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    riskStatus: 'RISK_DETECTED',
  }];
  const grounding = new Map([[s3Client.chunkKey('doc-1', 'chunk-1'), 'The grounded passage.']]);

  const result = buildExpectedQa(questions, grounding);

  assert.deepEqual(result, [{
    predefinedQuestionId: 1,
    question: 'Q1?',
    expectedAnswerSummary: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    expectedRiskStatus: 'RISK_DETECTED',
    expectedChunkText: ['The grounded passage.'],
  }]);
});

test('buildExpectedQa omits expectedChunkText entirely when no citation resolves', () => {
  const questions = [{ predefinedQuestionId: 1, question: 'Q1?', answer: 'no citations here', riskStatus: 'UNSURE' }];
  const result = buildExpectedQa(questions, new Map());
  assert.equal('expectedChunkText' in result[0], false);
});

test('buildExpectedQa treats a null grounding map (missing S3 file) as every citation unresolved, not a thrown error', () => {
  const questions = [{
    predefinedQuestionId: 1, question: 'Q1?', riskStatus: 'UNSURE',
    answer: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
  }];
  const result = buildExpectedQa(questions, null);
  assert.equal('expectedChunkText' in result[0], false);
});

test('fetchExistingBucketBaseline throws when bucketStatus is not SUCCESS', async (t) => {
  mockFraudxClient(t, {
    getBucketDetails: async () => ({ bucketStatus: 'IN_PROGRESS', latestReportId: null, claimCategoryId: 23, tags: [] }),
  });
  await assert.rejects(
    () => fetchExistingBucketBaseline('https://fake', 31804, { token: 't', orgId: 1, userId: 1 }, 1000),
    /Existing bucket 31804 has no completed report/
  );
});

test('fetchExistingBucketBaseline throws when the existing report has zero questions', async (t) => {
  mockFraudxClient(t, {
    getBucketDetails: async () => ({ bucketStatus: 'SUCCESS', latestReportId: 'report-1', claimCategoryId: 23, tags: [] }),
    fetchReport: async () => ({ summary: 's', questions: [] }),
  });
  await assert.rejects(
    () => fetchExistingBucketBaseline('https://fake', 31804, { token: 't', orgId: 1, userId: 1 }, 1000),
    /Existing bucket 31804's report has no questions/
  );
});

test('fetchExistingBucketBaseline maps the existing bucket\'s richer tag objects down to {tagId, tagValueId}', async (t) => {
  mockFraudxClient(t, {
    getBucketDetails: async () => ({
      bucketStatus: 'SUCCESS',
      latestReportId: 'report-1',
      claimCategoryId: 23,
      tags: [{ tagId: 5, tagKey: 'RenamedTag', tagStatus: 'ACTIVE', mandatory: true, tagValueId: 13, value: 'Normal' }],
    }),
    fetchReport: async () => ({ summary: 's', questions: [{ predefinedQuestionId: 1, question: 'Q?', answer: 'A', riskStatus: 'UNSURE' }] }),
  });
  mockS3Client(t, async () => null);

  const result = await fetchExistingBucketBaseline('https://fake', 31804, { token: 't', orgId: 1, userId: 1 }, 1000);

  assert.deepEqual(result.tags, [{ tagId: 5, tagValueId: 13 }]);
  assert.equal(result.claimCategoryId, 23);
});

test('fetchExistingBucketBaseline leaves tags undefined when the existing bucket has none', async (t) => {
  mockFraudxClient(t, {
    getBucketDetails: async () => ({ bucketStatus: 'SUCCESS', latestReportId: 'report-1', claimCategoryId: 23, tags: [] }),
    fetchReport: async () => ({ summary: 's', questions: [{ predefinedQuestionId: 1, question: 'Q?', answer: 'A', riskStatus: 'UNSURE' }] }),
  });
  mockS3Client(t, async () => null);

  const result = await fetchExistingBucketBaseline('https://fake', 31804, { token: 't', orgId: 1, userId: 1 }, 1000);

  assert.equal(result.tags, undefined);
});

test('generateTestsVars writes a re-parseable tests.vars.yaml from a live fetch', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tests-vars-'));
  const outputPath = path.join(tmpDir, 'tests.vars.yaml');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  process.env.SOURCE_BUCKET_ID = '31804';
  process.env.CLAIM_NAME = 'my-run';
  process.env.INGESTION_MODEL_NAME = 'ingest-model';
  process.env.PROCESSING_MODEL_NAME = 'process-model';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
    delete process.env.SOURCE_BUCKET_ID;
    delete process.env.CLAIM_NAME;
    delete process.env.INGESTION_MODEL_NAME;
    delete process.env.PROCESSING_MODEL_NAME;
  });

  mockFraudxClient(t, {
    login: async () => ({ token: 't', orgId: 1, userId: 1 }),
    getBucketDetails: async () => ({ bucketStatus: 'SUCCESS', latestReportId: 'report-1', claimCategoryId: 23, tags: [] }),
    fetchReport: async () => ({
      summary: 's', fraudRiskScore: 0.5, claimantName: 'a', defendant: 'b', insuranceFirm: 'c',
      questions: [{ predefinedQuestionId: 1, question: 'Q?', answer: 'A', riskStatus: 'UNSURE' }],
    }),
    searchModels: async (base, auth, typeName) => [{ id: typeName === 'INGESTION' ? 1 : 9, displayName: typeName === 'INGESTION' ? 'ingest-model' : 'process-model' }],
  });
  mockS3Client(t, async () => null);

  await generateTestsVars(outputPath);

  const written = yaml.load(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(written.length, 1);
  assert.equal(written[0].vars.bucket.sourceBucketId, 31804);
  assert.equal(written[0].vars.bucket.newClaim.ingestionModelId, 1);
  assert.equal(written[0].vars.bucket.newClaim.processingModelId, 9);
});

test('generateTestsVars output file starts with a do-not-edit header', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tests-vars-'));
  const outputPath = path.join(tmpDir, 'tests.vars.yaml');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  process.env.SOURCE_BUCKET_ID = '31804';
  process.env.CLAIM_NAME = 'my-run';
  process.env.INGESTION_MODEL_NAME = 'ingest-model';
  process.env.PROCESSING_MODEL_NAME = 'process-model';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
    delete process.env.SOURCE_BUCKET_ID;
    delete process.env.CLAIM_NAME;
    delete process.env.INGESTION_MODEL_NAME;
    delete process.env.PROCESSING_MODEL_NAME;
  });
  mockFraudxClient(t, {
    login: async () => ({ token: 't', orgId: 1, userId: 1 }),
    getBucketDetails: async () => ({ bucketStatus: 'SUCCESS', latestReportId: 'report-1', claimCategoryId: 23, tags: [] }),
    fetchReport: async () => ({
      summary: 's', fraudRiskScore: 0.5, claimantName: 'a', defendant: 'b', insuranceFirm: 'c',
      questions: [{ predefinedQuestionId: 1, question: 'Q?', answer: 'A', riskStatus: 'UNSURE' }],
    }),
    searchModels: async (base, auth, typeName) => [{ id: 1, displayName: typeName === 'INGESTION' ? 'ingest-model' : 'process-model' }],
  });
  mockS3Client(t, async () => null);

  await generateTestsVars(outputPath);

  const contents = fs.readFileSync(outputPath, 'utf8');
  assert.match(contents, /^# GENERATED FILE/);
});

test('generateTestsVars throws a clear error when SOURCE_BUCKET_ID is not set', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  delete process.env.SOURCE_BUCKET_ID;
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  await assert.rejects(() => generateTestsVars('/tmp/unused.yaml'), /SOURCE_BUCKET_ID must be set/);
});
```

Note: `resolveModelId` is called twice by `generateTestsVars` (once per model type) and internally calls `fraudxClient.searchModels` — mock `searchModels` directly (as shown above) rather than `resolveModelId` itself, since `resolveModelId` is a thin pure wrapper already covered by its own test file (`src/lib/resolve-model-id.test.js`, unchanged by this plan).

- [ ] **Step 2: Run and verify all fail**

Run: `node --test scripts/build-tests-vars.test.js`
Expected: fails with `Cannot find module './build-tests-vars'` (the file doesn't exist yet).

- [ ] **Step 3: Implement**

Create `scripts/build-tests-vars.js` exactly as specified in
`docs/superpowers/specs/2026-08-18-bucket-driven-baseline-design.md`'s "New
script: `scripts/build-tests-vars.js`" section (the full file is given
there verbatim, already checked against every real function signature it
calls).

- [ ] **Step 4: Run and verify all pass**

Run: `node --test scripts/build-tests-vars.test.js`
Expected: all tests PASS.

Run: `npm test` (this new file isn't wired into the `test` npm script yet — Task 4 does that; for now run it directly as shown above).

- [ ] **Step 5: Commit**

```bash
git add scripts/build-tests-vars.js scripts/build-tests-vars.test.js
git commit -m "feat: add scripts/build-tests-vars.js to fetch a live existing-bucket baseline"
```

---

### Task 3: Delete the old claims.json pipeline

**Files:**
- Delete: `claimsdata/claims.json`, `claimsdata/` directory
- Delete: `scripts/apply-claim-config.js`, `scripts/apply-claim-config.test.js`
- Delete: `scripts/generate-tests-vars.js`, `scripts/generate-tests-vars.test.js`

- [ ] **Step 1: Confirm nothing else references the files being deleted**

Run: `grep -rln "apply-claim-config\|generate-tests-vars\|claimsdata" --include="*.js" --include="*.json" --include="*.yaml" --include="*.yml" . | grep -v node_modules`
Expected output: only `package.json` (fixed in Task 4), `.env.example`/`README.md`/`.gitignore` (fixed in Tasks 6/8), and the files about to be deleted themselves. If anything else shows up, stop and investigate before deleting.

- [ ] **Step 2: Delete**

```bash
git rm claimsdata/claims.json
rmdir claimsdata
git rm scripts/apply-claim-config.js scripts/apply-claim-config.test.js
git rm scripts/generate-tests-vars.js scripts/generate-tests-vars.test.js
```

- [ ] **Step 3: Verify the suite doesn't reference the deleted test files**

Run: `grep -n "apply-claim-config\|generate-tests-vars" package.json`
Expected: matches only in the `test`/`generate:tests`/`preeval` script strings — fixed in Task 4, not yet. Do not run `npm test` yet; it will fail on missing files until Task 4 rewrites the `test` script. This is expected and reverted by the very next task, not a regression to chase down here.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: delete claims.json and its apply-claim-config/generate-tests-vars pipeline"
```

---

### Task 4: Update `package.json` and fix a stray reference to the deleted pipeline

**Plan amendment (discovered during Task 3's execution, not caught by pre-flight review):**
`src/lib/qa-match-assertion.test.js` has one integration test,
`'qaMatchAssertion correctly reads expectedChunkText when vars are built by
the real generate-tests-vars.js pipeline, not hand-authored'`, that does
`require('../../scripts/generate-tests-vars')` — a cross-seam regression
guard (same spirit as `provider.test.js`'s `'a lookup keyed by s3-client.js
chunkKey resolves end-to-end in qa-match-assertion.js'` test) verifying
`qa-match-assertion.js` correctly consumes vars built by the *real* pipeline,
not just hand-typed fixtures. Task 3 deleted `generate-tests-vars.js`, so
this test now fails with `Cannot find module`. This step rewrites it against
`scripts/build-tests-vars.js`'s new functions/shape instead of deleting it —
the cross-module contract it guards still matters.

**Files:**
- Modify: `package.json`
- Modify: `src/lib/qa-match-assertion.test.js`

- [ ] **Step 0: Rewrite the stale cross-pipeline test**

Replace (starting at the line matching
`test('qaMatchAssertion correctly reads expectedChunkText when vars are built by the real generate-tests-vars.js pipeline, not hand-authored', async (t) => {`
through its closing `});`):

```js
test('qaMatchAssertion correctly reads expectedChunkText when vars are built by the real build-tests-vars.js pipeline, not hand-authored', async (t) => {
  const { buildTestsVars, buildExpectedQa } = require('../../scripts/build-tests-vars');
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const existingReport = {
    summary: 'S',
    fraudRiskScore: 0.5,
    claimantName: 'X',
    defendant: 'Y',
    insuranceFirm: 'Z',
    questions: [
      { predefinedQuestionId: 1, question: 'Q1?', answer: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>', riskStatus: 'RISK_DETECTED' },
    ],
  };
  const existingGroundingData = new Map([['doc-1:chunk-1', 'gold passage text']]);
  const expectedQa = buildExpectedQa(existingReport.questions, existingGroundingData);
  const [{ vars }] = buildTestsVars({
    sourceBucketId: 1, claimCategoryId: 1, tags: undefined, newClaimName: 'x',
    ingestionModelId: 1, processingModelId: 9, existingReport, expectedQa,
  });
  const context = { vars, test: { assert: [{ metric: 'qa_match' }], options: {} } };
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 1, question: 'Q1?', riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>' },
      ],
    },
    chunkGroundingData: new Map([['doc-1:chunk-1', 'gold passage text']]),
  };

  const result = await qaMatchAssertion(output, context);

  assert.equal(result.namedScores.citationMatch, 1);
  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
});
```

Run: `node --test src/lib/qa-match-assertion.test.js`
Expected: this test PASSES, and every other test in the file is unaffected.

- [ ] **Step 1: Edit the scripts block**

Replace:

```json
"pretest": "npm run generate:tests",
"test": "node --test src/provider.test.js src/s3-client.test.js src/fraudx-client.test.js config-shape.test.js src/lib/qa-match-assertion.test.js src/lib/metadata-match-assertion.test.js src/lib/extract-cited-file-names.test.js src/lib/resolve-model-id.test.js scripts/score-dashboard.test.js scripts/generate-pdf-report.test.js scripts/generate-tests-vars.test.js scripts/apply-claim-config.test.js",
"generate:tests": "node scripts/generate-tests-vars.js",
"preeval": "node scripts/apply-claim-config.js && npm run generate:tests",
```

with:

```json
"pretest": "",
"test": "node --test src/provider.test.js src/s3-client.test.js src/fraudx-client.test.js config-shape.test.js src/lib/qa-match-assertion.test.js src/lib/metadata-match-assertion.test.js src/lib/extract-cited-file-names.test.js src/lib/resolve-model-id.test.js scripts/score-dashboard.test.js scripts/generate-pdf-report.test.js scripts/build-tests-vars.test.js",
"generate:tests": "node scripts/build-tests-vars.js",
"preeval": "npm run generate:tests",
```

(Exact double-quoting/formatting must match this file's existing 2-space-indent JSON style — use the Edit tool, not a full rewrite, to avoid an unrelated reformat diff.)

- [ ] **Step 2: Verify**

Run: `npm test`
Expected: fails — `config-shape.test.js` still tries to read `tests.vars.yaml` from disk at module scope, which no longer exists (Task 3 deleted the pipeline that used to generate it offline, and `pretest` no longer regenerates it). This is the expected, known-broken intermediate state; Task 5 fixes it. Confirm the failure is specifically about `config-shape.test.js` / missing `tests.vars.yaml`, not something else — if anything else fails, stop and investigate.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: decouple tests.vars.yaml generation from pretest, point generate:tests at build-tests-vars.js"
```

---

### Task 5: Narrow `config-shape.test.js`

**Files:**
- Modify: `config-shape.test.js`

**Interfaces:**
- Consumes: nothing new — reads `promptfooconfig.yaml` only (no longer `tests.vars.yaml`).

- [ ] **Step 1: Read the current file and identify what to remove**

The following move out entirely (their coverage is already in Task 2's `scripts/build-tests-vars.test.js`, which unit-tests `buildTestsVars`/`buildExpectedQa` directly against fake data, without touching the filesystem):
- The module-scope `const testsVarsPath = ...` / `const testCases = yaml.load(fs.readFileSync(testsVarsPath, 'utf8'));` block.
- `'tests.vars.yaml declares one test case per golden claim bucket fixture'`
- `'every test case\'s vars.bucket has a sourceBucketId and a newClaim config'`
- `'every test case\'s vars.expected has a summary and at least one predefined-question entry'`

Everything else (the `config.providers`/`config.defaultTest.options.provider`/`config.tests`/`config.defaultTest.assert` tests) stays, unchanged.

- [ ] **Step 2: Edit**

Remove the `testsVarsPath`/`testCases` module-scope block and the three tests listed above. Leave the remaining tests exactly as they are (their content already targets `src/provider.js`/`src/lib/qa-match-assertion.js`/`src/lib/metadata-match-assertion.js` paths correctly, from the earlier `src/` restructuring).

- [ ] **Step 3: Run and verify**

Run: `npm test`
Expected: fails — Task 4 already pointed `generate:tests` at `scripts/build-tests-vars.js`, which requires live FraudX credentials/`SOURCE_BUCKET_ID` that aren't set for plain `npm test`. But `config-shape.test.js` no longer needs `tests.vars.yaml` to exist, so if this specific file's tests still fail, something in this task is wrong — investigate. The suite as a whole may still show other unrelated failures at this point only if something upstream is broken; if `config-shape.test.js`'s own tests pass in isolation, this task is done correctly:

Run: `node --test config-shape.test.js`
Expected: all remaining tests PASS, without `tests.vars.yaml` existing on disk at all (verify: `rm -f tests.vars.yaml` first, then run).

- [ ] **Step 4: Commit**

```bash
git add config-shape.test.js
git commit -m "test: stop reading tests.vars.yaml from disk in config-shape.test.js"
```

---

### Task 6: `.env.example` additions and cleanup

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Edit**

Add, near the other required-for-`npm run eval` vars:

```
# Required for `npm run eval`. The id of an existing, already-processed bucket
# whose own report becomes the ground truth this run is validated against.
SOURCE_BUCKET_ID=
```

Replace the comment above `CLAIM_NAME=` (which currently references
`testdata/claims.json` — stale from an earlier rename this project already
did — and describes the now-deleted `apply-claim-config.js`/claims.json
mutation flow):

```
# Required for `npm run eval`. A claim name can't be reused on the real
# platform, and the ingestion/processing model is a per-run choice — all three
# are resolved live by scripts/build-tests-vars.js (run automatically via the
# preeval hook), which fails fast with a clear error if any is blank.
CLAIM_NAME=
```

- [ ] **Step 2: Verify**

Run: `grep -n "testdata\|claimsdata\|apply-claim-config" .env.example`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs: add SOURCE_BUCKET_ID to .env.example, remove stale claims.json framing"
```

---

### Task 7: `.github/workflows/eval-workflow.yml`

**Files:**
- Modify: `.github/workflows/eval-workflow.yml`

- [ ] **Step 1: Add the new workflow input**

In `workflow_dispatch.inputs`, add alongside `newClaimName`:

```yaml
      sourceBucketId:
        description: 'Existing, already-processed bucket id to validate against'
        required: true
        type: string
        default: ''
```

- [ ] **Step 2: Map it to an env var**

In the `full-eval` job's `env:` block, add alongside `CLAIM_NAME`:

```yaml
      SOURCE_BUCKET_ID: ${{ inputs.sourceBucketId }}
```

- [ ] **Step 3: Verify**

Run: `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/eval-workflow.yml', 'utf8')); console.log('valid yaml')"`
Expected: prints `valid yaml` with no error.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/eval-workflow.yml
git commit -m "ci: add sourceBucketId workflow input, map to SOURCE_BUCKET_ID"
```

---

### Task 8: Update the mock server for local dry runs

**Files:**
- Modify: `test/mock-server.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `list-buckets` responses that vary by which `bucketId` was queried (the existing/source bucket vs. the freshly-created one), plus a `fetchReport` response with a realistic `questions[]`/entity-field shape for the *existing* bucket's report.

- [ ] **Step 1: Read the current mock server's `list-buckets` and report-fetch handlers**

Find the current `POST /fraudx/api/v1/gx-bucket/list-buckets` handler (currently returns one fixed `{ bucketId: 99999, bucketStatus: 'SUCCESS', latestReportId: 'mock-report-id' }` regardless of query) and the report-fetch handler (`GET /fraudx/api/v1/dashboard/reports/:reportId` or similar — check the actual route).

- [ ] **Step 2: Make `list-buckets` respond differently for the source bucket vs. the new bucket**

The request body's `criteria` array contains `{ column: 'bucketId', operator: 'IN', values: [String(bucketId)] }` — inspect `values[0]` to decide which canned bucket to return:
- Source bucket (matches `process.env.SOURCE_BUCKET_ID` or a fixed mock value like `'31804'` if that env var isn't threaded into the mock server process): return `{ bucketId: 31804, bucketStatus: 'SUCCESS', latestReportId: 'mock-existing-report-id', claimCategoryId: 23, tags: [{ tagId: 3, tagKey: 'Client Update', tagStatus: 'ACTIVE', mandatory: true, tagValueId: 17, value: 'Test B' }] }`.
- New bucket (the freshly-created `bucketId`, e.g. `99999` as today): keep the existing behavior (`bucketStatus: 'SUCCESS', latestReportId: 'mock-report-id'`).

- [ ] **Step 3: Make the report-fetch handler return different data per `reportId`**

`mock-existing-report-id` → a realistic existing report: `{ summary: 'Mock existing claim summary.', fraudRiskScore: 0.5, claimantName: 'Mock Claimant', defendant: 'Mock Defendant', insuranceFirm: 'Mock Insurance', questions: [{ predefinedQuestionId: 1, question: 'Mock question?', answer: 'Mock existing answer.', riskStatus: 'UNSURE' }] }`.
`mock-report-id` → keep today's existing fresh-report response unchanged.

- [ ] **Step 4: Verify manually**

Run: `SOURCE_BUCKET_ID=31804 npm run mock-server` in one terminal, then in another:
```bash
curl -s -X POST http://localhost:4001/fraudx/api/v1/gx-bucket/list-buckets \
  -H 'Content-Type: application/json' \
  -d '{"criteria":[{"column":"bucketId","operator":"IN","values":["31804"]}]}'
```
Expected: response includes `claimCategoryId: 23` and a non-empty `tags` array.

- [ ] **Step 5: Commit**

```bash
git add test/mock-server.js
git commit -m "test: mock server returns existing-bucket-shaped data for the bucket-driven dry run"
```

---

### Task 9: README updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Remove the claims.json framing**

Search for and rewrite every mention of `claimsdata/claims.json`, "golden claim(s)", "hand-curated", and `scripts/apply-claim-config.js`/`scripts/generate-tests-vars.js` to instead describe: a single `SOURCE_BUCKET_ID` input identifying an existing, already-processed bucket; `scripts/build-tests-vars.js` fetching that bucket's own report live and using it as the comparison target; the regression-check framing ("validated against the existing bucket's own report", not "hand-curated golden answers").

- [ ] **Step 2: Update the mock-server walkthrough**

The "Trying it locally without hitting real infra" section's example command needs a `SOURCE_BUCKET_ID` alongside the existing `CLAIM_NAME`/`INGESTION_MODEL_NAME`/`PROCESSING_MODEL_NAME`/`SKIP_S3_GROUNDING`:

```bash
npm run mock-server                        # terminal 1 — leave running
SOURCE_BUCKET_ID=31804 \
  FRAUDX_ENDPOINT_URI=http://localhost:4001 FRAUDX_LOGIN_EMAIL=mock@example.com FRAUDX_LOGIN_PASSWORD=mock \
  CLAIM_NAME=mock-claim INGESTION_MODEL_NAME=mock-ingestion-model PROCESSING_MODEL_NAME=mock-processing-model \
  SKIP_S3_GROUNDING=true \
  npm run eval   # terminal 2
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe the bucket-driven baseline in the README"
```

---

### Task 10: Full verification

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: all tests pass, with no reference anywhere to `claimsdata/`, `apply-claim-config`, or `generate-tests-vars.js`.

- [ ] **Step 2: Dry run against the mock server**

```bash
npm run mock-server &
sleep 1
SOURCE_BUCKET_ID=31804 FRAUDX_ENDPOINT_URI=http://localhost:4001 FRAUDX_LOGIN_EMAIL=mock@example.com FRAUDX_LOGIN_PASSWORD=mock \
  CLAIM_NAME=mock-claim-dryrun INGESTION_MODEL_NAME=mock-ingestion-model PROCESSING_MODEL_NAME=mock-processing-model \
  SKIP_S3_GROUNDING=true \
  npm run eval
kill %1
```
Expected: `preeval` fetches the mock existing bucket successfully, `tests.vars.yaml` is generated with the mock existing report's data as `expected`, the eval runs end to end, and `results.json`/a PDF report are produced. Revert any incidental mutation to tracked files this dry run causes (none expected now that `claims.json` no longer exists to mutate).

- [ ] **Step 3: Commit any final fixups, otherwise this plan is complete**
