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
    FRAUDX_ENDPOINT_URI: 'https://fake.fraudx.test',
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
    FRAUDX_ENDPOINT_URI: 'https://fake.fraudx.test',
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
    FRAUDX_ENDPOINT_URI: 'https://fake.fraudx.test',
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
