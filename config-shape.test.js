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

test('qa_summary_accuracy rubric dumps expected.qa as JSON instead of stringifying the object', () => {
  const rubric = config.tests[0].assert.find((a) => a.metric === 'qa_summary_accuracy');
  assert.ok(rubric.value.includes('expected.qa | dump'));
  assert.ok(!rubric.value.includes('{{expected.qa}}'));
});

test('citation_accuracy javascript assertion actually computes the fraction of matching citations when executed the way promptfoo runs it', () => {
  const citation = config.tests[0].assert.find((a) => a.metric === 'citation_accuracy');
  const value = citation.value;
  // Mirrors promptfoo's assertions/javascript.js: when the rendered value contains a
  // newline, it is run as a raw function body via `new Function('output', 'context', functionBody)`,
  // with NO automatic `return` prepended.
  assert.ok(value.includes('\n'), 'expected the block scalar to preserve newlines, as promptfoo would see it');
  const fn = new Function('output', 'context', value);

  const claim = JSON.parse(fs.readFileSync(path.join(__dirname, 'testdata', 'golden_claim_docs.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'testdata', 'golden_claim_expected.json'), 'utf8'));

  const context = { vars: { claimId: claim.claimId, documentIds: claim, expected } };

  const perfectOutput = {
    report: {
      qa: expected.qa.map((e) => ({
        questionId: e.questionId,
        answer: e.answer,
        citation: { documentId: e.citation.documentId, page: e.citation.page },
      })),
    },
  };
  assert.equal(fn(perfectOutput, context), 1);

  const oneWrongOutput = {
    report: {
      qa: expected.qa.map((e, i) => ({
        questionId: e.questionId,
        answer: e.answer,
        citation:
          i === 0
            ? { documentId: 'doc_9999', page: 999 }
            : { documentId: e.citation.documentId, page: e.citation.page },
      })),
    },
  };
  assert.equal(fn(oneWrongOutput, context), 0.5);
});

test('defaultTest pins the grading provider so a machine-local OPENAI_API_KEY cannot silently switch the judge model', () => {
  assert.equal(config.defaultTest.options.provider, 'anthropic:messages:claude-sonnet-4-5');
});
