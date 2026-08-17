# S3 Chunk-Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the whole-PDF-download approach to `citedDocumentsText` with a direct lookup into FraudX's per-claim S3 grounding file, and replace the shipped fileName-based `citationMatch` check with a chunk-text semantic comparison against a curated `expectedChunkText`, since neither `documentId` nor `chunkId` is stable across re-ingestion runs.

**Architecture:** A new `s3-client.js` fetches `fraudx-qa-claim-processor/{bucketId}.json` and builds a `(documentId, chunkId) → chunk_text` lookup. `provider.js` uses it to build `citedDocumentsText` and exposes the raw lookup as `output.chunkGroundingData`. `qa-match-assertion.js` reuses that same lookup (no second S3 fetch) to semantically compare each question's actually-cited chunk text against a curated `expectedChunkText` in `testdata/claims.json`, via one extra grader-provider call per graded question.

**Tech Stack:** Node.js (`node:test`), `@aws-sdk/client-s3` (new dependency), existing `promptfoo` grader-provider abstraction.

## Global Constraints

- Node engines: `>=20.16.0 <21 || >=22.3.0` (from `package.json`, unchanged).
- Every code change follows TDD: write/update the failing test first, run it and confirm it fails for the expected reason, then write the minimal implementation, then confirm green.
- No fallback to the old whole-PDF-download approach for cited-document text — if a citation's `(documentId, chunkId)` isn't in the S3 grounding file, skip it silently (same policy the current code already applies to unmatched fileNames).
- No dead code left behind: when a function's only production callers are removed by this plan, delete the function and its tests too (matches this repo's established convention — see `extractCitedFileNames`, `formatRiskStatus`, `stripRiskStatusPrefix` already removed this way in recent commits).
- The S3 bucket name (`fraudx-qa-claim-processor`) is a hardcoded constant, not configurable per environment.
- Re-authoring the 21 (of 35) golden questions' citation data from `expectedCitedFileNames` to real `expectedChunkText` passages is explicit curation work requiring the real S3 data for that claim — **out of scope for this plan**. This plan only strips the now-meaningless `expectedCitedFileNames` field; it does not fabricate `expectedChunkText` values.
- `riskStatusMatch` and `citationMatch` are already excluded from `computeAccuracy`'s formula (shipped separately) — this plan does not touch `score-dashboard.js`.

---

### Task 1: S3 chunk-grounding client + config

**Files:**
- Create: `s3-client.js`
- Create: `s3-client.test.js`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `.github/workflows/eval-workflow.yml`

**Interfaces:**
- Produces: `fetchChunkGroundingData(bucketId, timeoutMs) => Promise<Map<string, string> | null>` — key format `` `${documentId}:${chunkId}` ``, value is the chunk's raw text. Returns `null` if the S3 object doesn't exist. Throws on any other S3 error, or if the object's body isn't valid JSON, or lacks a `questionnaire` array.

- [ ] **Step 1: Install the AWS SDK S3 client dependency**

```bash
npm install @aws-sdk/client-s3
```

- [ ] **Step 2: Write the failing tests**

Create `s3-client.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { S3Client } = require('@aws-sdk/client-s3');
const { fetchChunkGroundingData } = require('./s3-client');

// S3Client.prototype.send is mocked directly (like fraudx-client.js's module
// functions are mocked in provider.test.js) rather than hitting real AWS —
// this file runs in its own process under node:test, so mutating the
// prototype here never leaks into other test files.
function mockSend(t, impl) {
  const original = S3Client.prototype.send;
  S3Client.prototype.send = impl;
  t.after(() => {
    S3Client.prototype.send = original;
  });
}

function bodyOf(jsonOrString) {
  const text = typeof jsonOrString === 'string' ? jsonOrString : JSON.stringify(jsonOrString);
  return { Body: { transformToString: async () => text } };
}

test('fetchChunkGroundingData returns a lookup keyed by documentId:chunkId', async (t) => {
  mockSend(t, async () => bodyOf({
    questionnaire: [
      {
        question_id: 1,
        source_ref: [
          { document: { document_uuid: 'doc-1', chunk_uuid: 'chunk-1' }, chunk_text: 'Text A' },
          { document: { document_uuid: 'doc-2', chunk_uuid: 'chunk-2' }, chunk_text: 'Text B' },
        ],
      },
    ],
  }));

  const lookup = await fetchChunkGroundingData(12345, 5000);

  assert.equal(lookup.get('doc-1:chunk-1'), 'Text A');
  assert.equal(lookup.get('doc-2:chunk-2'), 'Text B');
});

test('fetchChunkGroundingData flattens source_ref entries across every question in the file', async (t) => {
  mockSend(t, async () => bodyOf({
    questionnaire: [
      { question_id: 1, source_ref: [{ document: { document_uuid: 'd1', chunk_uuid: 'c1' }, chunk_text: 'From Q1' }] },
      { question_id: 2, source_ref: [{ document: { document_uuid: 'd2', chunk_uuid: 'c2' }, chunk_text: 'From Q2' }] },
    ],
  }));

  const lookup = await fetchChunkGroundingData(12345, 5000);

  assert.equal(lookup.get('d1:c1'), 'From Q1');
  assert.equal(lookup.get('d2:c2'), 'From Q2');
});

test('fetchChunkGroundingData skips a source_ref entry missing document_uuid or chunk_uuid', async (t) => {
  mockSend(t, async () => bodyOf({
    questionnaire: [
      {
        question_id: 1,
        source_ref: [
          { document: { document_uuid: 'd1' }, chunk_text: 'missing chunk_uuid' },
          { document: { chunk_uuid: 'c1' }, chunk_text: 'missing document_uuid' },
          { document: { document_uuid: 'd2', chunk_uuid: 'c2' }, chunk_text: 'valid' },
        ],
      },
    ],
  }));

  const lookup = await fetchChunkGroundingData(12345, 5000);

  assert.equal(lookup.size, 1);
  assert.equal(lookup.get('d2:c2'), 'valid');
});

test('fetchChunkGroundingData returns null when the object does not exist (NoSuchKey)', async (t) => {
  mockSend(t, async () => {
    const err = new Error('The specified key does not exist.');
    err.name = 'NoSuchKey';
    throw err;
  });

  const lookup = await fetchChunkGroundingData(99999, 5000);

  assert.equal(lookup, null);
});

test('fetchChunkGroundingData propagates non-NoSuchKey S3 errors', async (t) => {
  mockSend(t, async () => {
    throw new Error('AccessDenied: insufficient permissions');
  });

  await assert.rejects(() => fetchChunkGroundingData(12345, 5000), /AccessDenied/);
});

test('fetchChunkGroundingData throws when the object body is not valid JSON', async (t) => {
  mockSend(t, async () => bodyOf('not json at all'));

  await assert.rejects(() => fetchChunkGroundingData(12345, 5000), /not valid JSON/);
});

test('fetchChunkGroundingData throws when the parsed JSON has no questionnaire array', async (t) => {
  mockSend(t, async () => bodyOf({ notQuestionnaire: [] }));

  await assert.rejects(() => fetchChunkGroundingData(12345, 5000), /missing a "questionnaire" array/);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test s3-client.test.js`
