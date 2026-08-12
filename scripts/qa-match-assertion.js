'use strict';

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

module.exports.computeRiskStatusMatch = computeRiskStatusMatch;
module.exports.buildAnswerContentRubric = buildAnswerContentRubric;
