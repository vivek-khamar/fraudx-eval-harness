'use strict';

const promptfoo = require('promptfoo');
const { extractCitedCitationsFromText } = require('./extract-cited-file-names');

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

function buildChunkTextMatchPrompt(expectedChunkText, actualChunkText) {
  return [
    `Expected source passage: ${expectedChunkText}`,
    `Actual cited passage: ${actualChunkText}`,
    '',
    'Does the actual cited passage semantically support/match the expected source passage above',
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

const NO_CITATION_RESOLVED_REASON = 'No cited chunk resolved to compare against the expected passage.';

// Resolves every citation in this one question's actual answer against
// chunkGroundingData, and asks the grader whether ANY resolved chunk's text
// semantically supports expectedChunkText — "at least one" semantics, same
// as the fileName-based check this replaces. A citation that doesn't resolve
// (missing grounding data entirely, or that specific chunk absent from it)
// is skipped, not treated as a mismatch by itself. If NO citation resolves
// at all, this returns false with a fixed reason and makes no grader call.
async function computeChunkTextMatch(provider, expectedChunkText, actualAnswer, chunkGroundingData) {
  const citations = extractCitedCitationsFromText(actualAnswer);
  let sawAnyResolved = false;
  let lastFalseReason = NO_CITATION_RESOLVED_REASON;
  for (const { documentId, chunkId } of citations) {
    const chunkText = chunkGroundingData ? chunkGroundingData.get(`${documentId}:${chunkId}`) : undefined;
    if (!chunkText) {
      continue;
    }
    sawAnyResolved = true;
    const prompt = buildChunkTextMatchPrompt(expectedChunkText, chunkText);
    const response = await provider.callApi(prompt);
    if (response.error) {
      throw new Error(response.error);
    }
    const { matches, reason } = parseGraderVerdict(response.output);
    if (matches) {
      return { citationMatches: true, citationMatchReason: reason };
    }
    lastFalseReason = reason;
  }
  return {
    citationMatches: false,
    citationMatchReason: sawAnyResolved ? lastFalseReason : NO_CITATION_RESOLVED_REASON,
  };
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
    const riskStatusMatches = riskStatus === q.expectedRiskStatus;

    const actualCitedFileNames = [...new Set(extractCitedCitationsFromText(actualAnswer).map((c) => c.fileName))];

    let citationMatches;
    let citationMatchReason;
    if (typeof q.expectedChunkText === 'string' && q.expectedChunkText.length > 0) {
      const chunkResult = await computeChunkTextMatch(provider, q.expectedChunkText, actualAnswer, output.chunkGroundingData);
      citationMatches = chunkResult.citationMatches;
      citationMatchReason = chunkResult.citationMatchReason;
    }

    perQuestionBreakdown.push({
      predefinedQuestionId: q.predefinedQuestionId,
      question: q.question,
      actualAnswer,
      riskStatus,
      riskStatusMatches,
      matches,
      reason,
      actualCitedFileNames,
      citationMatches,
      citationMatchReason,
    });
  }
  const answerContentMatch = perQuestionBreakdown.filter((v) => v.matches).length / perQuestionBreakdown.length;

  const gradedForCitation = perQuestionBreakdown.filter((v) => v.citationMatches !== undefined);
  const citationMatch = gradedForCitation.length > 0
    ? gradedForCitation.filter((v) => v.citationMatches).length / gradedForCitation.length
    : undefined;

  const score = citationMatch === undefined
    ? (riskStatusMatch + answerContentMatch) / 2
    : (riskStatusMatch + answerContentMatch + citationMatch) / 3;

  const qaMatchAssert = context.test && Array.isArray(context.test.assert)
    ? context.test.assert.find((a) => a.metric === 'qa_match')
    : undefined;
  const threshold = qaMatchAssert && qaMatchAssert.threshold;
  const pass = threshold === undefined ? score > 0 : score >= threshold;

  return {
    pass,
    score,
    reason: `riskStatusMatch=${riskStatusMatch}, answerContentMatch=${answerContentMatch}, citationMatch=${citationMatch === undefined ? 'n/a' : citationMatch}`,
    namedScores: citationMatch === undefined
      ? { riskStatusMatch, answerContentMatch }
      : { riskStatusMatch, answerContentMatch, citationMatch },
    perQuestionBreakdown,
  };
}

module.exports = qaMatchAssertion;
module.exports.computeRiskStatusMatch = computeRiskStatusMatch;
module.exports.buildQuestionGradingPrompt = buildQuestionGradingPrompt;
module.exports.buildChunkTextMatchPrompt = buildChunkTextMatchPrompt;
module.exports.parseGraderVerdict = parseGraderVerdict;