Expected: FAIL — `Cannot find module './s3-client'` (the file doesn't exist yet).

- [ ] **Step 4: Write the minimal implementation**

Create `s3-client.js`:

```js
'use strict';

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const BUCKET_NAME = 'fraudx-qa-claim-processor';

function buildGroundingLookup(parsed, bucketId) {
  const questionnaire = parsed && parsed.questionnaire;
  if (!Array.isArray(questionnaire)) {
    throw new Error(`Chunk grounding file for bucketId ${bucketId} is missing a "questionnaire" array`);
  }
  const lookup = new Map();
  for (const entry of questionnaire) {
    const sourceRefs = Array.isArray(entry.source_ref) ? entry.source_ref : [];
    for (const ref of sourceRefs) {
      const doc = ref.document || {};
      if (!doc.document_uuid || !doc.chunk_uuid) {
        continue;
      }
      lookup.set(`${doc.document_uuid}:${doc.chunk_uuid}`, ref.chunk_text);
    }
  }
  return lookup;
}

// Reads FraudX's per-claim chunk-grounding file from S3 — a separate artifact
// from the FraudX API itself, containing the exact verbatim chunk text behind
// every citation the real report can make, keyed by (documentId, chunkId)
// pairs that are stable within this one file (unlike documentId/chunkId
// embedded in citation tags, which are per-ingestion and change every run —
// the file itself is regenerated fresh each run too, so this lookup is always
// built from the same run's own data).
async function fetchChunkGroundingData(bucketId, timeoutMs) {
  const client = new S3Client({});
  let response;
  try {
    response = await client.send(
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: `${bucketId}.json` }),
      { abortSignal: AbortSignal.timeout(timeoutMs) }
    );
  } catch (err) {
    if (err.name === 'NoSuchKey') {
      return null;
    }
    throw err;
  }
  const body = await response.Body.transformToString();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new Error(`Chunk grounding file for bucketId ${bucketId} is not valid JSON: ${err.message}`);
  }
  return buildGroundingLookup(parsed, bucketId);
}

module.exports = { fetchChunkGroundingData };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test s3-client.test.js`
Expected: PASS — all 7 tests green.

- [ ] **Step 6: Register the new test file and dependency in `package.json`**

In `package.json`, add `s3-client.test.js` to the `test` script (append to the existing space-separated list, e.g. right after `provider.test.js`):

```json
"test": "node --test provider.test.js s3-client.test.js config-shape.test.js scripts/score-dashboard.test.js scripts/qa-match-assertion.test.js scripts/metadata-match-assertion.test.js scripts/generate-pdf-report.test.js fraudx-client.test.js scripts/generate-tests-vars.test.js scripts/resolve-model-id.test.js scripts/apply-claim-config.test.js",
```

`npm install` in Step 1 already added `@aws-sdk/client-s3` to `dependencies` — verify it's there:

```bash
grep '"@aws-sdk/client-s3"' package.json
```

Expected: prints the dependency line.

- [ ] **Step 7: Add the three new env vars to `.env.example`**

In `.env.example`, add after the existing `GRADER_PROVIDER` block (before the `CLAIM_NAME` section):

```
# Credentials for reading the fraudx-qa-claim-processor S3 bucket (chunk-grounding
# data for citations) — separate from the FraudX gateway credentials above.
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=
```

- [ ] **Step 8: Add the same three env vars to the GitHub Actions workflow**

In `.github/workflows/eval-workflow.yml`, add to the `full-eval` job's `env:` block (after `OPENAI_API_KEY`):

```yaml
      AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
      AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
      AWS_REGION: ${{ secrets.AWS_REGION }}
```

- [ ] **Step 9: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: PASS — all tests green (count will be the prior total + 7).

- [ ] **Step 10: Commit**

```bash
git add s3-client.js s3-client.test.js package.json package-lock.json .env.example .github/workflows/eval-workflow.yml
git commit -m "$(cat <<'EOF'
feat: add S3 client for FraudX's per-claim chunk-grounding file

Reads fraudx-qa-claim-processor/{bucketId}.json and builds a
(documentId, chunkId) -> chunk_text lookup — the exact verbatim source
text behind every citation the real report can make, replacing the
need to re-download and OCR whole original PDFs.
EOF
)"
```

---

### Task 2: Citation extraction — capture documentId + chunkId

**Files:**
- Modify: `scripts/extract-cited-file-names.js`
- Modify: `scripts/extract-cited-file-names.test.js`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `extractCitedCitationsFromText(text) => Array<{fileName: string, documentId: string, chunkId: string}>`, deduplicated by `(documentId, chunkId)` pair, in order of first appearance. Replaces `extractCitedFileNamesFromText`, which is deleted.

- [ ] **Step 1: Write the failing tests (full replacement of the file)**

Replace the entire contents of `scripts/extract-cited-file-names.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCitedCitationsFromText } = require('./extract-cited-file-names');

test('extractCitedCitationsFromText returns the decoded fileName, documentId, and chunkId from a single citation tag', () => {
  const text = 'see <InTextCitation fileName="JOSE%2BBRIONES.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>';
  assert.deepEqual(extractCitedCitationsFromText(text), [
    { fileName: 'JOSE+BRIONES.pdf', documentId: 'doc-1', chunkId: 'chunk-1' },
  ]);
});

test('extractCitedCitationsFromText does not dedupe two citations of the same file when their chunkId differs', () => {
  const text = [
    '<InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    '<InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-2"></InTextCitation>',
  ].join(' ');
  assert.deepEqual(extractCitedCitationsFromText(text), [
    { fileName: 'a.pdf', documentId: 'doc-1', chunkId: 'chunk-1' },
    { fileName: 'a.pdf', documentId: 'doc-1', chunkId: 'chunk-2' },
  ]);
});

test('extractCitedCitationsFromText dedupes repeated citations of the same (documentId, chunkId) pair, keeping first-appearance order', () => {
  const text = [
    '<InTextCitation fileName="b.pdf" documentId="doc-2" chunkId="chunk-2"></InTextCitation>',
    '<InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    '<InTextCitation fileName="b.pdf" documentId="doc-2" chunkId="chunk-2"></InTextCitation>',
  ].join(' ');
  assert.deepEqual(extractCitedCitationsFromText(text), [
    { fileName: 'b.pdf', documentId: 'doc-2', chunkId: 'chunk-2' },
    { fileName: 'a.pdf', documentId: 'doc-1', chunkId: 'chunk-1' },
  ]);
});

test('extractCitedCitationsFromText returns an empty array when there are no citation tags', () => {
  assert.deepEqual(extractCitedCitationsFromText('No sources found to answer this query!'), []);
});

test('extractCitedCitationsFromText returns an empty array for null, undefined, or empty-string input', () => {
  assert.deepEqual(extractCitedCitationsFromText(null), []);
  assert.deepEqual(extractCitedCitationsFromText(undefined), []);
  assert.deepEqual(extractCitedCitationsFromText(''), []);
});

test('extractCitedCitationsFromText skips a citation tag missing fileName, documentId, or chunkId', () => {
  const text = [
    '<InTextCitation documentId="doc-1" chunkId="chunk-1"></InTextCitation>', // no fileName
    '<InTextCitation fileName="b.pdf" chunkId="chunk-2"></InTextCitation>', // no documentId
    '<InTextCitation fileName="c.pdf" documentId="doc-3"></InTextCitation>', // no chunkId
    '<InTextCitation fileName="d.pdf" documentId="doc-4" chunkId="chunk-4"></InTextCitation>', // complete
  ].join(' ');
  assert.deepEqual(extractCitedCitationsFromText(text), [
    { fileName: 'd.pdf', documentId: 'doc-4', chunkId: 'chunk-4' },
  ]);
});

test('extractCitedCitationsFromText ignores every other tag attribute (url, fileType, sourceIndex, occurrenceIndex)', () => {
  const text = '<InTextCitation url="https://x" chunkId="chunk-1" fileName="report.pdf" fileType="pdf" documentId="doc-1" sourceIndex="1" occurrenceIndex="1"></InTextCitation>';
  assert.deepEqual(extractCitedCitationsFromText(text), [
    { fileName: 'report.pdf', documentId: 'doc-1', chunkId: 'chunk-1' },
  ]);
});

test('extractCitedCitationsFromText is reusable across multiple calls without leaking regex state', () => {
  const first = extractCitedCitationsFromText('<InTextCitation fileName="one.pdf" documentId="d1" chunkId="c1"></InTextCitation>');
  const second = extractCitedCitationsFromText('no citations here');
  const third = extractCitedCitationsFromText('<InTextCitation fileName="two.pdf" documentId="d2" chunkId="c2"></InTextCitation>');
  assert.deepEqual(first, [{ fileName: 'one.pdf', documentId: 'd1', chunkId: 'c1' }]);
  assert.deepEqual(second, []);
  assert.deepEqual(third, [{ fileName: 'two.pdf', documentId: 'd2', chunkId: 'c2' }]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/extract-cited-file-names.test.js`
Expected: FAIL — `extractCitedCitationsFromText is not a function` (or `undefined`), since the module still only exports `extractCitedFileNamesFromText`.

- [ ] **Step 3: Write the minimal implementation (full replacement of the file)**

Replace the entire contents of `scripts/extract-cited-file-names.js`:

```js
'use strict';

const TAG_REGEX = /<InTextCitation\b([^>]*)>/g;
const FILE_NAME_ATTR_REGEX = /fileName="([^"]*)"/;
const DOCUMENT_ID_ATTR_REGEX = /documentId="([^"]*)"/;
const CHUNK_ID_ATTR_REGEX = /chunkId="([^"]*)"/;

// Extracts fileName, documentId, and chunkId from every <InTextCitation ...>
// tag in a single answer's raw text, decodeURIComponent-ing fileName (the
// real report URL-encodes it, e.g. "JOSE%2BBRIONES...pdf" ->
// "JOSE+BRIONES...pdf"). Deduplicated by the (documentId, chunkId) pair, NOT
// by fileName alone — a single source document is commonly split into many
// distinct cited chunks, and documentId/chunkId together identify exactly
// which chunk was cited, which fileName alone cannot. Order of first
// appearance is preserved. A tag missing any of the three attributes is
// skipped entirely — a citation missing documentId or chunkId can't be
// looked up in the S3 chunk-grounding file, so it's useless downstream.
function extractCitedCitationsFromText(text) {
  if (!text) {
    return [];
  }
  const citations = [];
  const seen = new Set();
  TAG_REGEX.lastIndex = 0;
  let match;
  while ((match = TAG_REGEX.exec(text)) !== null) {
    const attrs = match[1];
    const fileNameMatch = FILE_NAME_ATTR_REGEX.exec(attrs);
    const documentIdMatch = DOCUMENT_ID_ATTR_REGEX.exec(attrs);
    const chunkIdMatch = CHUNK_ID_ATTR_REGEX.exec(attrs);
    if (!fileNameMatch || !documentIdMatch || !chunkIdMatch) {
      continue;
    }
    const fileName = decodeURIComponent(fileNameMatch[1]);
    const documentId = documentIdMatch[1];
    const chunkId = chunkIdMatch[1];
    const key = `${documentId}:${chunkId}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({ fileName, documentId, chunkId });
    }
  }
  return citations;
}

