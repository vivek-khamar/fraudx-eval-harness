'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const configPath = path.join(__dirname, 'promptfooconfig.yaml');
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

test('config declares exactly one provider pointing at the local provider.js', () => {
  assert.ok(Array.isArray(config.providers));
  assert.equal(config.providers.length, 1);
  assert.equal(config.providers[0].id, 'file://provider.js');
});

test('config pins the grading provider via defaultTest', () => {
  assert.equal(config.defaultTest.options.provider, 'anthropic:messages:claude-sonnet-4-5');
});

test('config declares one test case wired to the golden claim bucket fixture', () => {
  assert.ok(Array.isArray(config.tests));
  assert.equal(config.tests.length, 1);
  const testCase = config.tests[0];
  assert.equal(testCase.vars.claimId, 'FX-GOLD-5K-v1');
  assert.ok(typeof testCase.vars.bucket === 'object' && testCase.vars.bucket !== null, 'vars.bucket must be an inline object, not a file:// reference');
  assert.ok(typeof testCase.vars.expected === 'object' && testCase.vars.expected !== null, 'vars.expected must be an inline object, not a file:// reference');
});

test('vars.bucket has a claimId, a sourceBucketId, and a newClaim config', () => {
  const bucket = config.tests[0].vars.bucket;
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

test('vars.expected has a summary and exactly 35 predefined-question entries', () => {
  const expected = config.tests[0].vars.expected;
  assert.equal(typeof expected.summarySynopsis, 'string');
  assert.ok(expected.summarySynopsis.length > 0);

  assert.ok(Array.isArray(expected.qa));
  assert.equal(expected.qa.length, 35, 'vars.expected.qa must have one entry per predefined question in claim category 23 — see the report-fetch design doc');

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

test('config declares the qa_summary_accuracy (llm-rubric) and citation_accuracy (javascript) assertions', () => {
  const asserts = config.tests[0].assert;
  assert.ok(Array.isArray(asserts));
  assert.equal(asserts.length, 2);

  const rubric = asserts.find((a) => a.metric === 'qa_summary_accuracy');
  assert.equal(rubric.type, 'llm-rubric');
  assert.ok(rubric.value.includes('{{expected.summarySynopsis}}'));
  assert.ok(rubric.value.includes('expected.qa | dump'));
  assert.ok(!rubric.value.includes('{{expected.qa}}'));

  const citation = asserts.find((a) => a.metric === 'citation_accuracy');
  assert.equal(citation.type, 'javascript');
  assert.equal(citation.threshold, 0.95);
  assert.ok(citation.value.includes('InTextCitation'));
  assert.ok(citation.value.includes('expectedCitationFileNames'));
  assert.ok(citation.value.includes('return'), 'assertion body must use |- with an explicit return, not >- folding');
});

test('citation_accuracy assertion, executed the way promptfoo runs it, computes the fraction of matching citations', () => {
  const citation = config.tests[0].assert.find((a) => a.metric === 'citation_accuracy');
  assert.ok(citation.value.includes('\n'), 'value must be multi-line so promptfoo treats it as a raw function body needing an explicit return');

  const fn = new Function('output', 'context', citation.value);

  const expectedQa = [
    { predefinedQuestionId: 1, expectedCitationFileNames: ['a.pdf'] },
    { predefinedQuestionId: 2, expectedCitationFileNames: ['b.pdf'] },
    { predefinedQuestionId: 3, expectedCitationFileNames: [] },
  ];
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 1, answer: 'x <InTextCitation fileName="a.pdf"></InTextCitation>' },
        { predefinedQuestionId: 2, answer: 'y <InTextCitation fileName="wrong.pdf"></InTextCitation>' },
        { predefinedQuestionId: 3, answer: 'No sources found' },
      ],
    },
  };
  const result = fn(output, { vars: { expected: { qa: expectedQa } } });
  assert.equal(result, 0.5); // 1 of 2 citation-bearing questions matched; question 3 excluded (no citation expected)
});
