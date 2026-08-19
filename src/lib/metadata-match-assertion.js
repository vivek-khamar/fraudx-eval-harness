'use strict';

function normalize(str) {
  return (str || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function stripTrailingAbbreviation(str) {
  return normalize(str).replace(/\s*\([^)]*\)\s*$/, '');
}

// Removes ALL whitespace (not just collapsing repeats), so a compound word split by a space on
// only one side of the comparison ("OneTeam" vs "One Team") still matches. FraudX's own entity
// extraction is inconsistent about exactly this kind of word-boundary spacing for the same
// entity — this is display/extraction noise, not evidence of a different entity.
function stripAllWhitespace(str) {
  return (str || '').trim().toLowerCase().replace(/\s+/g, '');
}

function entitiesMatch(actual, expected) {
  return normalize(actual) === normalize(expected)
    || stripTrailingAbbreviation(actual) === stripTrailingAbbreviation(expected)
    || stripAllWhitespace(actual) === stripAllWhitespace(expected);
}

function fraudRiskScoreMatches(actual, expected) {
  return Math.abs(actual - expected) <= 0.1 + 1e-9;
}

function metadataMatchAssertion(output, context) {
  const expected = context.vars.expected;
  const report = output.report;

  const fraudRiskScoreMatch = fraudRiskScoreMatches(report.fraudRiskScore, expected.fraudRiskScore) ? 1 : 0;

  const entityFields = [
    [report.claimantName, expected.claimantName],
    [report.defendant, expected.defendant],
    [report.insuranceFirm, expected.insuranceFirm],
  ];
  const entityMatchCount = entityFields.filter(([actual, exp]) => entitiesMatch(actual, exp)).length;
  const entityFieldsMatch = entityMatchCount / entityFields.length;

  const score = (fraudRiskScoreMatch + entityFieldsMatch) / 2;

  const metadataMatchAssert = context.test && Array.isArray(context.test.assert)
    ? context.test.assert.find((a) => a.metric === 'metadata_match')
    : undefined;
  const threshold = metadataMatchAssert && metadataMatchAssert.threshold;
  const pass = threshold === undefined ? score > 0 : score >= threshold;

  return {
    pass,
    score,
    reason: `fraudRiskScoreMatch=${fraudRiskScoreMatch}, entityFieldsMatch=${entityFieldsMatch}`,
    namedScores: { fraudRiskScoreMatch, entityFieldsMatch },
  };
}

module.exports = metadataMatchAssertion;
module.exports.normalize = normalize;
module.exports.entitiesMatch = entitiesMatch;
module.exports.stripAllWhitespace = stripAllWhitespace;
module.exports.fraudRiskScoreMatches = fraudRiskScoreMatches;