module.exports = { extractCitedCitationsFromText };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/extract-cited-file-names.test.js`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Confirm no other file still references the deleted function**

```bash
grep -rn "extractCitedFileNamesFromText" --include="*.js" . | grep -v node_modules
```

Expected: no output. (If anything prints, it will be fixed in Tasks 3 and 5, which update `provider.js`/`provider.test.js` and `scripts/qa-match-assertion.js`/`scripts/qa-match-assertion.test.js` — do not proceed past this check until this plan's later tasks account for every result.)

- [ ] **Step 6: Commit**

```bash
git add scripts/extract-cited-file-names.js scripts/extract-cited-file-names.test.js
git commit -m "$(cat <<'EOF'
feat: capture documentId and chunkId when extracting citations

Replaces extractCitedFileNamesFromText (fileName only) with
extractCitedCitationsFromText, which also captures documentId and
chunkId per citation — the keys needed to look up a citation's exact
grounding text in the S3 chunk-grounding file.
EOF
)"
```

---

### Task 3: `provider.js` — S3 lookup replaces whole-PDF download

**Files:**
- Modify: `provider.js`
- Modify: `provider.test.js`

**Interfaces:**
- Consumes: `fetchChunkGroundingData(bucketId, timeoutMs)` from Task 1 (`./s3-client`); `extractCitedCitationsFromText(text)` from Task 2 (`./scripts/extract-cited-file-names`).
- Produces: `output.citedDocumentsText` (unchanged shape: `{fileName: text}`, now populated from S3 chunk text instead of whole-PDF OCR); new `output.chunkGroundingData` (the raw `Map<string, string> | null` returned by `fetchChunkGroundingData`), consumed by Task 5.

- [ ] **Step 1: Write the failing tests**

In `provider.test.js`, add the `s3Client` require near the top (after the existing `fraudxClient`/`Provider` requires) and remove the now-dead `extractCitedFileNames` import:

```js
const fraudxClient = require('./fraudx-client');
const s3Client = require('./s3-client');
const Provider = require('./provider');
```

(Delete the line `const { extractCitedFileNames } = Provider;` — that export is being removed.)

Add a file-level default mock for `s3Client.fetchChunkGroundingData` right after `mockFraudxClient`'s definition, plus a matching `mockS3Client` helper tests can use to override it per-test:

```js
// Every callApi() call now unconditionally calls s3Client.fetchChunkGroundingData once
// it has a report. Default to "no grounding file" for every test in this file except
// the ones below that explicitly need real grounding data — this file runs in its own
// process under node:test, so this module-wide default doesn't leak to other test files.
s3Client.fetchChunkGroundingData = async () => null;

