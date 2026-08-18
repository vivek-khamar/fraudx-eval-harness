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
