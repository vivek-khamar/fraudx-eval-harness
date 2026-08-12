'use strict';

const promptfoo = require('promptfoo');

function computeRiskStatusMatch(output, expectedQa) {
  const actualQuestions = output.report.questions;
  const matched = expectedQa.filter((q) => {
    const actual = actualQuestions.find((r) => r.predefinedQuestionId === q.predefinedQuestionId);
    return actual && actual.riskStatus === q.expectedRiskStatus;
  }).length;
  return matched / expectedQa.length;
}

function buildAnswerContentRubric(expectedQa, actualQuestions) {
  const pairs = expectedQa.map((q) => {
    const actual = actualQuestions.find((r) => r.predefinedQuestionId === q.predefinedQuestionId);
    const actualAnswer = actual && actual.answer ? actual.answer : 'NO ANSWER PROVIDED';
    return [
      `Question ${q.predefinedQuestionId}: ${q.question}`,
      `Expected answer: ${q.expectedAnswerSummary}`,
      `Model answer: ${actualAnswer}`,
    ].join('\n');
  });

  return [
    "The output above lists report.questions, each with a predefinedQuestionId and an answer.",
    'For each of the following expected question/answer pairs, judge whether the model answer\'s',
    'content and reasoning semantically match the expected answer below (exact wording does not',
    'matter, meaning does). Then return the fraction of pairs that match as a single number',
    'between 0 and 1 — output only that number.',
    '',
    ...pairs,
  ].join('\n');
}

async function qaMatchAssertion(output, context) {
  const expectedQa = context.vars.expected.qa;
  const actualQuestions = output.report.questions;

  const riskStatusMatch = computeRiskStatusMatch(output, expectedQa);

  const rubric = buildAnswerContentRubric(expectedQa, actualQuestions);
  const llmOutput = JSON.stringify(actualQuestions);
  const grading = context.test && context.test.options;
  const rubricResult = await promptfoo.matchesLlmRubric(rubric, llmOutput, grading, context.vars);
  const answerContentMatch = rubricResult.score;

  const score = (riskStatusMatch + answerContentMatch) / 2;

  const qaMatchAssert = context.test && Array.isArray(context.test.assert)
    ? context.test.assert.find((a) => a.metric === 'qa_match')
    : undefined;
  const threshold = qaMatchAssert && qaMatchAssert.threshold;
  const pass = threshold === undefined ? score > 0 : score >= threshold;

  return {
    pass,
    score,
    reason: `riskStatusMatch=${riskStatusMatch}, answerContentMatch=${answerContentMatch}`,
    namedScores: { riskStatusMatch, answerContentMatch },
  };
}

module.exports = qaMatchAssertion;
module.exports.computeRiskStatusMatch = computeRiskStatusMatch;
module.exports.buildAnswerContentRubric = buildAnswerContentRubric;
