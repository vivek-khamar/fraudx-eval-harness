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
    'The pairs below list each predefined question, its expected answer, and the model\'s actual answer.',
    'For each pair, judge whether the model answer\'s content and reasoning semantically match the',
    'expected answer (exact wording does not matter, meaning does). Report the fraction of pairs that match',
    'as the `score` field of your JSON response, between 0 and 1.',
    '',
    ...pairs,
  ].join('\n');
}

function buildQuestionGradingPrompt(question, actualAnswer) {
  return [
    `Question: ${question.question}`,
    `Expected answer: ${question.expectedAnswerSummary}`,
    `Model answer: ${actualAnswer}`,
    '',
    "Does the model answer's content and reasoning semantically match the expected answer above",
    '(exact wording does not matter, meaning does)? Respond with only a JSON object, no other text:',
    '{"matches": boolean, "reason": string}.',
  ].join('\n');
}

function parseGraderVerdict(responseOutput) {
  const text = typeof responseOutput === 'string' ? responseOutput : JSON.stringify(responseOutput);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Could not find a JSON object in grader response: ${text}`);
  }
  const parsed = JSON.parse(match[0]);
  if (typeof parsed.matches !== 'boolean' || typeof parsed.reason !== 'string') {
    throw new Error(`Grader response JSON missing matches/reason fields: ${text}`);
  }
  return { matches: parsed.matches, reason: parsed.reason };
}

async function qaMatchAssertion(output, context) {
  const expectedQa = context.vars.expected.qa;
  const actualQuestions = output.report.questions;

  const riskStatusMatch = computeRiskStatusMatch(output, expectedQa);

  const rubric = buildAnswerContentRubric(expectedQa, actualQuestions);
  const llmOutput = JSON.stringify(actualQuestions);
  const grading = context.test && context.test.options;
  const rubricResult = await promptfoo.assertions.matchesLlmRubric(rubric, llmOutput, grading, context.vars, undefined, { throwOnError: true });
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
module.exports.buildQuestionGradingPrompt = buildQuestionGradingPrompt;
module.exports.parseGraderVerdict = parseGraderVerdict;
