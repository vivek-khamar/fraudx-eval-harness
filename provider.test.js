'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fraudxClient = require('./fraudx-client');
const Provider = require('./provider');
const { extractCitedFileNames } = Provider;

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
      bucket: {
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
    triggerJobProcessing: async () => {
      calls.push('triggerJobProcessing');
      return [1];
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

test('extractCitedFileNames collects unique, decoded fileNames from every answer\'s citations', () => {
  const report = {
    questions: [
      { answer: 'x <InTextCitation fileName="JOSE%2BBRIONES.pdf"></InTextCitation>' },
      { answer: 'y <InTextCitation fileName="JOSE%2BBRIONES.pdf"></InTextCitation> and <InTextCitation fileName="other.pdf"></InTextCitation>' },
      { answer: 'no citations here' },
    ],
  };
  assert.deepEqual(extractCitedFileNames(report), ['JOSE+BRIONES.pdf', 'other.pdf']);
});

test('extractCitedFileNames returns an empty array when no answers have citations', () => {
  assert.deepEqual(extractCitedFileNames({ questions: [{ answer: 'no sources found' }] }), []);
});

test('callApi orchestrates the full sequence in order and returns the report', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  const calls = [];
  mockFraudxClient(t, happyPathMocks(calls));

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.deepEqual(calls, [
    'login',
    'listBucketDocuments',
    'createClaim',
    'getDownloadUrl',
    'downloadFile',
    'requestUploadUrls',
    'uploadFile',
    'triggerJobProcessing',
    'waitForDocumentUpload',
    'triggerClaimProcessing',
    'waitForClaimProcessing',
    'fetchReport',
  ]);
  assert.equal(typeof result.output.ingestion.timeMs, 'number');
  assert.equal(typeof result.output.processing.timeMs, 'number');
  assert.deepEqual(result.output.report, { reportId: 'report-1', summary: 's', questions: [] });
});

test('callApi measures ingestion (the upload loop) and processing (claim trigger + poll) as independent timers', async (t) => {
  // With skipGxProcess:false, each document's own GX ingestion completes during the upload loop —
  // fileMetrics.completedFiles reaches 5/5 before triggerClaimProcessing is ever called. Ingestion
  // time must reflect that loop's own duration, not be a copy of the later claim-processing duration.
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  mockFraudxClient(t, {
    ...happyPathMocks([]),
    waitForDocumentUpload: async () => {
      await sleep(30);
      return { status: 'Completed' };
    },
    waitForClaimProcessing: async () => {
      await sleep(10);
      return { bucketStatus: 'SUCCESS', latestReportId: 'report-1' };
    },
  });

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.ok(result.output.ingestion.timeMs >= 30, 'ingestion must include the upload loop\'s own wait time');
  assert.ok(
    result.output.ingestion.timeMs > result.output.processing.timeMs,
    'ingestion (longer simulated wait) must differ from processing (shorter simulated wait), proving they are measured independently'
  );
});

test('callApi ingests all source documents concurrently, not one at a time', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  mockFraudxClient(t, {
    ...happyPathMocks([]),
    listBucketDocuments: async () => [
      { gxMasterId: 1, fileName: 'a.pdf', extension: 'pdf' },
      { gxMasterId: 2, fileName: 'b.pdf', extension: 'pdf' },
    ],
    requestUploadUrls: async (base, auth, files) => [
      { fileName: files[0].fileName, jobId: files[0].fileName === 'a.pdf' ? 1 : 2, uploadUrl: 'https://s3.example/put' },
    ],
    waitForDocumentUpload: async () => {
      await sleep(60);
      return { status: 'Completed' };
    },
  });

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.ok(
    result.output.ingestion.timeMs < 110,
    `ingesting 2 documents with a 60ms wait each must overlap, not sum to ~120ms (got ${result.output.ingestion.timeMs}ms)`
  );
});

