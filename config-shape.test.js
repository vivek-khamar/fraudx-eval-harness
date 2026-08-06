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

test('config declares one test case wired to the golden claim fixtures', () => {
  assert.ok(Array.isArray(config.tests));
  assert.equal(config.tests.length, 1);
  const testCase = config.tests[0];
  assert.equal(testCase.vars.claimId, 'FX-GOLD-5K-v1');
  assert.equal(testCase.vars.documentIds, 'file://testdata/golden_claim_docs.json');
  assert.equal(testCase.vars.expected, 'file://testdata/golden_claim_expected.json');
});

test('config declares the qa_summary_accuracy (llm-rubric) and citation_accuracy (javascript) assertions', () => {
  const asserts = config.tests[0].assert;
  assert.ok(Array.isArray(asserts));
  assert.equal(asserts.length, 2);

  const rubric = asserts.find((a) => a.metric === 'qa_summary_accuracy');
  assert.equal(rubric.type, 'llm-rubric');
  assert.ok(rubric.value.includes('{{expected.summarySynopsis}}'));

  const citation = asserts.find((a) => a.metric === 'citation_accuracy');
  assert.equal(citation.type, 'javascript');
  assert.equal(citation.threshold, 0.95);
  assert.ok(citation.value.includes('context.vars.expected.qa'));
});
