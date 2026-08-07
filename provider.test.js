'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fraudxClient = require('./fraudx-client');
const Provider = require('./provider');

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

function fakeContext() {
  return {
    vars: {
      claimId: 'FX-GOLD-5K-v1',
      bucket: {
        claimId: 'FX-GOLD-5K-v1',
        sourceBucketId: 31662,
        newClaim: { bucketName: 'x', claimCategoryId: 23, ingestionModelId: 1, processingModelId: 9, tags: [] },
      },
      expected: { summarySynopsis: 'THE GOLD ANSWER — must never be sent anywhere', qa: [] },
    },
  };
}

function happyPathMocks(calls) {
  return {
    login: async () => {
      calls.push('login');
      return { token: 't', orgId: 1, userId: 68 };
    },
    listBucketDocuments: async () => {
      calls.push('listBucketDocuments');
      return [{ gxMasterId: 1, fileName: 'a.pdf', extension: 'pdf' }];
    },
    createClaim: async () => {
      calls.push('createClaim');
      return 999;
    },
    requestUploadUrls: async () => {
      calls.push('requestUploadUrls');
      return [{ fileName: 'a.pdf', jobId: 1, uploadUrl: 'https://s3.example/put' }];
    },
    getDownloadUrl: async () => {
      calls.push('getDownloadUrl');
      return 'https://s3.example/get';
    },
    downloadFile: async () => {
      calls.push('downloadFile');
      return new ArrayBuffer(4);
    },
    uploadFile: async () => {
      calls.push('uploadFile');
    },
    waitForDocumentUpload: async () => {
      calls.push('waitForDocumentUpload');
      return { status: 'Completed' };
    },
    triggerClaimProcessing: async () => {
      calls.push('triggerClaimProcessing');
      return 'task-1';
    },
    waitForClaimProcessing: async () => {
      calls.push('waitForClaimProcessing');
      return { bucketStatus: 'SUCCESS', latestReportId: 'report-1' };
    },
    fetchReport: async () => {
      calls.push('fetchReport');
      return { reportId: 'report-1', summary: 's', questions: [] };
    },
  };
}

test('callApi orchestrates the full sequence in order and returns the report', async (t) => {
  process.env.FRAUDX_TEST_ENDPOINT = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_TEST_ENDPOINT;
  });
  const calls = [];
  mockFraudxClient(t, happyPathMocks(calls));

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.deepEqual(calls, [
    'login',
    'listBucketDocuments',
    'createClaim',
    'requestUploadUrls',
    'getDownloadUrl',
    'downloadFile',
    'uploadFile',
    'waitForDocumentUpload',
    'triggerClaimProcessing',
    'waitForClaimProcessing',
    'fetchReport',
  ]);
  assert.equal(typeof result.output.ingestion.timeMs, 'number');
  assert.equal(result.output.ingestion.timeMs, result.output.processing.timeMs, 'ingestion and processing must report the same collapsed measurement');
  assert.deepEqual(result.output.report, { reportId: 'report-1', summary: 's', questions: [] });
});

test('callApi never reads or transmits context.vars.expected', async (t) => {
  process.env.FRAUDX_TEST_ENDPOINT = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_TEST_ENDPOINT;
  });
  const seenArgs = [];
  mockFraudxClient(t, {
    ...happyPathMocks([]),
    createClaim: async (...args) => {
      seenArgs.push(JSON.stringify(args));
      return 999;
    },
  });

  const provider = new Provider();
  await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  for (const arg of seenArgs) {
    assert.ok(!arg.includes('THE GOLD ANSWER'), 'the answer key must never be passed to fraudx-client.js calls');
  }
});

test('callApi throws a clear error when FRAUDX_TEST_ENDPOINT is not set', async () => {
  delete process.env.FRAUDX_TEST_ENDPOINT;
  const provider = new Provider();
  await assert.rejects(() => provider.callApi('x', fakeContext()), /FRAUDX_TEST_ENDPOINT is not set/);
});

test('callApi throws when no upload URL matches a source document\'s fileName', async (t) => {
  process.env.FRAUDX_TEST_ENDPOINT = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_TEST_ENDPOINT;
  });
  mockFraudxClient(t, {
    ...happyPathMocks([]),
    requestUploadUrls: async () => [{ fileName: 'different-name.pdf', jobId: 1, uploadUrl: 'https://s3.example/put' }],
  });

  const provider = new Provider();
  await assert.rejects(() => provider.callApi('FX-GOLD-5K-v1', fakeContext()), /No upload URL returned for file "a\.pdf"/);
});