function mockS3Client(t, impl) {
  s3Client.fetchChunkGroundingData = impl;
  t.after(() => {
    s3Client.fetchChunkGroundingData = async () => null; // restore to this file's default, not the real implementation
  });
}
```

Delete these two tests entirely (the function they test, `extractCitedFileNames`, is being removed from `provider.js`):

```js
test('extractCitedFileNames collects unique, decoded fileNames from every answer\'s citations', () => {
  ...
});

test('extractCitedFileNames returns an empty array when no answers have citations', () => {
  ...
});
```

Replace the test `'callApi fetches text only for documents actually cited in the real report, truncated to 15000 chars'` entirely with:

```js
test('callApi fetches grounding text only for citations that resolve in the S3 chunk-grounding file, truncated to 15000 chars', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  mockFraudxClient(t, {
    ...happyPathMocks([]),
    fetchReport: async () => ({
      reportId: 'report-1',
      summary: 's',
      bucketId: 32023,
      questions: [{
        predefinedQuestionId: 1,
        answer: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
      }],
    }),
  });
  mockS3Client(t, async () => new Map([['doc-1:chunk-1', 'x'.repeat(20000)]]));

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.equal(result.output.citedDocumentsText['a.pdf'].length, 15000, 'document text must be truncated to the char limit');
  assert.equal(Object.keys(result.output.citedDocumentsText).length, 1);
});
```

Replace the test `'callApi skips a cited fileName it cannot match to a source document, without failing the run'` entirely with:

```js
test('callApi skips a citation whose (documentId, chunkId) isn\'t in the grounding file, without failing the run', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  mockFraudxClient(t, {
    ...happyPathMocks([]),
    fetchReport: async () => ({
      reportId: 'report-1',
      summary: 's',
      bucketId: 32023,
      questions: [{
        predefinedQuestionId: 1,
        answer: 'see <InTextCitation fileName="unknown.pdf" documentId="doc-x" chunkId="chunk-x"></InTextCitation>',
      }],
    }),
  });
  mockS3Client(t, async () => new Map()); // grounding file exists but has nothing for this citation

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.deepEqual(result.output.citedDocumentsText, {});
});
```

Leave `'callApi returns an empty citedDocumentsText when the report has no citations'` as-is — it needs no changes (it already passes against the new default `null` grounding mock).

Add two new tests after it:

```js
test('callApi exposes the raw chunk-grounding lookup as output.chunkGroundingData', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  mockFraudxClient(t, happyPathMocks([]));
  const groundingMap = new Map([['doc-1:chunk-1', 'some text']]);
  mockS3Client(t, async () => groundingMap);

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.equal(result.output.chunkGroundingData, groundingMap);
});

