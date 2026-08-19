'use strict';

const promptfoo = require('promptfoo');
const s3Client = require('../s3-client');
const { extractCitedCitationsFromText } = require('./extract-cited-file-names');

// predefinedQuestionId is minted fresh by the platform on every claim-processing run — it is
// NOT stable across runs of the same claim (analogous to documentId/chunkId). The question text
// itself is the only reliably stable identifier, so matching must key on that instead.
function findActualQuestion(actualQuestions, expectedQuestion) {
  return actualQuestions.find((r) => r.question === expectedQuestion.question);
}

function computeRiskStatusMatch(output, expectedQa) {
  const actualQuestions = output.report.questions;
  const matched = expectedQa.filter((q) => {
    const actual = findActualQuestion(actualQuestions, q);
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
    '(exact wording does not matter, meaning does)? Also rate how well the model answer captures',
    'the expected answer on a 0-100 scale (100 = perfect semantic match, 0 = completely wrong or',
    'missing). Respond with only a JSON object, no other text:',
    '{"matches": boolean, "score": number, "reason": string}.',
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
  if (parsed.score !== undefined && (typeof parsed.score !== 'number' || Number.isNaN(parsed.score) || parsed.score < 0 || parsed.score > 100)) {
    throw new Error(`Grader response score must be a number in [0,100] when present: ${text}`);
  }
  return { matches: parsed.matches, reason: parsed.reason, score: parsed.score };
}

const NO_CITATION_RESOLVED_REASON = 'No cited chunk resolved to compare against the expected passage.';

// Fires when at least one of this run's citations DID resolve, just not enough of them to cover
// every expected passage's position — distinct from NO_CITATION_RESOLVED_REASON, which fires when
// NONE of the answer's citations resolved at all.
function noChunkAtPositionReason(position) {
  return `No cited chunk at position ${position} in this run to compare against this expected passage.`;
}

// A single expectedChunkText entry reports its own reason verbatim (preserving the exact
// single-passage behavior this generalizes). With multiple entries, the unmatched ones are the
// actionable signal, so they're surfaced instead of the ones that already succeeded; only once
// every entry has matched do the (now all-success) reasons get joined.
function summarizeCitationReason(perExpectedResults) {
  if (perExpectedResults.length === 1) {
    return perExpectedResults[0].reason;
  }
  const unmatched = perExpectedResults.filter((r) => !r.matched);
  const relevant = unmatched.length > 0 ? unmatched : perExpectedResults;
  return relevant.map((r) => r.reason).join(' | ');
}

// Resolves every citation in this one question's actual answer against chunkGroundingData, then
// pairs expected passage i directly with this run's i-th resolved citation — ONE grader call per
// position, no searching across candidates. An expected passage beyond the number of resolved
// chunks this run's answer actually cited is an automatic non-match with no grader call spent on
// it, since there's nothing at that position to compare it to; any resolved chunk beyond the
// number of expected passages is simply unused. This is a deliberate simplification of the prior
// "does ANY resolved chunk support this passage" search — it trades order-independence for a much
// lower and more predictable call count, on the assumption that the two runs' citation order
// roughly corresponds. If that assumption doesn't hold up in practice, this is the first place to
// revisit. A citation that doesn't resolve at all (missing grounding data entirely, or that
// specific chunk absent from it) is skipped when building resolvedChunkTexts, not treated as a
// mismatch by itself. If NO citation resolves at all, this returns false with a fixed reason and
// makes no grader call.
async function computeChunkTextMatch(provider, expectedChunkTexts, actualAnswer, chunkGroundingData) {
  const citations = extractCitedCitationsFromText(actualAnswer);
  const resolvedChunkTexts = [];
  for (const { documentId, chunkId } of citations) {
    const chunkText = chunkGroundingData ? chunkGroundingData.get(s3Client.chunkKey(documentId, chunkId)) : undefined;
    if (chunkText) {
      resolvedChunkTexts.push(chunkText);
    }
  }
  if (resolvedChunkTexts.length === 0) {
    return { citationMatches: false, citationMatchReason: NO_CITATION_RESOLVED_REASON };
  }

  const perExpectedResults = [];
  for (let i = 0; i < expectedChunkTexts.length; i++) {
    const actualChunkText = resolvedChunkTexts[i];
    if (actualChunkText === undefined) {
      perExpectedResults.push({ matched: false, reason: noChunkAtPositionReason(i + 1) });
      continue;
    }
    const prompt = buildChunkTextMatchPrompt(expectedChunkTexts[i], actualChunkText);
    const response = await provider.callApi(prompt);
    if (response.error) {
      throw new Error(response.error);
    }
    const { matches, reason } = parseGraderVerdict(response.output);
    perExpectedResults.push({ matched: matches, reason });
  }

  return {
    citationMatches: perExpectedResults.every((r) => r.matched),
    citationMatchReason: summarizeCitationReason(perExpectedResults),
  };
}

async function qaMatchAssertion(output, context) {
  const expectedQa = context.vars.expected.qa;
  const actualQuestions = output.report.questions;

  const riskStatusMatch = computeRiskStatusMatch(output, expectedQa);

  const provider = await promptfoo.loadApiProvider(context.test.options.provider);
  const perQuestionBreakdown = [];
  for (const q of expectedQa) {
    const actual = findActualQuestion(actualQuestions, q);
    const actualAnswer = actual && actual.answer ? actual.answer : 'NO ANSWER PROVIDED';
    const prompt = buildQuestionGradingPrompt(q, actualAnswer);
    const response = await provider.callApi(prompt);
    if (response.error) {
      throw new Error(response.error);
    }
    const { matches, reason, score } = parseGraderVerdict(response.output);
    const riskStatus = actual && actual.riskStatus;
    const riskStatusMatches = riskStatus === q.expectedRiskStatus;

    const actualCitedFileNames = [...new Set(extractCitedCitationsFromText(actualAnswer).map((c) => c.fileName))];

    let citationMatches;
    let citationMatchReason;
    if (Array.isArray(q.expectedChunkText) && q.expectedChunkText.length > 0) {
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
      score,
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
module.exports.findActualQuestion = findActualQuestion;
module.exports.buildQuestionGradingPrompt = buildQuestionGradingPrompt;
module.exports.buildChunkTextMatchPrompt = buildChunkTextMatchPrompt;
module.exports.parseGraderVerdict = parseGraderVerdict;
