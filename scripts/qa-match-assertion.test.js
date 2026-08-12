'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRiskStatusMatch } = require('./qa-match-assertion');

test('computeRiskStatusMatch returns the fraction of matching risk determinations', () => {
  const expectedQa = [
    { predefinedQuestionId: 1, expectedRiskStatus: 'RISK_DETECTED' },
    { predefinedQuestionId: 2, expectedRiskStatus: 'UNSURE' },
    { predefinedQuestionId: 3, expectedRiskStatus: 'RISK_DETECTED' },
  ];
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 1, riskStatus: 'RISK_DETECTED' },
        { predefinedQuestionId: 2, riskStatus: 'RISK_DETECTED' }, // mismatch vs UNSURE
        { predefinedQuestionId: 3, riskStatus: 'RISK_DETECTED' },
      ],
    },
  };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 2 / 3);
});

test('computeRiskStatusMatch returns 0 for a question missing from the real report entirely', () => {
  const expectedQa = [{ predefinedQuestionId: 1, expectedRiskStatus: 'RISK_DETECTED' }];
  const output = { report: { questions: [] } };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 0);
});
