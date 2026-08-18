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
