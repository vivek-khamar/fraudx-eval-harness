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

  const provider = await promptfoo.loadApiProvider(context.test.options.provider);
  const perQuestionBreakdown = [];
  for (const q of expectedQa) {
    const actual = actualQuestions.find((r) => r.predefinedQuestionId === q.predefinedQuestionId);
    const actualAnswer = actual && actual.answer ? actual.answer : 'NO ANSWER PROVIDED';
    const prompt = buildQuestionGradingPrompt(q, actualAnswer);
    const response = await provider.callApi(prompt);
    if (response.error) {
      throw new Error(response.error);
    }
    const { matches, reason } = parseGraderVerdict(response.output);
    const riskStatus = actual && actual.riskStatus;
    perQuestionBreakdown.push({ predefinedQuestionId: q.predefinedQuestionId, question: q.question, actualAnswer, riskStatus, matches, reason });
  }
  const answerContentMatch = perQuestionBreakdown.filter((v) => v.matches).length / perQuestionBreakdown.length;

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
    perQuestionBreakdown,
  };
}

module.exports = qaMatchAssertion;
module.exports.computeRiskStatusMatch = computeRiskStatusMatch;
module.exports.buildQuestionGradingPrompt = buildQuestionGradingPrompt;
module.exports.parseGraderVerdict = parseGraderVerdict;
