# CI Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual-dispatch-only GitHub Actions workflow that runs the unit test suite on every dispatch, and — only when explicitly chosen and only after the unit tests pass — runs the real FraudX eval, with optional per-dispatch overrides to test a different claim name / ingestion model / processing model without editing `testdata/claims.json`.

**Architecture:** A new `.github/workflows/ci.yml` with a `workflow_dispatch` trigger (a `mode` choice input plus three optional override string inputs) driving two jobs: `unit-tests` (always runs) and `full-eval` (gated on `mode == 'full-eval'` and on `unit-tests` succeeding). Ad-hoc overrides are resolved by two new small Node modules — `fraudx-client.js` gains a `searchModels` function, and a new `scripts/resolve-model-id.js` uses it to turn a human-typed model `displayName` into the platform's opaque numeric model ID — orchestrated by a new CLI script, `scripts/apply-adhoc-claim-overrides.js`, that mutates the CI runner's local (never-committed) copy of `testdata/claims.json` before `npm run eval` runs.

**Tech Stack:** GitHub Actions (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`), Node's built-in `node:test` + `node:assert/strict`, `js-yaml` (already a devDependency) for workflow-file syntax validation.

## Global Constraints

- Node engines: `>=20.16.0 <21 || >=22.3.0` (already declared in `package.json`; use Node `22.x` in the workflow).
- Never destructure `require('./fraudx-client')` in code whose tests need to monkey-patch it — always `const fraudxClient = require('./fraudx-client')` (or `require('../fraudx-client')` from inside `scripts/`) and call functions as `fraudxClient.fnName(...)`, matching the existing convention in `provider.js` and `provider.test.js`'s `mockFraudxClient` helper. This is deliberate: destructuring breaks test monkey-patching, which caused a real bug earlier in this repo's history.
- No swallowed errors — every new function throws a descriptive `Error` on failure (timeout, non-2xx, missing expected response field), matching every existing function in `fraudx-client.js`.
- Model name matching is **exact-string, not fuzzy, not case-insensitive** — match on `displayName` (unique per catalog entry) because plain `name` values collide across providers (e.g. `"moonshotai/kimi-k2.6"` appears under multiple providers with different `id`s).
- `testdata/claims.json` is read via `fs.readFileSync(path, 'utf8')` + `JSON.parse` and written via `fs.writeFileSync` everywhere in this codebase — never `require()`'d (which would cache and could return stale data across the read-then-write cycle this plan needs).
- The new CLI script that mutates `testdata/claims.json` (`scripts/apply-adhoc-claim-overrides.js`) is only ever meant to run against a CI runner's ephemeral checkout (thrown away after the job ends) — it intentionally mutates a real, git-tracked file in place. Do not add any special "restore" or gitignore logic for this; the design relies on CI checkouts being disposable, not on the script protecting the working tree.
- Timeout convention: `Number(process.env.FRAUDX_HTTP_TIMEOUT_MS || 900000)` (900000ms = 15 minutes), matching `provider.js`'s existing convention, for every new network call.

---

### Task 1: `searchModels` in `fraudx-client.js`

**Files:**
- Modify: `fraudx-client.js` (add `searchModels`, add it to `module.exports`)
- Modify: `fraudx-client.test.js` (add `searchModels` to the destructured import, add tests)

**Interfaces:**
- Produces: `async function searchModels(base, auth, typeName, timeoutMs)` — `auth` is `{ token, orgId, userId }` (the shape `login()` already returns). POSTs to `{base}/fraudx/api/v1/models/search` filtered by `types.name == typeName` (e.g. `'INGESTION'` or `'PROCESSING'`), and resolves to the array at `response.response.content` (an array of model objects, each with at least `id`, `name`, `displayName`, `types`). Throws on timeout, non-2xx, or a missing `response.content`.

- [ ] **Step 1: Write the failing tests**

Add `searchModels` to the destructured import at the top of `fraudx-client.test.js` (currently line 5):

```js
const { login, postDocumentList, listBucketDocuments, contentTypeForExtension, getDownloadUrl, downloadFile, createClaim, requestUploadUrls, uploadFile, triggerJobProcessing, findDocumentByJobId, waitForDocumentUpload, listGxBuckets, getBucketDetails, triggerClaimProcessing, waitForClaimProcessing, fetchReport, extractPdfText, searchModels } = require('./fraudx-client');
```

Append these tests to the end of `fraudx-client.test.js`:

```js
test('searchModels posts the type filter and returns response.content', async (t) => {
  withFetchMock(t, async (url, opts) => {
    assert.equal(url, 'https://fake.fraudx.test/fraudx/api/v1/models/search');
    assert.deepEqual(JSON.parse(opts.body), {
      page: 0,
      size: 10000,
      criteriaOperator: 'AND',
      criteria: [{ column: 'types.name', operator: 'EQUALS', values: ['INGESTION'] }],
    });
    assert.equal(opts.headers.Authorization, 'Bearer t');
    assert.equal(opts.headers['x-org-id'], '1');
    assert.equal(opts.headers['x-user-id'], '68');
    return {
      ok: true,
      json: async () => ({
        response: {
          content: [
            { id: 1, name: 'gpt-5.1', displayName: 'openai-gpt-5.1', types: [{ id: 3, name: 'INGESTION' }] },
          ],
        },
      }),
    };
  });
  const content = await searchModels('https://fake.fraudx.test', { token: 't', orgId: 1, userId: 68 }, 'INGESTION', 5000);
  assert.deepEqual(content, [{ id: 1, name: 'gpt-5.1', displayName: 'openai-gpt-5.1', types: [{ id: 3, name: 'INGESTION' }] }]);
});

test('searchModels throws a clear error on non-2xx', async (t) => {
  withFetchMock(t, async () => ({ ok: false, status: 500, text: async () => 'server error' }));
  await assert.rejects(
    () => searchModels('https://fake.fraudx.test', { token: 't', orgId: 1, userId: 68 }, 'PROCESSING', 5000),
    /Searching models for type PROCESSING failed: 500 server error/
  );
});

test('searchModels throws a clear error when the response has no response.content', async (t) => {
  withFetchMock(t, async () => ({ ok: true, json: async () => ({ response: {} }) }));
  await assert.rejects(
    () => searchModels('https://fake.fraudx.test', { token: 't', orgId: 1, userId: 68 }, 'INGESTION', 5000),
    /did not contain response\.content/
  );
});

test('searchModels throws a clear error on timeout', async (t) => {
  withFetchMock(t, async () => {
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    throw err;
  });
  await assert.rejects(
    () => searchModels('https://fake.fraudx.test', { token: 't', orgId: 1, userId: 68 }, 'INGESTION', 5000),
    /Searching models for type INGESTION timed out after 5000ms/
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test fraudx-client.test.js`
Expected: FAIL — `searchModels is not a function` (or `undefined is not a function`), since it doesn't exist yet.

- [ ] **Step 3: Implement `searchModels`**

Add this function to `fraudx-client.js`, right before the `module.exports` block at the end of the file:

```js
async function searchModels(base, auth, typeName, timeoutMs) {
  let res;
  try {
    res = await fetchWithRetry(`${base}/fraudx/api/v1/models/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'x-org-id': String(auth.orgId),
        'x-user-id': String(auth.userId),
      },
      body: JSON.stringify({
        page: 0,
        size: 10000,
        criteriaOperator: 'AND',
        criteria: [{ column: 'types.name', operator: 'EQUALS', values: [typeName] }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Searching models for type ${typeName} timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Searching models for type ${typeName} failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const content = body?.response?.content;
  if (!Array.isArray(content)) {
    throw new Error(`Models-search response for type ${typeName} did not contain response.content`);
  }
  return content;
}
```

Update `module.exports` at the end of `fraudx-client.js` to include it:

```js
module.exports = {
  login,
  postDocumentList,
  listBucketDocuments,
  contentTypeForExtension,
  extractPdfText,
  getDownloadUrl,
  downloadFile,
  createClaim,
  requestUploadUrls,
  uploadFile,
  triggerJobProcessing,
  findDocumentByJobId,
  waitForDocumentUpload,
  listGxBuckets,
  getBucketDetails,
  triggerClaimProcessing,
  waitForClaimProcessing,
  fetchReport,
  searchModels,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test fraudx-client.test.js`
Expected: PASS — all tests in the file, including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add fraudx-client.js fraudx-client.test.js
git commit -m "feat: add searchModels to fraudx-client for model-catalog lookups"
```

---

### Task 2: `scripts/resolve-model-id.js`

**Files:**
- Create: `scripts/resolve-model-id.js`
- Create: `scripts/resolve-model-id.test.js`
- Modify: `package.json` (`test` script — add the new test file)

**Interfaces:**
- Consumes: `fraudxClient.searchModels(base, auth, typeName, timeoutMs)` from Task 1, via `require('../fraudx-client')` (non-destructured).
- Produces: `module.exports = resolveModelId` where `async function resolveModelId(base, auth, displayName, typeName, timeoutMs)` returns the numeric `id` of the model catalog entry whose `displayName` exactly equals `displayName`, or throws `No ${typeName} model found with displayName "${displayName}"` if none match.

- [ ] **Step 1: Write the failing tests**

Create `scripts/resolve-model-id.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fraudxClient = require('../fraudx-client');
const resolveModelId = require('./resolve-model-id');

function mockSearchModels(t, impl) {
  const original = fraudxClient.searchModels;
  fraudxClient.searchModels = impl;
  t.after(() => {
    fraudxClient.searchModels = original;
  });
}

const SAMPLE_MODELS = [
  { id: 1145, name: 'gpt-5.4', displayName: 'openai-gpt-5.4' },
  { id: 12, name: 'openai/gpt-oss-120b', displayName: 'deepinfra-openai/gpt-oss-120b' },
  { id: 1226, name: 'openai/gpt-oss-120b', displayName: 'openrouter-deepinfra/turbo:openai/gpt-oss-120b' },
];

test('resolveModelId returns the id of the model whose displayName matches exactly', async (t) => {
  mockSearchModels(t, async () => SAMPLE_MODELS);
  const id = await resolveModelId('https://fake.fraudx.test', { token: 't', orgId: 1, userId: 68 }, 'openai-gpt-5.4', 'INGESTION', 5000);
  assert.equal(id, 1145);
});

test('resolveModelId disambiguates between entries that share the same name but have different displayName', async (t) => {
  mockSearchModels(t, async () => SAMPLE_MODELS);
  const id = await resolveModelId('https://fake.fraudx.test', { token: 't', orgId: 1, userId: 68 }, 'openrouter-deepinfra/turbo:openai/gpt-oss-120b', 'PROCESSING', 5000);
  assert.equal(id, 1226);
});

test('resolveModelId throws a clear error naming the displayName and type searched for when nothing matches', async (t) => {
  mockSearchModels(t, async () => SAMPLE_MODELS);
  await assert.rejects(
    () => resolveModelId('https://fake.fraudx.test', { token: 't', orgId: 1, userId: 68 }, 'nonexistent-model', 'INGESTION', 5000),
    /No INGESTION model found with displayName "nonexistent-model"/
  );
});

test('resolveModelId passes base, auth, typeName, and timeoutMs through to searchModels', async (t) => {
  let capturedArgs;
  mockSearchModels(t, async (...args) => {
    capturedArgs = args;
    return SAMPLE_MODELS;
  });
  await resolveModelId('https://fake.fraudx.test', { token: 't', orgId: 1, userId: 68 }, 'openai-gpt-5.4', 'INGESTION', 5000);
  assert.deepEqual(capturedArgs, ['https://fake.fraudx.test', { token: 't', orgId: 1, userId: 68 }, 'INGESTION', 5000]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/resolve-model-id.test.js`
Expected: FAIL — `Cannot find module './resolve-model-id'`.

- [ ] **Step 3: Implement `resolveModelId`**

Create `scripts/resolve-model-id.js`:

```js
'use strict';

const fraudxClient = require('../fraudx-client');

async function resolveModelId(base, auth, displayName, typeName, timeoutMs) {
  const models = await fraudxClient.searchModels(base, auth, typeName, timeoutMs);
  const match = models.find((model) => model.displayName === displayName);
  if (!match) {
    throw new Error(`No ${typeName} model found with displayName "${displayName}"`);
  }
  return match.id;
}

module.exports = resolveModelId;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/resolve-model-id.test.js`
Expected: PASS — all 4 tests.

- [ ] **Step 5: Add the new test file to `package.json`'s `test` script**

In `package.json`, the `test` script currently reads:

```json
"test": "node --test provider.test.js config-shape.test.js scripts/score-dashboard.test.js scripts/qa-match-assertion.test.js scripts/metadata-match-assertion.test.js scripts/generate-pdf-report.test.js fraudx-client.test.js scripts/generate-tests-vars.test.js",
```

Add `scripts/resolve-model-id.test.js` to the end of that list:

```json
"test": "node --test provider.test.js config-shape.test.js scripts/score-dashboard.test.js scripts/qa-match-assertion.test.js scripts/metadata-match-assertion.test.js scripts/generate-pdf-report.test.js fraudx-client.test.js scripts/generate-tests-vars.test.js scripts/resolve-model-id.test.js",
```

- [ ] **Step 6: Run the full suite to confirm nothing broke and the new file is wired in**

Run: `npm test`
Expected: all prior tests still pass, plus the 4 new `resolveModelId` tests now run as part of `npm test` (not just standalone).

- [ ] **Step 7: Commit**

```bash
git add scripts/resolve-model-id.js scripts/resolve-model-id.test.js package.json
git commit -m "feat: add resolveModelId to turn a model displayName into its numeric id"
```

---

### Task 3: `scripts/apply-adhoc-claim-overrides.js`

**Files:**
- Create: `scripts/apply-adhoc-claim-overrides.js`
- Create: `scripts/apply-adhoc-claim-overrides.test.js`
- Modify: `package.json` (`test` script — add the new test file)

**Interfaces:**
- Consumes: `fraudxClient.login(base, timeoutMs)` (existing, returns `{ token, orgId, userId }`), `resolveModelId(base, auth, displayName, typeName, timeoutMs)` from Task 2.
- Produces: `module.exports = { applyAdhocClaimOverrides }` where `async function applyAdhocClaimOverrides(claimsPath)` reads three env vars (`ADHOC_NEW_CLAIM_NAME`, `ADHOC_INGESTION_MODEL_NAME`, `ADHOC_PROCESSING_MODEL_NAME`), does nothing if all three are empty, otherwise applies whichever are non-empty to every claim object in the JSON array at `claimsPath` and rewrites the file. Also runnable as a CLI: `node scripts/apply-adhoc-claim-overrides.js [claimsPath]` (default `testdata/claims.json`).

- [ ] **Step 1: Write the failing tests**

Create `scripts/apply-adhoc-claim-overrides.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fraudxClient = require('../fraudx-client');
const { applyAdhocClaimOverrides } = require('./apply-adhoc-claim-overrides');

function sampleClaims() {
  return [
    { bucketId: 31662, newClaimName: 'promptfoo-golden-claim-eval', claimCategoryId: 23, ingestionModelId: 1, processingModelId: 9 },
  ];
}

function withEnv(t, vars) {
  const originals = {};
  for (const [key, value] of Object.entries(vars)) {
    originals[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  t.after(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

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

test('applyAdhocClaimOverrides is a no-op (no login, no file write) when all three env vars are empty', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-overrides-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const claimsPath = path.join(tmpDir, 'claims.json');
  const originalContent = JSON.stringify(sampleClaims());
  fs.writeFileSync(claimsPath, originalContent);

  withEnv(t, { ADHOC_NEW_CLAIM_NAME: undefined, ADHOC_INGESTION_MODEL_NAME: undefined, ADHOC_PROCESSING_MODEL_NAME: undefined });
  let loginCalled = false;
  mockFraudxClient(t, { login: async () => { loginCalled = true; return { token: 't', orgId: 1, userId: 68 }; } });

  await applyAdhocClaimOverrides(claimsPath);

  assert.equal(loginCalled, false);
  assert.equal(fs.readFileSync(claimsPath, 'utf8'), originalContent);
});

test('applyAdhocClaimOverrides overrides only newClaimName when only that env var is set, without ever calling login', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-overrides-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const claimsPath = path.join(tmpDir, 'claims.json');
  fs.writeFileSync(claimsPath, JSON.stringify(sampleClaims()));

  withEnv(t, { ADHOC_NEW_CLAIM_NAME: 'my-test-claim', ADHOC_INGESTION_MODEL_NAME: undefined, ADHOC_PROCESSING_MODEL_NAME: undefined });
  let loginCalled = false;
  mockFraudxClient(t, { login: async () => { loginCalled = true; return { token: 't', orgId: 1, userId: 68 }; } });

  await applyAdhocClaimOverrides(claimsPath);

  assert.equal(loginCalled, false, 'no model name was provided, so login should never be called');
  const written = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
  assert.equal(written[0].newClaimName, 'my-test-claim');
  assert.equal(written[0].ingestionModelId, 1);
  assert.equal(written[0].processingModelId, 9);
});

test('applyAdhocClaimOverrides resolves and overrides only ingestionModelId when only that env var is set', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-overrides-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const claimsPath = path.join(tmpDir, 'claims.json');
  fs.writeFileSync(claimsPath, JSON.stringify(sampleClaims()));

  withEnv(t, {
    ADHOC_NEW_CLAIM_NAME: undefined,
    ADHOC_INGESTION_MODEL_NAME: 'openai-gpt-5.4',
    ADHOC_PROCESSING_MODEL_NAME: undefined,
    FRAUDX_TEST_ENDPOINT: 'https://fake.fraudx.test',
  });
  mockFraudxClient(t, {
    login: async () => ({ token: 't', orgId: 1, userId: 68 }),
    searchModels: async (base, auth, typeName) => {
      assert.equal(typeName, 'INGESTION');
      return [{ id: 1145, name: 'gpt-5.4', displayName: 'openai-gpt-5.4' }];
    },
  });

  await applyAdhocClaimOverrides(claimsPath);

  const written = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
  assert.equal(written[0].ingestionModelId, 1145);
  assert.equal(written[0].processingModelId, 9, 'processingModelId must be untouched');
  assert.equal(written[0].newClaimName, 'promptfoo-golden-claim-eval', 'newClaimName must be untouched');
});

test('applyAdhocClaimOverrides resolves and overrides only processingModelId when only that env var is set', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-overrides-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const claimsPath = path.join(tmpDir, 'claims.json');
  fs.writeFileSync(claimsPath, JSON.stringify(sampleClaims()));

  withEnv(t, {
    ADHOC_NEW_CLAIM_NAME: undefined,
    ADHOC_INGESTION_MODEL_NAME: undefined,
    ADHOC_PROCESSING_MODEL_NAME: 'openai-gpt-4o',
    FRAUDX_TEST_ENDPOINT: 'https://fake.fraudx.test',
  });
  mockFraudxClient(t, {
    login: async () => ({ token: 't', orgId: 1, userId: 68 }),
    searchModels: async (base, auth, typeName) => {
      assert.equal(typeName, 'PROCESSING');
      return [{ id: 6, name: 'gpt-4o', displayName: 'openai-gpt-4o' }];
    },
  });

  await applyAdhocClaimOverrides(claimsPath);

  const written = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
  assert.equal(written[0].processingModelId, 6);
  assert.equal(written[0].ingestionModelId, 1, 'ingestionModelId must be untouched');
});

test('applyAdhocClaimOverrides propagates a clear error when the displayName does not resolve, and does not write the file', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adhoc-overrides-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const claimsPath = path.join(tmpDir, 'claims.json');
  const originalContent = JSON.stringify(sampleClaims());
  fs.writeFileSync(claimsPath, originalContent);

  withEnv(t, {
    ADHOC_NEW_CLAIM_NAME: undefined,
    ADHOC_INGESTION_MODEL_NAME: 'nonexistent-model',
    ADHOC_PROCESSING_MODEL_NAME: undefined,
    FRAUDX_TEST_ENDPOINT: 'https://fake.fraudx.test',
  });
  mockFraudxClient(t, {
    login: async () => ({ token: 't', orgId: 1, userId: 68 }),
    searchModels: async () => [],
  });

  await assert.rejects(
    () => applyAdhocClaimOverrides(claimsPath),
    /No INGESTION model found with displayName "nonexistent-model"/
  );
  assert.equal(fs.readFileSync(claimsPath, 'utf8'), originalContent, 'the file must be untouched if resolution fails');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/apply-adhoc-claim-overrides.test.js`
Expected: FAIL — `Cannot find module './apply-adhoc-claim-overrides'`.

- [ ] **Step 3: Implement `applyAdhocClaimOverrides`**

Create `scripts/apply-adhoc-claim-overrides.js`:

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fraudxClient = require('../fraudx-client');
const resolveModelId = require('./resolve-model-id');

// Mutates the CI runner's LOCAL, EPHEMERAL checkout of testdata/claims.json —
// this is only ever meant to run in a CI job's disposable working copy
// (see the "Ad-hoc claim overrides" note in the CI design spec). It has no
// safeguard against running it against a real local working tree by mistake.
async function applyAdhocClaimOverrides(claimsPath) {
  const newClaimName = process.env.ADHOC_NEW_CLAIM_NAME || '';
  const ingestionModelName = process.env.ADHOC_INGESTION_MODEL_NAME || '';
  const processingModelName = process.env.ADHOC_PROCESSING_MODEL_NAME || '';

  if (!newClaimName && !ingestionModelName && !processingModelName) {
    console.error('No ad-hoc claim overrides requested — leaving testdata/claims.json unchanged.');
    return;
  }

  const claims = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));

  let ingestionModelId;
  let processingModelId;
  if (ingestionModelName || processingModelName) {
    const base = process.env.FRAUDX_TEST_ENDPOINT;
    const timeoutMs = Number(process.env.FRAUDX_HTTP_TIMEOUT_MS || 900000);
    const auth = await fraudxClient.login(base, timeoutMs);
    if (ingestionModelName) {
      ingestionModelId = await resolveModelId(base, auth, ingestionModelName, 'INGESTION', timeoutMs);
      console.error(`Resolved ingestion model "${ingestionModelName}" to id ${ingestionModelId}`);
    }
    if (processingModelName) {
      processingModelId = await resolveModelId(base, auth, processingModelName, 'PROCESSING', timeoutMs);
      console.error(`Resolved processing model "${processingModelName}" to id ${processingModelId}`);
    }
  }

  for (const claim of claims) {
    if (newClaimName) {
      claim.newClaimName = newClaimName;
    }
    if (ingestionModelId !== undefined) {
      claim.ingestionModelId = ingestionModelId;
    }
    if (processingModelId !== undefined) {
      claim.processingModelId = processingModelId;
    }
  }

  fs.writeFileSync(claimsPath, JSON.stringify(claims, null, 2) + '\n', 'utf8');
  console.error(`Applied ad-hoc overrides to ${claims.length} claim(s) in ${claimsPath}.`);
}

function main() {
  const claimsPath = process.argv[2] || path.join(__dirname, '..', 'testdata', 'claims.json');
  applyAdhocClaimOverrides(claimsPath).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

if (require.main === module) {
  main();
}

module.exports = { applyAdhocClaimOverrides };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/apply-adhoc-claim-overrides.test.js`
Expected: PASS — all 5 tests.

- [ ] **Step 5: Add the new test file to `package.json`'s `test` script**

Extend the same `test` script from Task 2's Step 5 to also include `scripts/apply-adhoc-claim-overrides.test.js`:

```json
"test": "node --test provider.test.js config-shape.test.js scripts/score-dashboard.test.js scripts/qa-match-assertion.test.js scripts/metadata-match-assertion.test.js scripts/generate-pdf-report.test.js fraudx-client.test.js scripts/generate-tests-vars.test.js scripts/resolve-model-id.test.js scripts/apply-adhoc-claim-overrides.test.js",
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all prior tests plus these 5 new ones pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/apply-adhoc-claim-overrides.js scripts/apply-adhoc-claim-overrides.test.js package.json
git commit -m "feat: add apply-adhoc-claim-overrides CLI for CI-only claim/model overrides"
```

---

### Task 4: `.github/workflows/ci.yml`

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm test` (existing), `npm run eval` (existing), `node scripts/apply-adhoc-claim-overrides.js` (Task 3).
- Produces: a GitHub Actions workflow named `CI`, manually dispatchable from the Actions tab with a `mode` choice (`tests-only` default, `full-eval`) and three optional string inputs (`newClaimName`, `ingestionModelName`, `processingModelName`).

There's no meaningful way to unit-test GitHub Actions YAML the way the rest of this plan is TDD'd. Steps 1-2 substitute a real, mechanical check (the file parses as valid YAML) for a unit test, then Step 3 is a manual checklist review against the design spec's decisions.

- [ ] **Step 1: Write a one-off syntax-check script (not committed) to confirm the YAML you're about to write is at least syntactically valid**

Before creating the workflow file, verify the syntax-check approach works using `js-yaml` (already a devDependency):

Run: `node -e "console.log(typeof require('js-yaml').load)"`
Expected: `function`

- [ ] **Step 2: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  workflow_dispatch:
    inputs:
      mode:
        description: 'Which flow to run'
        required: true
        type: choice
        options:
          - tests-only
          - full-eval
        default: tests-only
      newClaimName:
        description: 'Ad-hoc override: newClaimName for the golden claim (blank = use testdata/claims.json as committed)'
        required: false
        type: string
        default: ''
      ingestionModelName:
        description: 'Ad-hoc override: exact displayName of the ingestion model to use (blank = no override)'
        required: false
        type: string
        default: ''
      processingModelName:
        description: 'Ad-hoc override: exact displayName of the processing model to use (blank = no override)'
        required: false
        type: string
        default: ''

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22.x'
          cache: 'npm'
      - run: npm ci
      - run: npm test

  full-eval:
    needs: unit-tests
    if: ${{ inputs.mode == 'full-eval' }}
    runs-on: ubuntu-latest
    timeout-minutes: 240
    concurrency:
      group: fraudx-full-eval
      cancel-in-progress: false
    env:
      FRAUDX_TEST_ENDPOINT: ${{ secrets.FRAUDX_TEST_ENDPOINT }}
      FRAUDX_LOGIN_EMAIL: ${{ secrets.FRAUDX_LOGIN_EMAIL }}
      FRAUDX_LOGIN_PASSWORD: ${{ secrets.FRAUDX_LOGIN_PASSWORD }}
      GRADER_PROVIDER: ${{ secrets.GRADER_PROVIDER }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22.x'
          cache: 'npm'
      - run: npm ci
      - name: Apply ad-hoc claim overrides
        if: ${{ inputs.newClaimName != '' || inputs.ingestionModelName != '' || inputs.processingModelName != '' }}
        env:
          ADHOC_NEW_CLAIM_NAME: ${{ inputs.newClaimName }}
          ADHOC_INGESTION_MODEL_NAME: ${{ inputs.ingestionModelName }}
          ADHOC_PROCESSING_MODEL_NAME: ${{ inputs.processingModelName }}
        run: node scripts/apply-adhoc-claim-overrides.js
      - run: npm run eval
      - name: Upload PDF reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: reports
          path: reports/**
          if-no-files-found: ignore
```

- [ ] **Step 3: Validate the file parses as YAML**

Run: `node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/ci.yml', 'utf8')); console.log('valid YAML')"`
Expected: `valid YAML` (no thrown exception). This only confirms syntactic validity, not GitHub's workflow schema — cross-check the file manually against this checklist before moving on:
  - [ ] `mode` input exists with exactly `tests-only`/`full-eval` options and `tests-only` as default.
  - [ ] `newClaimName`, `ingestionModelName`, `processingModelName` inputs all exist, all optional, all default to `''`.
  - [ ] `unit-tests` job has no `if:` condition (always runs) and requires no secrets.
  - [ ] `full-eval` job has `needs: unit-tests` and `if: ${{ inputs.mode == 'full-eval' }}`.
  - [ ] `full-eval` has `timeout-minutes: 240`.
  - [ ] `full-eval` has a job-level `concurrency` block with `group: fraudx-full-eval` and `cancel-in-progress: false`.
  - [ ] `full-eval`'s `env:` includes all 6 secrets named in the design spec's Secrets list.
  - [ ] The ad-hoc-override step only runs when at least one of the three inputs is non-empty, and passes them through as the exact env var names `scripts/apply-adhoc-claim-overrides.js` reads (`ADHOC_NEW_CLAIM_NAME`, `ADHOC_INGESTION_MODEL_NAME`, `ADHOC_PROCESSING_MODEL_NAME`).
  - [ ] The artifact-upload step has `if: always()` and `if-no-files-found: ignore` (so a zero-PDF run doesn't fail the job on the upload step).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat: add GitHub Actions CI workflow (tests-only / full-eval, ad-hoc overrides)"
```

---

### Task 5: Document the workflow in the README

**Files:**
- Modify: `README.md` (the existing `## CI` section)

**Interfaces:**
- None — documentation only.

- [ ] **Step 1: Replace the `## CI` section**

Find this in `README.md`:

```markdown
## CI

Wrap `npm run eval` in a CI workflow step — nothing about the repo changes
between local and CI execution.
```

Replace it with:

```markdown
## CI

`.github/workflows/ci.yml` is a manual-dispatch-only GitHub Actions workflow (Actions tab →
"Run workflow") — nothing runs automatically on push or pull request, since the full eval hits
a live paid endpoint. Dispatching it prompts for a `mode`:

- **`tests-only`** (default) — runs `npm test` only. No secrets required.
- **`full-eval`** — runs `npm test` first (the `unit-tests` job), and only if that passes, runs
  the real `npm run eval` against `FRAUDX_TEST_ENDPOINT` (the `full-eval` job, gated with
  `needs: unit-tests`) — so a broken build fails in seconds instead of burning 30-60+ minutes of
  real eval time. Generated PDF reports (`reports/**`) are uploaded as a workflow artifact, even
  if the eval run itself "fails" (an assertion not meeting its pass bar is a real finding, not a
  CI misconfiguration). Only one `full-eval` run can be in flight at a time
  (`concurrency: fraudx-full-eval`) — the real platform has shared, account-level ingestion
  limits, so overlapping real evals would contend with each other.

  `full-eval` requires these repo (or environment) secrets: `FRAUDX_TEST_ENDPOINT`,
  `FRAUDX_LOGIN_EMAIL`, `FRAUDX_LOGIN_PASSWORD`, `GRADER_PROVIDER`, and whichever of
  `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` matches `GRADER_PROVIDER`'s value (both are passed
  through; an unused one is simply ignored).

  Dispatching `full-eval` also accepts three optional inputs — `newClaimName`,
  `ingestionModelName`, `processingModelName` — to test a different claim name and/or
  ingestion/processing model against the same golden claim's documents and answer key for that
  one run, without editing `testdata/claims.json`. `ingestionModelName`/`processingModelName`
  must be the exact `displayName` from the FraudX platform's model catalog (e.g.
  `openai-gpt-5.4`) — plain model names collide across providers, so `displayName` (which embeds
  the provider) is what's matched, exactly, not fuzzily. Leave all three blank to run the
  committed golden claim(s) unchanged.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: describe the implemented CI workflow"
```

---

## Self-Review Notes

- **Spec coverage:** every bullet in the design spec's "Decisions" and "Ad-hoc claim overrides" sections maps to a task above — trigger/inputs (Task 4), jobs/gate/timeout/concurrency/artifact/secrets (Task 4), `searchModels` (Task 1), `resolveModelId` (Task 2), `apply-adhoc-claim-overrides` + workflow wiring (Task 3 + Task 4), README (Task 5).
- **Package.json wiring:** confirmed `npm test` runs an explicit file list, not a glob — Tasks 2 and 3 each add their new test file to that list so they actually run under `npm test` and, by extension, under the `unit-tests` CI job. This was verified against the current `package.json` before writing the plan, not assumed.
- **Mockability:** `resolveModelId`'s own tests mock `fraudxClient.searchModels` directly (Task 2). `apply-adhoc-claim-overrides`'s tests mock `fraudxClient.login` and `fraudxClient.searchModels` (not `resolveModelId` itself) — since `resolve-model-id.js` exports a bare function (not an object), there is no mutable property on it to monkey-patch from outside; running the *real* `resolveModelId` against a mocked `searchModels` is deliberate, not an oversight, and gives equivalent coverage without changing `resolveModelId`'s export shape.
- **Type/name consistency check:** `resolveModelId(base, auth, displayName, typeName, timeoutMs)` — same parameter order and names used consistently in Task 2's implementation, Task 2's tests, Task 3's implementation, and Task 3's tests. `applyAdhocClaimOverrides(claimsPath)` — same signature in Task 3's implementation, tests, and CLI `main()`. Env var names (`ADHOC_NEW_CLAIM_NAME`, `ADHOC_INGESTION_MODEL_NAME`, `ADHOC_PROCESSING_MODEL_NAME`) match exactly between Task 3's script, Task 3's tests, and Task 4's workflow YAML.
