'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callApi } = require('./provider');

function fakeContext() {
  return {
    vars: {
      claimId: 'FX-GOLD-5K-v1',
      documentIds: { claimId: 'FX-GOLD-5K-v1', documentIds: ['doc_0001', 'doc_0002'] },
      expected: { summarySynopsis: 'THE GOLD ANSWER — must never be sent anywhere', qa: [] },
    },
  };
}

test('callApi calls ingest then process against FRAUDX_TEST_ENDPOINT and returns timing plus the report', async (t) => {
  const calls = [];
  const originalFetch = global.fetch;
  const originalEndpoint = process.env.FRAUDX_TEST_ENDPOINT;
  process.env.FRAUDX_TEST_ENDPOINT = 'https://fake.fraudx.test';

  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (url === 'https://fake.fraudx.test/internal/eval/ingest') {
      return { ok: true, json: async () => ({ indexedDocumentCount: 2 }) };
    }
    if (url === 'https://fake.fraudx.test/internal/eval/process') {
      return {
        ok: true,
        json: async () => ({
          report: {
            summary: 'a generated summary',
            qa: [{ questionId: 'q1_diagnosis', answer: 'x', citation: { documentId: 'doc_0112', page: 4 } }],
          },
        }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  t.after(() => {
    global.fetch = originalFetch;
    process.env.FRAUDX_TEST_ENDPOINT = originalEndpoint;
  });

  const result = await callApi('FX-GOLD-5K-v1', fakeContext());

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://fake.fraudx.test/internal/eval/ingest');
  assert.deepEqual(calls[0].body, { claimId: 'FX-GOLD-5K-v1', documentIds: ['doc_0001', 'doc_0002'] });
  assert.equal(calls[1].url, 'https://fake.fraudx.test/internal/eval/process');
  assert.deepEqual(calls[1].body, { claimId: 'FX-GOLD-5K-v1' });

  assert.equal(typeof result.output.ingestion.timeMs, 'number');
  assert.equal(typeof result.output.processing.timeMs, 'number');
  assert.equal(result.output.report.summary, 'a generated summary');
  assert.equal(result.output.report.qa[0].questionId, 'q1_diagnosis');
});

test('callApi never reads or transmits context.vars.expected', async (t) => {
  const originalFetch = global.fetch;
  const originalEndpoint = process.env.FRAUDX_TEST_ENDPOINT;
  process.env.FRAUDX_TEST_ENDPOINT = 'https://fake.fraudx.test';

  const sentBodies = [];
  global.fetch = async (url, opts) => {
    sentBodies.push(opts.body);
    if (url.endsWith('/ingest')) return { ok: true, json: async () => ({}) };
    return { ok: true, json: async () => ({ report: { summary: 's', qa: [] } }) };
  };

  t.after(() => {
    global.fetch = originalFetch;
    process.env.FRAUDX_TEST_ENDPOINT = originalEndpoint;
  });

  await callApi('FX-GOLD-5K-v1', fakeContext());

  for (const body of sentBodies) {
    assert.ok(!body.includes('THE GOLD ANSWER'), 'the answer key must never be sent to the pipeline');
  }
});

test('callApi throws a clear error when FRAUDX_TEST_ENDPOINT is not set', async () => {
  const original = process.env.FRAUDX_TEST_ENDPOINT;
  delete process.env.FRAUDX_TEST_ENDPOINT;
  try {
    await assert.rejects(
      () => callApi('FX-GOLD-5K-v1', fakeContext()),
      /FRAUDX_TEST_ENDPOINT is not set/
    );
  } finally {
    process.env.FRAUDX_TEST_ENDPOINT = original;
  }
});

test('callApi surfaces a clear error when the ingest endpoint responds with a non-2xx status', async (t) => {
  const originalFetch = global.fetch;
  const originalEndpoint = process.env.FRAUDX_TEST_ENDPOINT;
  process.env.FRAUDX_TEST_ENDPOINT = 'https://fake.fraudx.test';

  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });

  t.after(() => {
    global.fetch = originalFetch;
    process.env.FRAUDX_TEST_ENDPOINT = originalEndpoint;
  });

  await assert.rejects(
    () => callApi('FX-GOLD-5K-v1', fakeContext()),
    /Ingestion failed for FX-GOLD-5K-v1: 500 boom/
  );
});