test('callApi never reads or transmits context.vars.expected', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
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

test('callApi throws a clear error when FRAUDX_ENDPOINT_URI is not set', async () => {
  delete process.env.FRAUDX_ENDPOINT_URI;
  const provider = new Provider();
  await assert.rejects(() => provider.callApi('x', fakeContext()), /FRAUDX_ENDPOINT_URI is not set/);
});

test('callApi requests each document\'s upload URL individually, right before uploading it, not all upfront', async (t) => {
  // Presigned upload URLs go stale within minutes on the real platform, but each document can now
  // take minutes of real GX processing before the next one's turn comes up — requesting all upload
  // URLs in one batch before the loop starts would let later documents' URLs expire unused.
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  const requestUploadUrlsCalls = [];
  mockFraudxClient(t, {
    ...happyPathMocks([]),
    listBucketDocuments: async () => [
      { gxMasterId: 1, fileName: 'a.pdf', extension: 'pdf' },
      { gxMasterId: 2, fileName: 'b.pdf', extension: 'pdf' },
    ],
    requestUploadUrls: async (base, auth, files, newBucketId) => {
      requestUploadUrlsCalls.push(files);
      return [{ fileName: files[0].fileName, jobId: files[0].fileName === 'a.pdf' ? 1 : 2, uploadUrl: 'https://s3.example/put' }];
    },
  });

  const provider = new Provider();
  await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.equal(requestUploadUrlsCalls.length, 2, 'requestUploadUrls must be called once per document');
  assert.deepEqual(requestUploadUrlsCalls[0], [{ fileName: 'a.pdf', contentType: 'application/pdf' }]);
  assert.deepEqual(requestUploadUrlsCalls[1], [{ fileName: 'b.pdf', contentType: 'application/pdf' }]);
});

test('callApi throws when no upload URL matches a source document\'s fileName', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  mockFraudxClient(t, {
    ...happyPathMocks([]),
    requestUploadUrls: async () => [{ fileName: 'different-name.pdf', jobId: 1, uploadUrl: 'https://s3.example/put' }],
  });

  const provider = new Provider();
  await assert.rejects(() => provider.callApi('FX-GOLD-5K-v1', fakeContext()), /No upload URL returned for file "a\.pdf"/);
});

test('callApi fetches text only for documents actually cited in the real report, truncated to 15000 chars', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  const getDownloadUrlCalls = [];
  // The pre-existing ingestion loop uploads every document in sourceDocs (including uncited.pdf) into
  // the new claim bucket, which itself calls getDownloadUrl/requestUploadUrls for both documents. Since
  // requestUploadUrls must be given a per-file response (the happyPathMocks default only knows 'a.pdf'),
  // and this test's own getDownloadUrl assertion is only about the *new* cited-fetch step (not ingestion),
  // track calls to getDownloadUrl only from the point the report is fetched onward.
  let reportFetched = false;
  mockFraudxClient(t, {
    ...happyPathMocks([]),
    listBucketDocuments: async () => [
      { gxMasterId: 1, fileName: 'a.pdf', extension: 'pdf' },
      { gxMasterId: 2, fileName: 'uncited.pdf', extension: 'pdf' },
    ],
    requestUploadUrls: async (base, auth, files) => [{ fileName: files[0].fileName, jobId: 1, uploadUrl: 'https://s3.example/put' }],
    fetchReport: async () => {
      reportFetched = true;
      return {
        reportId: 'report-1',
        summary: 's',
        questions: [{ predefinedQuestionId: 1, answer: 'see <InTextCitation fileName="a.pdf"></InTextCitation>' }],
      };
    },
    getDownloadUrl: async (base, gxMasterId) => {
      if (reportFetched) {
        getDownloadUrlCalls.push(gxMasterId);
      }
      return 'https://s3.example/get';
    },
    downloadFile: async () => new ArrayBuffer(4),
    extractPdfText: async () => 'x'.repeat(20000),
  });

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.deepEqual(getDownloadUrlCalls, [1], 'only the cited document (gxMasterId 1) should be downloaded, not the uncited one');
  assert.equal(result.output.citedDocumentsText['a.pdf'].length, 15000, 'document text must be truncated to the char limit');
  assert.equal(Object.keys(result.output.citedDocumentsText).length, 1);
});

test('callApi skips a cited fileName it cannot match to a source document, without failing the run', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  mockFraudxClient(t, {
    ...happyPathMocks([]),
    fetchReport: async () => ({
      reportId: 'report-1',
      summary: 's',
      questions: [{ predefinedQuestionId: 1, answer: 'see <InTextCitation fileName="unknown.pdf"></InTextCitation>' }],
    }),
  });

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.deepEqual(result.output.citedDocumentsText, {});
});

test('callApi returns an empty citedDocumentsText when the report has no citations', async (t) => {
  process.env.FRAUDX_ENDPOINT_URI = 'https://fake.fraudx.test';
  t.after(() => {
    delete process.env.FRAUDX_ENDPOINT_URI;
  });
  mockFraudxClient(t, happyPathMocks([]));

  const provider = new Provider();
  const result = await provider.callApi('FX-GOLD-5K-v1', fakeContext());

  assert.deepEqual(result.output.citedDocumentsText, {});
});
