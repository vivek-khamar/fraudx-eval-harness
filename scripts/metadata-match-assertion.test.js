'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const metadataMatchAssertion = require('./metadata-match-assertion');
const { normalize, entitiesMatch, fraudRiskScoreMatches } = require('./metadata-match-assertion');

test('normalize trims, lowercases, and collapses repeated whitespace', () => {
  assert.equal(normalize('  One Team   Restoration, Inc.  '), 'one team restoration, inc.');
});

test('entitiesMatch is true for case/whitespace-only differences', () => {
  assert.equal(entitiesMatch('New York State Insurance Fund (NYSIF)', '  new york state insurance fund (nysif)  '), true);
});

test('entitiesMatch is false for genuinely different spelling, not just case/whitespace', () => {
  assert.equal(entitiesMatch('One Team Restoration, Inc.', 'OneTeam Restoration, Inc.'), false);
});

test('fraudRiskScoreMatches is true at exactly the 0.1 boundary', () => {
  assert.equal(fraudRiskScoreMatches(0.7, 0.8), true);
  assert.equal(fraudRiskScoreMatches(0.8, 0.7), true);
});

test('fraudRiskScoreMatches is false just outside the 0.1 boundary', () => {
  assert.equal(fraudRiskScoreMatches(0.68, 0.8), false);
});

test('metadataMatchAssertion scores 1/1 for both sub-scores when everything matches', () => {
  const output = { report: { fraudRiskScore: 0.7, claimantName: 'Jose Briones', defendant: 'One Team Restoration, Inc.', insuranceFirm: 'NYSIF' } };
  const context = {
    vars: { expected: { fraudRiskScore: 0.68, claimantName: 'jose briones', defendant: 'one team restoration, inc.', insuranceFirm: 'nysif' } },
    test: { assert: [{ metric: 'metadata_match' }] },
  };

  const result = metadataMatchAssertion(output, context);

  assert.equal(result.namedScores.fraudRiskScoreMatch, 1);
  assert.equal(result.namedScores.entityFieldsMatch, 1);
  assert.equal(result.score, 1);
  assert.equal(result.pass, true);
});

test('metadataMatchAssertion computes entityFieldsMatch as a fraction when only some entity fields match', () => {
  const output = { report: { fraudRiskScore: 0.7, claimantName: 'Jose Briones', defendant: 'Wrong Defendant', insuranceFirm: 'NYSIF' } };
  const context = {
    vars: { expected: { fraudRiskScore: 0.7, claimantName: 'Jose Briones', defendant: 'One Team Restoration, Inc.', insuranceFirm: 'NYSIF' } },
    test: { assert: [{ metric: 'metadata_match' }] },
  };

  const result = metadataMatchAssertion(output, context);

  assert.equal(result.namedScores.fraudRiskScoreMatch, 1);
  assert.equal(result.namedScores.entityFieldsMatch, 2 / 3);
});

test('metadataMatchAssertion fails when score is below an explicit threshold on the metadata_match assert entry', () => {
  const output = { report: { fraudRiskScore: 0.1, claimantName: 'Wrong', defendant: 'Wrong', insuranceFirm: 'Wrong' } };
  const context = {
    vars: { expected: { fraudRiskScore: 0.9, claimantName: 'Right', defendant: 'Right', insuranceFirm: 'Right' } },
    test: { assert: [{ metric: 'metadata_match', threshold: 0.5 }] },
  };

  const result = metadataMatchAssertion(output, context);

  assert.equal(result.namedScores.fraudRiskScoreMatch, 0);
  assert.equal(result.namedScores.entityFieldsMatch, 0);
  assert.equal(result.pass, false);
});