test('callApi exposes output.chunkGroundingData as null when the grounding file is missing', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  mockFraudxClient(t, happyPathMocks([]));
  mockS3Client(t, async () => null);

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.equal(result.output.chunkGroundingData, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test provider.test.js`
Expected: FAIL — the two new/rewritten citation tests fail (`provider.js` still uses the old `sourceDocs`/`getDownloadUrl` path, so `citedDocumentsText` won't match), and `output.chunkGroundingData` is `undefined` in the two new exposure tests. The two deleted `extractCitedFileNames` tests are gone so they no longer run.

- [ ] **Step 3: Write the minimal implementation**

In `provider.js`, replace the top of the file (requires + the now-dead `extractCitedFileNames` function):

```js
'use strict';

const fraudxClient = require('./fraudx-client');
const s3Client = require('./s3-client');
const { extractCitedCitationsFromText } = require('./scripts/extract-cited-file-names');

const DOCUMENT_TEXT_CHAR_LIMIT = 15000;

class FraudXClaimProvider {
```

(Delete the entire `extractCitedFileNames(report) {...}` function and its later `module.exports.extractCitedFileNames = extractCitedFileNames;` line — both are removed.)

Replace the cited-document block (from `const citedFileNames = extractCitedFileNames(report);` through the `citedDocumentsText[fileName] = text.slice(...)` loop) with:

```js
    const citations = report.questions.flatMap((q) => extractCitedCitationsFromText(q.answer));
    const chunkGroundingData = await s3Client.fetchChunkGroundingData(report.bucketId, timeoutMs);
    const citedDocumentsText = {};
    if (chunkGroundingData) {
      const chunksByFileName = new Map();
      for (const { fileName, documentId, chunkId } of citations) {
        const chunkText = chunkGroundingData.get(`${documentId}:${chunkId}`);
        if (!chunkText) {
          continue; // not found in the grounding file — skip, no fallback
        }
        if (!chunksByFileName.has(fileName)) {
          chunksByFileName.set(fileName, []);
        }
        chunksByFileName.get(fileName).push(chunkText);
      }
      for (const [fileName, texts] of chunksByFileName) {
        citedDocumentsText[fileName] = texts.join('\n\n').slice(0, DOCUMENT_TEXT_CHAR_LIMIT);
      }
    }
```

And update the return statement to add `chunkGroundingData`:

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

The final `module.exports` block becomes just:

```js
module.exports = FraudXClaimProvider;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test provider.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Re-run the repo-wide grep from Task 2, Step 5**

```bash
grep -rn "extractCitedFileNamesFromText\|extractCitedFileNames\b" --include="*.js" . | grep -v node_modules
```

Expected: no output (both the old extractor and `provider.js`'s file-level union function are now fully gone).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add provider.js provider.test.js
git commit -m "$(cat <<'EOF'
feat: fetch cited-document text via S3 chunk grounding, not whole-PDF download

citedDocumentsText is now built by resolving each citation's
(documentId, chunkId) against the S3 chunk-grounding file instead of
re-downloading and OCR-ing the whole original source PDF — fixes
citations against GX-internal chunked filenames that never matched a
real source document under the old approach. The raw lookup is
exposed as output.chunkGroundingData for qa-match-assertion.js to
reuse without a second S3 fetch.
EOF
)"
```

---

### Task 4: Data model — `expectedChunkText` replaces `expectedCitedFileNames`

**Files:**
- Modify: `testdata/claims.json`
- Modify: `scripts/generate-tests-vars.js`
- Modify: `scripts/generate-tests-vars.test.js`

**Interfaces:**
- Produces: `context.vars.expected.qa[].expectedChunkText` (a `string` or `undefined`), consumed by Task 5's `qa-match-assertion.js`.

- [ ] **Step 1: Strip the stale `expectedCitedFileNames` field from `testdata/claims.json`**

This field carried fileName lists that don't carry enough information to derive a real `expectedChunkText` passage — re-authoring those 21 questions with real curated passages is separate, manual work (see Global Constraints). This step only removes the now-meaningless field.

```bash
node -e "
const fs = require('fs');
const path = 'testdata/claims.json';
const claims = JSON.parse(fs.readFileSync(path, 'utf8'));
for (const claim of claims) {
  for (const q of claim.questions) {
    delete q.expectedCitedFileNames;
  }
}
fs.writeFileSync(path, JSON.stringify(claims, null, 2) + '\n');
"
```

- [ ] **Step 2: Verify the field is gone**

```bash
grep -c expectedCitedFileNames testdata/claims.json
```

Expected: `0` (grep exits non-zero on no matches — that's expected here, not a failure).

- [ ] **Step 3: Write the failing tests**

In `scripts/generate-tests-vars.test.js`, update the expected shape in `'buildTestsVars maps a flat claim into promptfoo test-case shape'` — change:

```js
              expectedCitedFileNames: undefined,
```

to:

```js
              expectedChunkText: undefined,
```

Replace `'buildTestsVars passes expectedCitedFileNames through when a question sets it'` entirely with:

```js
test('buildTestsVars passes expectedChunkText through when a question sets it', () => {
  const claim = sampleClaim({
    questions: [
      {
        id: 1480,
        question: 'Q?',
        expectedAnswer: 'A.',
        expectedRiskStatus: 'RISK_DETECTED',
        expectedChunkText: 'The curated gold source passage for this question.',
      },
    ],
  });
  const result = buildTestsVars([claim]);
  assert.equal(
    result[0].vars.expected.qa[0].expectedChunkText,
    'The curated gold source passage for this question.'
  );
});
```

Replace `'generateTestsVars omits expectedCitedFileNames from the written YAML when a question does not set it'` entirely with:

```js
test('generateTestsVars omits expectedChunkText from the written YAML when a question does not set it', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-tests-vars-'));
  const claimsPath = path.join(tmpDir, 'claims.json');
  const outputPath = path.join(tmpDir, 'tests.vars.yaml');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  fs.writeFileSync(claimsPath, JSON.stringify([sampleClaim()])); // sampleClaim()'s question has no expectedChunkText
  generateTestsVars(claimsPath, outputPath);

  const written = yaml.load(fs.readFileSync(outputPath, 'utf8'));
  assert.equal('expectedChunkText' in written[0].vars.expected.qa[0], false);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test scripts/generate-tests-vars.test.js`
Expected: FAIL — 3 failures (the renamed-field assertion, and the two new tests, since `generate-tests-vars.js` still writes `expectedCitedFileNames`).

- [ ] **Step 5: Write the minimal implementation**

In `scripts/generate-tests-vars.js`, in `buildTestsVars`'s `qa:` mapping, change:

```js
          expectedCitedFileNames: q.expectedCitedFileNames,
```

to:

```js
          expectedChunkText: q.expectedChunkText,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test scripts/generate-tests-vars.test.js`
Expected: PASS.

- [ ] **Step 7: Regenerate `tests.vars.yaml` and run the full suite**

```bash
npm test
```

Expected: PASS (the `pretest` hook regenerates `tests.vars.yaml` from the now-cleaned `testdata/claims.json` automatically; `config-shape.test.js` doesn't assert on this field either way).

- [ ] **Step 8: Commit**

```bash
git add testdata/claims.json scripts/generate-tests-vars.js scripts/generate-tests-vars.test.js tests.vars.yaml
git commit -m "$(cat <<'EOF'
refactor: replace expectedCitedFileNames with expectedChunkText

expectedCitedFileNames (a fileName list) is superseded by
expectedChunkText (a single curated gold passage) — chunk/document IDs
aren't stable across re-ingestion runs, so the citation check moves
from "did it cite an allowed file" to "does the actually-cited passage
match this text", which doesn't depend on any ID being stable. Strips
the now-meaningless field from the 21 questions that had it; curating
real expectedChunkText passages is separate follow-up work.
EOF
)"
```

---

### Task 5: `qa-match-assertion.js` — chunk-text semantic citation matching

**Files:**
- Modify: `scripts/qa-match-assertion.js`
- Modify: `scripts/qa-match-assertion.test.js`

**Interfaces:**
- Consumes: `extractCitedCitationsFromText(text)` from Task 2; `output.chunkGroundingData` from Task 3; `q.expectedChunkText` from Task 4.
- Produces: `perQuestionBreakdown[].citationMatches` (boolean or `undefined`, same as before — external shape unchanged) and a new `perQuestionBreakdown[].citationMatchReason` (string or `undefined`) — consumed by Task 6's `generate-pdf-report.js`. `perQuestionBreakdown[].expectedCitedFileNames` is removed (nothing to carry — the question object no longer has that field).

- [ ] **Step 1: Write the failing tests**

In `scripts/qa-match-assertion.test.js`, update the exact-shape test `'qaMatchAssertion returns one perQuestionBreakdown entry per question'` — change the expected object:

```js
  assert.deepEqual(result.perQuestionBreakdown[0], {
    predefinedQuestionId: 1,
    question: 'Q1?',
    actualAnswer: 'ans1',
    riskStatus: 'RISK_DETECTED',
    riskStatusMatches: true,
    matches: true,
    reason: 'looks right',
    actualCitedFileNames: [],
    citationMatches: undefined,
    citationMatchReason: undefined,
  });
```

(This removes `expectedCitedFileNames: undefined` and adds `citationMatchReason: undefined`.)

Replace everything from `function fakeContextWithCitations() {` through the end of the file (all the citation-specific tests and their two fixture-builder functions) with:

```js
function fakeContextWithExpectedChunkText() {
  return {
    vars: {
      expected: {
        qa: [
          { predefinedQuestionId: 1, question: 'Q1?', expectedAnswerSummary: 'A1', expectedRiskStatus: 'RISK_DETECTED', expectedChunkText: 'The gold passage about attorney X.' },
          { predefinedQuestionId: 2, question: 'Q2?', expectedAnswerSummary: 'A2', expectedRiskStatus: 'UNSURE', expectedChunkText: 'The gold passage about provider Y.' },
          { predefinedQuestionId: 3, question: 'Q3?', expectedAnswerSummary: 'A3', expectedRiskStatus: 'RISK_DETECTED' }, // no expectedChunkText — not graded for citations
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
        { predefinedQuestionId: 1, riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>' },
        { predefinedQuestionId: 2, riskStatus: 'UNSURE', answer: 'see <InTextCitation fileName="b.pdf" documentId="doc-2" chunkId="chunk-2"></InTextCitation>' },
        { predefinedQuestionId: 3, riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="c.pdf" documentId="doc-3" chunkId="chunk-3"></InTextCitation>' }, // no expectedChunkText — excluded
      ],
    },
    chunkGroundingData: new Map([
      ['doc-1:chunk-1', 'The actual chunk text for attorney X, matching the gold passage.'],
      ['doc-2:chunk-2', 'A completely unrelated chunk about something else.'],
      ['doc-3:chunk-3', 'Text for question 3, irrelevant since ungraded.'],
    ]),
  };
}

// Distinguishes the per-question answer-content grading call (buildQuestionGradingPrompt)
// from the new chunk-text semantic-match call (buildChunkTextMatchPrompt) by prompt
// content, so a single mock can serve both call sites with different canned verdicts.
function isChunkTextMatchPrompt(prompt) {
  return prompt.includes('Expected source passage:');
}

test('qaMatchAssertion computes citationMatch via chunk-text semantic match using output.chunkGroundingData', async (t) => {
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      const matches = prompt.includes('attorney X');
      return { output: JSON.stringify({ matches, reason: matches ? 'Chunk supports the passage' : 'Chunk is unrelated' }) };
    }
    return { output: JSON.stringify({ matches: true, reason: 'answer content ok' }) };
  });

  const result = await qaMatchAssertion(fakeOutputWithCitations(), fakeContextWithExpectedChunkText());

  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
  assert.equal(result.perQuestionBreakdown[0].citationMatchReason, 'Chunk supports the passage');
  assert.equal(result.perQuestionBreakdown[1].citationMatches, false);
  assert.equal(result.perQuestionBreakdown[1].citationMatchReason, 'Chunk is unrelated');
  assert.equal(result.perQuestionBreakdown[2].citationMatches, undefined);
  assert.equal(result.namedScores.citationMatch, 0.5); // 1 of 2 graded questions matched
});

test('qaMatchAssertion treats citing any one of multiple chunks as a match, not requiring all of them', async (t) => {
  let chunkCallCount = 0;
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      chunkCallCount += 1;
      const matches = chunkCallCount === 2; // first cited chunk fails, second matches
      return { output: JSON.stringify({ matches, reason: matches ? 'second chunk matches' : 'first chunk does not match' }) };
    }
    return { output: JSON.stringify({ matches: true, reason: 'ok' }) };
  });

  const output = fakeOutputWithCitations();
  output.report.questions[0].answer = [
    'see <InTextCitation fileName="a1.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    'and <InTextCitation fileName="a2.pdf" documentId="doc-1" chunkId="chunk-2"></InTextCitation>',
  ].join(' ');
  output.chunkGroundingData.set('doc-1:chunk-1', 'first chunk text');
  output.chunkGroundingData.set('doc-1:chunk-2', 'second chunk text');

  const result = await qaMatchAssertion(output, fakeContextWithExpectedChunkText());

  assert.equal(chunkCallCount, 2, 'must check both cited chunks before concluding a match');
  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
  assert.equal(result.perQuestionBreakdown[0].citationMatchReason, 'second chunk matches');
});

test('qaMatchAssertion skips a citation whose (documentId, chunkId) is not in chunkGroundingData, without crashing', async (t) => {
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      throw new Error('grader must not be called for a citation that never resolved');
    }
    return { output: JSON.stringify({ matches: true, reason: 'ok' }) };
  });

  const output = fakeOutputWithCitations();
  output.report.questions[0].answer = 'see <InTextCitation fileName="missing.pdf" documentId="doc-x" chunkId="chunk-x"></InTextCitation>';
  // doc-x:chunk-x is deliberately absent from chunkGroundingData

  const result = await qaMatchAssertion(output, fakeContextWithExpectedChunkText());

  assert.equal(result.perQuestionBreakdown[0].citationMatches, false);
  assert.equal(
    result.perQuestionBreakdown[0].citationMatchReason,
    'No cited chunk resolved to compare against the expected passage.'
  );
});

