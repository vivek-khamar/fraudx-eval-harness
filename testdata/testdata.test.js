'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const docs = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden_claim_docs.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden_claim_expected.json'), 'utf8'));

test('golden_claim_docs.json has a claimId and a non-empty array of document pointers', () => {
  assert.equal(typeof docs.claimId, 'string');
  assert.ok(docs.claimId.length > 0);
  assert.ok(Array.isArray(docs.documentIds));
  assert.ok(docs.documentIds.length > 0);
  for (const id of docs.documentIds) {
    assert.equal(typeof id, 'string');
  }
});

test('golden_claim_expected.json has a summary, a fraud score band, and a QA battery with citations', () => {
  assert.equal(typeof expected.summarySynopsis, 'string');
  assert.ok(expected.summarySynopsis.length > 0);

  assert.equal(typeof expected.fraudScoreBand.min, 'number');
  assert.equal(typeof expected.fraudScoreBand.max, 'number');
  assert.ok(expected.fraudScoreBand.min <= expected.fraudScoreBand.max);

  assert.ok(Array.isArray(expected.qa));
  assert.ok(expected.qa.length > 0);
  for (const entry of expected.qa) {
    assert.equal(typeof entry.questionId, 'string');
    assert.equal(typeof entry.answer, 'string');
    assert.equal(typeof entry.citation.documentId, 'string');
    assert.equal(typeof entry.citation.page, 'number');
  }
});

test('every citation in the expected QA battery points at a document that was actually ingested', () => {
  const ingestedIds = new Set(docs.documentIds);
  for (const entry of expected.qa) {
    assert.ok(
      ingestedIds.has(entry.citation.documentId),
      `citation for ${entry.questionId} points at ${entry.citation.documentId}, which is not in golden_claim_docs.json`
    );
  }
});
