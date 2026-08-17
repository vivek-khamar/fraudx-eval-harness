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

test('fetchChunkGroundingData converts an S3 timeout into a clear timed-out error', async (t) => {
  mockSend(t, async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  });

  await assert.rejects(
    () => fetchChunkGroundingData(12345, 5000),
    /Fetching the chunk-grounding file for bucketId 12345 timed out after 5000ms/
  );
});

test('fetchChunkGroundingData converts an aborted S3 request into the same timed-out error', async (t) => {
  mockSend(t, async () => {
    const err = new Error('Request aborted');
    err.name = 'AbortError';
    throw err;
  });

  await assert.rejects(
    () => fetchChunkGroundingData(12345, 5000),
    /Fetching the chunk-grounding file for bucketId 12345 timed out after 5000ms/
  );
});
