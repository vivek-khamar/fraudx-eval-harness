'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const configPath = path.join(__dirname, 'promptfooconfig.yaml');
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

const testsVarsPath = path.join(__dirname, 'tests.vars.yaml');
const testCases = yaml.load(fs.readFileSync(testsVarsPath, 'utf8'));

test('config declares exactly one provider pointing at the local provider.js', () => {
  assert.ok(Array.isArray(config.providers));
  assert.equal(config.providers.length, 1);
  assert.equal(config.providers[0].id, 'file://provider.js');
});

test('config reads the grading provider from GRADER_PROVIDER with no hardcoded default', () => {
  const provider = config.defaultTest.options.provider;
  assert.equal(provider, '{{ env.GRADER_PROVIDER }}');
});

test('config loads test cases from tests.vars.yaml via a whole-file reference, not per-field file:// vars', () => {
  // promptfoo@0.122.0 leaves a per-field `vars.bucket: file://x.json` unresolved (raw file text,
  // never JSON-parsed) — see commit 1af5c85. A top-level `tests: file://tests.vars.yaml` reference
  // goes through a different code path (loadTestsFromGlob) that parses the whole file up front, so
  // bucket/expected arrive as real objects. Do not go back to per-field file:// vars.
  assert.equal(config.tests, 'file://tests.vars.yaml');
});

test('tests.vars.yaml declares one test case per golden claim bucket fixture', () => {
  assert.ok(Array.isArray(testCases));
  assert.ok(testCases.length >= 1);
  for (const testCase of testCases) {
    assert.equal(typeof testCase.vars.claimId, 'string');
    assert.ok(typeof testCase.vars.bucket === 'object' && testCase.vars.bucket !== null, 'vars.bucket must be an inline object, not a file:// reference');
    assert.ok(typeof testCase.vars.expected === 'object' && testCase.vars.expected !== null, 'vars.expected must be an inline object, not a file:// reference');
  }
});

test('every test case\'s vars.bucket has a sourceBucketId and a newClaim config', () => {
  for (const testCase of testCases) {
    const bucket = testCase.vars.bucket;
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
  }
});

test('every test case\'s vars.expected has a summary and at least one predefined-question entry', () => {
  for (const testCase of testCases) {
    const expected = testCase.vars.expected;
    assert.equal(typeof expected.summarySynopsis, 'string');
    assert.ok(expected.summarySynopsis.length > 0);

    assert.ok(Array.isArray(expected.qa));
    assert.ok(expected.qa.length > 0, `vars.expected.qa must have at least one entry (claimId: ${testCase.vars.claimId})`);

    const seenIds = new Set();
    for (const entry of expected.qa) {
      assert.equal(typeof entry.predefinedQuestionId, 'number');
      assert.ok(!seenIds.has(entry.predefinedQuestionId), `duplicate predefinedQuestionId ${entry.predefinedQuestionId} (claimId: ${testCase.vars.claimId})`);
      seenIds.add(entry.predefinedQuestionId);
      assert.equal(typeof entry.question, 'string');
      assert.equal(typeof entry.expectedAnswerSummary, 'string');
      assert.equal(typeof entry.expectedRiskStatus, 'string');
      assert.ok(Array.isArray(entry.expectedCitationFileNames));
      for (const fileName of entry.expectedCitationFileNames) {
        assert.equal(typeof fileName, 'string');
      }
    }
  }
});

test('config declares exactly two assertions: qa_match, report_quality', () => {
  const asserts = config.defaultTest.assert;
  assert.ok(Array.isArray(asserts));
  assert.equal(asserts.length, 2);

  const qaMatch = asserts.find((a) => a.metric === 'qa_match');
  assert.equal(qaMatch.type, 'javascript');
  assert.equal(qaMatch.value, 'file://scripts/qa-match-assertion.js');

  const reportQuality = asserts.find((a) => a.metric === 'report_quality');
  assert.equal(reportQuality.type, 'llm-rubric');
  assert.ok(reportQuality.value.includes('{{expected.summarySynopsis}}'));
  assert.ok(reportQuality.value.toLowerCase().includes('citeddocumentstext'));
});