test('qaMatchAssertion treats a null chunkGroundingData (missing S3 file) as every citation unresolved', async (t) => {
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      throw new Error('grader must not be called when chunkGroundingData is null');
    }
    return { output: JSON.stringify({ matches: true, reason: 'ok' }) };
  });

  const output = fakeOutputWithCitations();
  output.chunkGroundingData = null;

  const result = await qaMatchAssertion(output, fakeContextWithExpectedChunkText());

  assert.equal(result.perQuestionBreakdown[0].citationMatches, false);
  assert.equal(result.perQuestionBreakdown[1].citationMatches, false);
});

test('qaMatchAssertion sets namedScores.citationMatch to undefined when no question has expectedChunkText', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(result.namedScores.citationMatch, undefined);
  assert.equal('citationMatch' in result.namedScores, false);
  assert.ok(result.perQuestionBreakdown.every((v) => v.citationMatches === undefined));
  // falls back to the 2-signal average exactly as before this feature existed
  assert.equal(result.score, (result.namedScores.riskStatusMatch + result.namedScores.answerContentMatch) / 2);
});

test('qaMatchAssertion folds citationMatch into its own score as a 3-way average when at least one question is graded for it', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const result = await qaMatchAssertion(fakeOutputWithCitations(), fakeContextWithExpectedChunkText());

  const { riskStatusMatch, answerContentMatch, citationMatch } = result.namedScores;
  assert.equal(result.score, (riskStatusMatch + answerContentMatch + citationMatch) / 3);
});

test('qaMatchAssertion treats an empty-string expectedChunkText as NOT graded for citations', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const context = fakeContext();
  context.vars.expected.qa[0].expectedChunkText = '';

  const result = await qaMatchAssertion(fakeOutput(), context);

  assert.equal(result.perQuestionBreakdown[0].citationMatches, undefined);
  assert.equal('citationMatch' in result.namedScores, false);
});

test('qaMatchAssertion correctly reads expectedChunkText when vars are built by the real generate-tests-vars.js pipeline, not hand-authored', async (t) => {
  const { buildTestsVars } = require('./generate-tests-vars');
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const rawClaim = {
    bucketId: 1,
    claimCategoryId: 1,
    expectedFraudRiskScore: 0.5,
    expectedClaimantName: 'X',
    expectedDefendant: 'Y',
    expectedInsuranceFirm: 'Z',
    summary: 'S',
    questions: [
      { id: 1, question: 'Q1?', expectedAnswer: 'A1', expectedRiskStatus: 'RISK_DETECTED', expectedChunkText: 'gold passage text' },
    ],
  };
  const [{ vars }] = buildTestsVars([rawClaim]);
  const context = { vars, test: { assert: [{ metric: 'qa_match' }], options: {} } };
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 1, riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>' },
      ],
    },
    chunkGroundingData: new Map([['doc-1:chunk-1', 'matching text']]),
  };

  const result = await qaMatchAssertion(output, context);

  assert.equal(result.namedScores.citationMatch, 1);
  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: FAIL — multiple failures, since `qa-match-assertion.js` still does the old fileName-based check and never reads `output.chunkGroundingData` or `q.expectedChunkText`.

- [ ] **Step 3: Write the minimal implementation**

Replace the entire contents of `scripts/qa-match-assertion.js`:

