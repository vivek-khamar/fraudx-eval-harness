'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fraudxClient = require('../fraudx-client');
const { applyClaimConfig } = require('./apply-claim-config');

function sampleClaims() {
  return [{ bucketId: 31662, claimCategoryId: 23 }];
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

function makeTmpClaimsFile() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-config-'));
  const claimsPath = path.join(tmpDir, 'claims.json');
  const originalContent = JSON.stringify(sampleClaims());
  fs.writeFileSync(claimsPath, originalContent);
  return { tmpDir, claimsPath, originalContent };
}

test('applyClaimConfig throws naming every missing env var, without calling login, when all three are empty', async (t) => {
  const { tmpDir, claimsPath, originalContent } = makeTmpClaimsFile();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  withEnv(t, {
    CLAIM_NAME: undefined,
    INGESTION_MODEL_NAME: undefined,
    PROCESSING_MODEL_NAME: undefined,
    AWS_ACCESS_KEY_ID: 'AKIAFAKE',
    AWS_SECRET_ACCESS_KEY: 'fake-secret',
    AWS_REGION: 'us-east-1',
    SKIP_S3_GROUNDING: undefined,
  });
  let loginCalled = false;
  mockFraudxClient(t, { login: async () => { loginCalled = true; return { token: 't', orgId: 1, userId: 68 }; } });

  await assert.rejects(
    () => applyClaimConfig(claimsPath),
    /Missing required claim config env var\(s\): CLAIM_NAME, INGESTION_MODEL_NAME, PROCESSING_MODEL_NAME/
  );
  assert.equal(loginCalled, false);
  assert.equal(fs.readFileSync(claimsPath, 'utf8'), originalContent);
});

test('applyClaimConfig throws naming only the missing env var when just one is unset', async (t) => {
  const { tmpDir, claimsPath, originalContent } = makeTmpClaimsFile();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  withEnv(t, {
    CLAIM_NAME: 'my-test-claim',
    INGESTION_MODEL_NAME: 'openai-gpt-5.4',
    PROCESSING_MODEL_NAME: undefined,
    AWS_ACCESS_KEY_ID: 'AKIAFAKE',
    AWS_SECRET_ACCESS_KEY: 'fake-secret',
    AWS_REGION: 'us-east-1',
    SKIP_S3_GROUNDING: undefined,
  });
  let loginCalled = false;
  mockFraudxClient(t, { login: async () => { loginCalled = true; return { token: 't', orgId: 1, userId: 68 }; } });

  await assert.rejects(
    () => applyClaimConfig(claimsPath),
    /Missing required claim config env var\(s\): PROCESSING_MODEL_NAME/
  );
  assert.equal(loginCalled, false);
  assert.equal(fs.readFileSync(claimsPath, 'utf8'), originalContent);
});

test('applyClaimConfig throws naming the missing AWS env vars, without calling login', async (t) => {
  const { tmpDir, claimsPath, originalContent } = makeTmpClaimsFile();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  withEnv(t, {
    CLAIM_NAME: 'my-test-claim',
    INGESTION_MODEL_NAME: 'openai-gpt-5.4',
    PROCESSING_MODEL_NAME: 'openai-gpt-4o',
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
    AWS_REGION: undefined,
    SKIP_S3_GROUNDING: undefined,
  });
  let loginCalled = false;
  mockFraudxClient(t, { login: async () => { loginCalled = true; return { token: 't', orgId: 1, userId: 68 }; } });

  await assert.rejects(
    () => applyClaimConfig(claimsPath),
    /Missing required claim config env var\(s\): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION/
  );
  assert.equal(loginCalled, false);
  assert.equal(fs.readFileSync(claimsPath, 'utf8'), originalContent);
});

