'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bucket = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden_claim_bucket.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden_claim_expected.json'), 'utf8'));

test('golden_claim_bucket.json has a claimId, a sourceBucketId, and a newClaim config', () => {
  assert.equal(typeof bucket.claimId, 'string');
  assert.ok(bucket.claimId.length > 0);
  assert.equal(typeof bucket.sourceBucketId, 'number');

  assert.equal(typeof bucket.newClaim.bucketName, 'string');
  assert.ok(bucket.newClaim.bucketName.length > 0);
  assert.equal(typeof bucket.newClaim.claimCategoryId, 'number');
  assert.equal(typeof bucket.newClaim.ingestionModelId, 'number');
  assert.equal(typeof bucket.newClaim.processingModelId, 'number');
  assert.ok(Array.isArray(bucket.newClaim.tags));
  for (const tag of bucket.newClaim.tags) {
    assert.equal(typeof tag.tagId, 'number');
    assert.equal(typeof tag.tagValueId, 'number');
  }
});

test('golden_claim_expected.json has a summary and exactly 35 predefined-question entries', () => {
  assert.equal(typeof expected.summarySynopsis, 'string');
  assert.ok(expected.summarySynopsis.length > 0);

  assert.ok(Array.isArray(expected.qa));
  assert.equal(expected.qa.length, 35, 'golden_claim_expected.json must have one entry per predefined question in claim category 23 — see the report-fetch design doc');

  const seenIds = new Set();
  for (const entry of expected.qa) {
    assert.equal(typeof entry.predefinedQuestionId, 'number');
    assert.ok(!seenIds.has(entry.predefinedQuestionId), `duplicate predefinedQuestionId ${entry.predefinedQuestionId}`);
    seenIds.add(entry.predefinedQuestionId);
    assert.equal(typeof entry.question, 'string');
    assert.equal(typeof entry.expectedAnswerSummary, 'string');
    assert.equal(typeof entry.expectedRiskStatus, 'string');
    assert.ok(Array.isArray(entry.expectedCitationFileNames));
    for (const fileName of entry.expectedCitationFileNames) {
      assert.equal(typeof fileName, 'string');
    }
  }
});