```js
'use strict';

const promptfoo = require('promptfoo');
const { extractCitedCitationsFromText } = require('./extract-cited-file-names');

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

function buildChunkTextMatchPrompt(expectedChunkText, actualChunkText) {
  return [
    `Expected source passage: ${expectedChunkText}`,
    `Actual cited passage: ${actualChunkText}`,
    '',
    'Does the actual cited passage semantically support/match the expected source passage above',
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

const NO_CITATION_RESOLVED_REASON = 'No cited chunk resolved to compare against the expected passage.';

// Resolves every citation in this one question's actual answer against
// chunkGroundingData, and asks the grader whether ANY resolved chunk's text
// semantically supports expectedChunkText — "at least one" semantics, same
// as the fileName-based check this replaces. A citation that doesn't resolve
// (missing grounding data entirely, or that specific chunk absent from it)
// is skipped, not treated as a mismatch by itself. If NO citation resolves
// at all, this returns false with a fixed reason and makes no grader call.
async function computeChunkTextMatch(provider, expectedChunkText, actualAnswer, chunkGroundingData) {
  const citations = extractCitedCitationsFromText(actualAnswer);
  let sawAnyResolved = false;
  let lastFalseReason = NO_CITATION_RESOLVED_REASON;
  for (const { documentId, chunkId } of citations) {
    const chunkText = chunkGroundingData ? chunkGroundingData.get(`${documentId}:${chunkId}`) : undefined;
    if (!chunkText) {
      continue;
    }
    sawAnyResolved = true;
    const prompt = buildChunkTextMatchPrompt(expectedChunkText, chunkText);
    const response = await provider.callApi(prompt);
    if (response.error) {
      throw new Error(response.error);
    }
    const { matches, reason } = parseGraderVerdict(response.output);
    if (matches) {
      return { citationMatches: true, citationMatchReason: reason };
    }
    lastFalseReason = reason;
  }
  return {
    citationMatches: false,
    citationMatchReason: sawAnyResolved ? lastFalseReason : NO_CITATION_RESOLVED_REASON,
  };
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
    const riskStatusMatches = riskStatus === q.expectedRiskStatus;

    const actualCitedFileNames = [...new Set(extractCitedCitationsFromText(actualAnswer).map((c) => c.fileName))];

    let citationMatches;
    let citationMatchReason;
    if (typeof q.expectedChunkText === 'string' && q.expectedChunkText.length > 0) {
      const chunkResult = await computeChunkTextMatch(provider, q.expectedChunkText, actualAnswer, output.chunkGroundingData);
      citationMatches = chunkResult.citationMatches;
      citationMatchReason = chunkResult.citationMatchReason;
    }

    perQuestionBreakdown.push({
      predefinedQuestionId: q.predefinedQuestionId,
      question: q.question,
      actualAnswer,
      riskStatus,
      riskStatusMatches,
      matches,
      reason,
      actualCitedFileNames,
      citationMatches,
      citationMatchReason,
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
    namedScores: citationMatch === undefined
      ? { riskStatusMatch, answerContentMatch }
      : { riskStatusMatch, answerContentMatch, citationMatch },
    perQuestionBreakdown,
  };
}

module.exports = qaMatchAssertion;
module.exports.computeRiskStatusMatch = computeRiskStatusMatch;
module.exports.buildQuestionGradingPrompt = buildQuestionGradingPrompt;
module.exports.buildChunkTextMatchPrompt = buildChunkTextMatchPrompt;
module.exports.parseGraderVerdict = parseGraderVerdict;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/qa-match-assertion.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/qa-match-assertion.js scripts/qa-match-assertion.test.js
git commit -m "$(cat <<'EOF'
feat: replace fileName-based citationMatch with chunk-text semantic match

citationMatch now resolves each question's actually-cited chunks via
output.chunkGroundingData and asks the grader whether any resolved
chunk's text semantically supports the question's curated
expectedChunkText — "at least one" semantics, same as the fileName
check it replaces, but content-based rather than ID-based since chunk
IDs aren't stable across re-ingestion runs. Adds one extra grader call
per graded question. perQuestionBreakdown gains citationMatchReason;
expectedCitedFileNames is removed (nothing to carry anymore).
EOF
)"
```

---

### Task 6: `generate-pdf-report.js` — render the citation-match reason

**Files:**
- Modify: `scripts/generate-pdf-report.js`
- Modify: `scripts/generate-pdf-report.test.js`

**Interfaces:**
- Consumes: `entry.citationMatchReason` from Task 5's `perQuestionBreakdown`.
- Produces: no change to `formatCitationMatch`'s exported signature — only its `NO` case's rendered text changes.

- [ ] **Step 1: Write the failing tests**

In `scripts/generate-pdf-report.test.js`, replace the test `'formatCitationMatch renders NO with expected/actual fileNames for a non-matching citation'` with:

```js
test('formatCitationMatch renders NO with the grader\'s reason for a non-matching citation', () => {
  assert.equal(
    formatCitationMatch({ citationMatches: false, citationMatchReason: 'The cited passage does not mention the expected entity.' }),
    'NO (The cited passage does not mention the expected entity.)'
  );
});
```

Delete the test `'formatCitationMatch shows (none) when a non-matching question actually cited nothing'` entirely — the `(none)`/fileName-list fallback logic it tests no longer exists.

Leave `'formatCitationMatch renders YES for a matching citation'` and `'formatCitationMatch renders N/A when citationMatches is undefined'` unchanged.

In the test `'generatePdfReports renders Citation Match as YES, NO (with expected/actual fileNames), and N/A per question'`, rename it and replace its fixture and assertions:

```js
test('generatePdfReports renders Citation Match as YES, NO (with the grader\'s reason), and N/A per question', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pdf-report-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const resultsPath = path.join(tmpDir, 'results.json');
  const fixture = sampleResultsFile();
  const qaMatchComponent = fixture.results.results[0].gradingResult.componentResults.find(
    (c) => c.assertion.metric === 'qa_match'
  );
  qaMatchComponent.perQuestionBreakdown = [
    { predefinedQuestionId: 1, question: 'MATCHED-QUESTION', actualAnswer: 'a', riskStatus: 'RISK_DETECTED', riskStatusMatches: true, matches: true, reason: 'r', actualCitedFileNames: ['a.pdf'], citationMatches: true, citationMatchReason: 'Matches the expected passage.' },
    { predefinedQuestionId: 2, question: 'MISMATCHED-QUESTION', actualAnswer: 'a', riskStatus: 'UNSURE', riskStatusMatches: false, matches: true, reason: 'r', actualCitedFileNames: ['c.pdf'], citationMatches: false, citationMatchReason: 'The cited passage is unrelated to the expected passage.' },
    { predefinedQuestionId: 3, question: 'UNGRADED-QUESTION', actualAnswer: 'a', riskStatus: 'RISK_NOT_DETECTED', riskStatusMatches: true, matches: true, reason: 'r', actualCitedFileNames: ['z.pdf'], citationMatches: undefined, citationMatchReason: undefined },
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
  assert.match(text, /MISMATCHED-QUESTION[\s\S]*?Citation Match: NO \(The cited passage is unrelated to the expected passage\.\)/);
  assert.match(text, /UNGRADED-QUESTION[\s\S]*?Citation Match: N\/A/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/generate-pdf-report.test.js`
Expected: FAIL — `formatCitationMatch`'s `NO` case still renders the old `(expected one of: ...)` text.

- [ ] **Step 3: Write the minimal implementation**

In `scripts/generate-pdf-report.js`, replace `formatCitationMatch`:

```js
function formatCitationMatch(entry) {
  if (entry.citationMatches == null) {
    return 'N/A';
  }
  if (entry.citationMatches) {
    return 'YES';
  }
  return `NO (${entry.citationMatchReason})`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/generate-pdf-report.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/generate-pdf-report.js scripts/generate-pdf-report.test.js
git commit -m "$(cat <<'EOF'
feat: render the citation-match grader's reason instead of a fileName diff

formatCitationMatch's NO case showed "(expected one of: a.pdf, b.pdf;
got: c.pdf)", which stopped making sense once citationMatch became a
content-based (not fileName-based) check. Shows the grader's own
reason instead, same pattern already used for the per-question
Reason: line.
EOF
)"
```

