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

const { buildAnswerContentRubric } = require('./qa-match-assertion');

test('buildAnswerContentRubric embeds every expected question, its expected answer, and the matching actual answer', () => {
  const expectedQa = [
    { predefinedQuestionId: 1, question: 'Is there fraud?', expectedAnswerSummary: 'Yes, per doc X.' },
  ];
  const actualQuestions = [{ predefinedQuestionId: 1, answer: 'Yes, doc X confirms it.' }];

  const rubric = buildAnswerContentRubric(expectedQa, actualQuestions);

  assert.match(rubric, /Is there fraud\?/);
  assert.match(rubric, /Yes, per doc X\./);
  assert.match(rubric, /Yes, doc X confirms it\./);
  assert.match(rubric, /fraction of pairs that match/);
});

test('buildAnswerContentRubric marks a question missing from the actual report as no answer provided', () => {
  const expectedQa = [
    { predefinedQuestionId: 99, question: 'Missing question?', expectedAnswerSummary: 'Some expected answer.' },
  ];
  const actualQuestions = [];

  const rubric = buildAnswerContentRubric(expectedQa, actualQuestions);

  assert.match(rubric, /NO ANSWER PROVIDED/);
});