test('applyClaimConfig does not require the AWS env vars when SKIP_S3_GROUNDING=true', async (t) => {
  const { tmpDir, claimsPath } = makeTmpClaimsFile();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  withEnv(t, {
    CLAIM_NAME: 'my-test-claim',
    INGESTION_MODEL_NAME: 'openai-gpt-5.4',
    PROCESSING_MODEL_NAME: 'openai-gpt-4o',
    FRAUDX_ENDPOINT_URI: 'https://fake.fraudx.test',
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
    AWS_REGION: undefined,
    SKIP_S3_GROUNDING: 'true',
  });
  mockFraudxClient(t, {
    login: async () => ({ token: 't', orgId: 1, userId: 68 }),
    searchModels: async (base, auth, typeName) => (
      typeName === 'INGESTION'
        ? [{ id: 1145, name: 'gpt-5.4', displayName: 'openai-gpt-5.4' }]
        : [{ id: 6, name: 'gpt-4o', displayName: 'openai-gpt-4o' }]
    ),
  });

  await applyClaimConfig(claimsPath);

  const written = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
  assert.equal(written[0].newClaimName, 'my-test-claim');
});

test('applyClaimConfig resolves both model names and writes claimName/ingestionModelId/processingModelId to every claim', async (t) => {
  const { tmpDir, claimsPath } = makeTmpClaimsFile();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  withEnv(t, {
    CLAIM_NAME: 'my-test-claim',
    INGESTION_MODEL_NAME: 'openai-gpt-5.4',
    PROCESSING_MODEL_NAME: 'openai-gpt-4o',
    FRAUDX_ENDPOINT_URI: 'https://fake.fraudx.test',
    AWS_ACCESS_KEY_ID: 'AKIAFAKE',
    AWS_SECRET_ACCESS_KEY: 'fake-secret',
    AWS_REGION: 'us-east-1',
    SKIP_S3_GROUNDING: undefined,
  });
  let loginCalls = 0;
  mockFraudxClient(t, {
    login: async () => { loginCalls += 1; return { token: 't', orgId: 1, userId: 68 }; },
    searchModels: async (base, auth, typeName) => {
      if (typeName === 'INGESTION') return [{ id: 1145, name: 'gpt-5.4', displayName: 'openai-gpt-5.4' }];
      if (typeName === 'PROCESSING') return [{ id: 6, name: 'gpt-4o', displayName: 'openai-gpt-4o' }];
      throw new Error(`unexpected typeName ${typeName}`);
    },
  });

  await applyClaimConfig(claimsPath);

  assert.equal(loginCalls, 1, 'login should only be called once even though both models are resolved');
  const written = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
  assert.equal(written[0].newClaimName, 'my-test-claim');
  assert.equal(written[0].ingestionModelId, 1145);
  assert.equal(written[0].processingModelId, 6);
  assert.equal(written[0].claimCategoryId, 23, 'unrelated fields must be preserved');
});

test('applyClaimConfig propagates a clear error when a displayName does not resolve, and does not write the file', async (t) => {
  const { tmpDir, claimsPath, originalContent } = makeTmpClaimsFile();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  withEnv(t, {
    CLAIM_NAME: 'my-test-claim',
    INGESTION_MODEL_NAME: 'nonexistent-model',
    PROCESSING_MODEL_NAME: 'openai-gpt-4o',
    FRAUDX_ENDPOINT_URI: 'https://fake.fraudx.test',
    AWS_ACCESS_KEY_ID: 'AKIAFAKE',
    AWS_SECRET_ACCESS_KEY: 'fake-secret',
    AWS_REGION: 'us-east-1',
    SKIP_S3_GROUNDING: undefined,
  });
  mockFraudxClient(t, {
    login: async () => ({ token: 't', orgId: 1, userId: 68 }),
    searchModels: async () => [],
  });

  await assert.rejects(
    () => applyClaimConfig(claimsPath),
    /No INGESTION model found with displayName "nonexistent-model"/
  );
  assert.equal(fs.readFileSync(claimsPath, 'utf8'), originalContent, 'the file must be untouched if resolution fails');
});