---

### Task 7: Documentation + final verification

**Files:**
- Modify: `README.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Update the `citationMatch` description**

In `README.md`, replace this block (currently lines 33–42):

```
    - `citationMatch` (deterministic, optional per question): a question in `testdata/claims.json`
      can set an `expectedCitedFileNames` array — the source document `fileName`(s) that support
      its answer. For every question that sets it, `citationMatch` checks whether the real
      answer's `<InTextCitation fileName="...">` tags include **at least one** of the expected
      files (citing additional files beyond that doesn't count against it) — `documentId` on
      those tags is per-ingestion and changes every run, so it's never used for comparison, only
      `fileName` is. Questions that don't set `expectedCitedFileNames` are excluded from this
      fraction. If *no* question in a claim sets it, `citationMatch` is `undefined` for that
      claim (not `0`). `citationMatch` is reported for visibility (in `namedScores` and the PDF)
      but is not part of the accuracy formula below.
```

with:

```
    - `citationMatch` (LLM-graded, optional per question): a question in `testdata/claims.json`
      can set an `expectedChunkText` string — a curated golden source passage for that question,
      copied verbatim from the S3 chunk-grounding file `provider.js` reads (see below). For every
      question that sets it, `citationMatch` resolves that question's actually-cited
      `(documentId, chunkId)` pairs against `output.chunkGroundingData` and asks the grader
      whether **any** resolved chunk's text semantically supports the expected passage (exact
      wording doesn't matter, meaning does) — one extra grader call per resolved citation, on top
      of the existing per-question answer-content call. A citation that doesn't resolve (missing
      grounding data, or that specific chunk absent from it) is skipped rather than counted as a
      mismatch by itself; if *no* citation resolves at all, the question fails with a fixed reason
      and no grader call is made. Neither `documentId` nor `chunkId` is ever compared directly —
      both are per-ingestion and change every run — only the chunk *text* they resolve to is
      compared. Questions that don't set `expectedChunkText` (or set it to an empty string) are
      excluded from this fraction. If *no* question in a claim sets it, `citationMatch` is
      `undefined` for that claim (not `0`). `citationMatch` is reported for visibility (in
      `namedScores` and the PDF) but is not part of the accuracy formula below.
```

- [ ] **Step 2: Update the `perQuestionBreakdown` field list**

Replace this block (currently lines 44–51):

```
    The assertion also returns a `perQuestionBreakdown` array — one entry per question with its
    `predefinedQuestionId`, `question`, `actualAnswer`, `riskStatus` (the real report's raw value,
    used only for sorting the PDF's question order), `riskStatusMatches` (boolean — whether that
    `riskStatus` equals the gold `expectedRiskStatus` for this specific question), `matches`
    (boolean), `reason` (the grader's per-question reasoning), `actualCitedFileNames`,
    `expectedCitedFileNames`, and `citationMatches` (boolean, or `undefined` if that question
    wasn't graded for citations) — which is what `scripts/generate-pdf-report.js` renders in the
    question-by-question section of the PDF.
```

with:

```
    The assertion also returns a `perQuestionBreakdown` array — one entry per question with its
    `predefinedQuestionId`, `question`, `actualAnswer`, `riskStatus` (the real report's raw value,
    used only for sorting the PDF's question order), `riskStatusMatches` (boolean — whether that
    `riskStatus` equals the gold `expectedRiskStatus` for this specific question), `matches`
    (boolean), `reason` (the grader's per-question reasoning), `actualCitedFileNames` (deduplicated
    fileNames actually cited, for visibility), `citationMatches` (boolean, or `undefined` if that
    question wasn't graded for citations), and `citationMatchReason` (the citation grader's own
    reason, or a fixed string when no citation resolved at all) — which is what
    `scripts/generate-pdf-report.js` renders in the question-by-question section of the PDF.
```

- [ ] **Step 3: Update the cited-document-text paragraph**

Replace this line (currently lines 76–81):

```
- **`provider.js` fetches the text of every document the real report actually cites** (not the
  whole source bucket, and never based on the gold answer key) and attaches it as
  `output.citedDocumentsText`, capped at 15,000 characters per document — this is what
  `report_quality` checks the summary's claims against. If the report cites a filename
  `provider.js` can't match to a real source document, that citation is skipped rather than
  failing the run.
```

with:

```
- **`provider.js` fetches the text behind every citation via a separate S3 chunk-grounding file**
  (not the whole source bucket, and never based on the gold answer key) and attaches it as
  `output.citedDocumentsText`, capped at 15,000 characters per fileName (concatenating multiple
  cited chunks from the same file) — this is what `report_quality` checks the summary's claims
  against. If a citation's `(documentId, chunkId)` isn't found in the grounding file, or the
  grounding file itself is missing for that claim, it's skipped rather than failing the run.
```

- [ ] **Step 4: Update the citation-parsing paragraph**

Replace this line (currently line 84):

```
- **Citations are parsed out of free-text answers.** The real report embeds citations as inline `<InTextCitation fileName="..." documentId="...">` tags inside each answer's text, not a structured field. `scripts/extract-cited-file-names.js`'s `extractCitedFileNamesFromText` is the one place that regex-extracts `fileName` from these tags — `provider.js`'s `extractCitedFileNames` (to decide which documents to fetch text for `citedDocumentsText`) and `qa-match-assertion.js`'s `citationMatch` (per question) both call it. Only `fileName` is ever compared — `documentId` is assigned per-ingestion and differs on every eval run, so it can't identify a document across runs the way `fileName` can.
```

with:

```
- **Citations are parsed out of free-text answers, then grounded via a separate S3 file.** The real report embeds citations as inline `<InTextCitation fileName="..." documentId="..." chunkId="...">` tags inside each answer's text, not a structured field. `scripts/extract-cited-file-names.js`'s `extractCitedCitationsFromText` is the one place that regex-extracts `fileName`, `documentId`, and `chunkId` from these tags. Neither `documentId` nor `chunkId` is stable across eval runs (both are assigned per-ingestion), so neither is ever compared directly — instead, `s3-client.js`'s `fetchChunkGroundingData(bucketId)` reads a separate per-claim JSON file FraudX writes to the `fraudx-qa-claim-processor` S3 bucket (keyed `{bucketId}.json`), which maps each citation's `(documentId, chunkId)` pair to the exact verbatim chunk text GX grounded that citation in. `provider.js` uses this to build `citedDocumentsText` and exposes the raw lookup as `output.chunkGroundingData` so `qa-match-assertion.js`'s `citationMatch` (per question) can reuse it without a second S3 fetch. Reading this bucket requires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION` in `.env` (see `.env.example`).
```

- [ ] **Step 5: Run the full suite one final time**

```bash
npm test
```

Expected: PASS — every test in the repo green.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: describe S3 chunk-grounding and chunk-text citationMatch

Updates the citationMatch, perQuestionBreakdown, citedDocumentsText,
and citation-parsing sections to describe the S3 chunk-grounding file
lookup and expectedChunkText, replacing the superseded
expectedCitedFileNames/whole-PDF-download description.
EOF
)"
```
