'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const configPath = path.join(__dirname, 'promptfooconfig.yaml');
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

test('config declares exactly one provider pointing at the local src/provider.js', () => {
  assert.ok(Array.isArray(config.providers));
  assert.equal(config.providers.length, 1);
  assert.equal(config.providers[0].id, 'file://src/provider.js');
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

test('config declares exactly three assertions: qa_match, report_quality, metadata_match', () => {
  const asserts = config.defaultTest.assert;
  assert.ok(Array.isArray(asserts));
  assert.equal(asserts.length, 3);

  const qaMatch = asserts.find((a) => a.metric === 'qa_match');
  assert.equal(qaMatch.type, 'javascript');
  assert.equal(qaMatch.value, 'file://src/lib/qa-match-assertion.js');

  const reportQuality = asserts.find((a) => a.metric === 'report_quality');
  assert.equal(reportQuality.type, 'llm-rubric');
  assert.ok(reportQuality.value.includes('{{expected.summarySynopsis}}'));
  assert.ok(reportQuality.value.toLowerCase().includes('citeddocumentstext'));

  const metadataMatch = asserts.find((a) => a.metric === 'metadata_match');
  assert.equal(metadataMatch.type, 'javascript');
  assert.equal(metadataMatch.value, 'file://src/lib/metadata-match-assertion.js');
});
