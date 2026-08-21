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

// Fires when this run resolved at least one citation, but every expected (baseline) passage was
// already claimed by a more-similar resolved chunk before this one's turn — distinct from
// NO_CITATION_RESOLVED_REASON, which fires when NONE of the answer's citations resolved at all.
const NO_MATCHING_CANDIDATE_REASON = 'No unclaimed expected passage available to pair with this cited chunk.';

// Lowercased alphanumeric word tokens — punctuation and casing don't carry meaning for a cheap
// overlap check, only the words themselves do.
function tokenize(text) {
  return new Set((text || '').toLowerCase().match(/[a-z0-9]+/g) || []);
}

// Jaccard similarity (intersection over union of word sets) between two chunk texts — a plain,
// deterministic, dependency-free proxy for "are these two passages about the same thing," used
// only to decide which actual chunk to pair with which expected passage before spending a real
// (LLM) grader call on the pair. Two empty texts are defined as 0 similarity, not 1, since two
// unrelated empty strings shouldn't count as a confident match.
function jaccardSimilarity(textA, textB) {
  const setA = tokenize(textA);
  const setB = tokenize(textB);
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

// Pairs each item in `primaryTexts` with at most one item in `candidateTexts` — a one-to-one
// assignment chosen by content similarity, not order, so a genuinely correct answer that cites
// the same material in a different order than the baseline run did isn't penalized for
// reordering. Greedy, not globally optimal: every possible (primary, candidate) pair is scored,
// then claimed highest-similarity-first, skipping any pair where either side is already claimed.
// Returns an array parallel to primaryTexts — matches[i] is the candidateTexts entry paired with
// primaryTexts[i], or undefined if no unclaimed candidate remained for it (more primary items
// than candidates, or a low-similarity leftover after better matches claimed everything usable).
// Which list is "primary" decides what an unmatched result means: computeChunkTextMatch passes
// this run's resolved citations as primary and the baseline's expected passages as candidates, so
// citationMatch asks "does every citation this run actually made hold up against the baseline
// material," not "did this run recreate every citation the baseline made."
function greedyPairBySimilarity(primaryTexts, candidateTexts) {
  const candidatePairs = [];
  for (let i = 0; i < primaryTexts.length; i++) {
    for (let j = 0; j < candidateTexts.length; j++) {
      candidatePairs.push({ i, j, score: jaccardSimilarity(primaryTexts[i], candidateTexts[j]) });
    }
  }
  // Highest similarity claimed first; Array.prototype.sort is stable, so tied scores (including
  // the common all-zero case when nothing shares any word) fall back to a deterministic order
  // rather than an arbitrary one.
  candidatePairs.sort((a, b) => b.score - a.score);

  const claimedPrimary = new Set();
  const claimedCandidate = new Set();
  const matches = new Array(primaryTexts.length).fill(undefined);
  for (const { i, j } of candidatePairs) {
    if (claimedPrimary.has(i) || claimedCandidate.has(j)) {
      continue;
    }
    matches[i] = candidateTexts[j];
    claimedPrimary.add(i);
    claimedCandidate.add(j);
  }
  return matches;
}

// A single pairing reports its own reason verbatim (preserving the exact single-passage behavior
// this generalizes). With multiple pairings, the unmatched ones are the actionable signal, so
// they're surfaced instead of the ones that already succeeded; only once every pairing has
// matched do the (now all-success) reasons get joined.
function summarizeCitationReason(perPairingResults) {
  if (perPairingResults.length === 1) {
    return perPairingResults[0].reason;
  }
  const unmatched = perPairingResults.filter((r) => !r.matched);
  const relevant = unmatched.length > 0 ? unmatched : perPairingResults;
  return relevant.map((r) => r.reason).join(' | ');
}

// Resolves every citation in this one question's actual answer against chunkGroundingData, then
// pairs each RESOLVED CHUNK (this run's own citations) with its most content-similar EXPECTED
// PASSAGE (the baseline's), via greedyPairBySimilarity — one grader call per pair, no searching
// every candidate per entry, and no dependence on citation order between the two runs. Passing
// this run's citations as the primary side (rather than the baseline's) means citationMatch asks
// "does every citation this run actually made hold up against the baseline material" — a resolved
// chunk left unpaired (this run cited more distinct chunks than the baseline did for this
// question, or every plausible candidate already claimed by a closer match) is an automatic
// non-match with no grader call spent on it, rather than penalizing this run for citing *fewer*
// things than the baseline. A citation that doesn't resolve at all (missing grounding data
// entirely, or that specific chunk absent from it) is skipped when building resolvedChunkTexts,
// not treated as a mismatch by itself. If NO citation resolves at all, this returns false with a
// fixed reason and makes no grader call.
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
    return { citationMatches: false, citationMatchReason: NO_CITATION_RESOLVED_REASON, citationMatchScore: 0 };
  }

  const matchedExpectedTexts = greedyPairBySimilarity(resolvedChunkTexts, expectedChunkTexts);

  const perPairingResults = [];
  for (let j = 0; j < resolvedChunkTexts.length; j++) {
    const expectedText = matchedExpectedTexts[j];
    if (expectedText === undefined) {
      perPairingResults.push({ matched: false, reason: NO_MATCHING_CANDIDATE_REASON });
      continue;
    }
    const prompt = buildChunkTextMatchPrompt(expectedText, resolvedChunkTexts[j]);
    const response = await provider.callApi(prompt);
    if (response.error) {
      throw new Error(response.error);
    }
    const { matches, reason } = parseGraderVerdict(response.output);
    perPairingResults.push({ matched: matches, reason });
  }

  const matchedCount = perPairingResults.filter((r) => r.matched).length;
  return {
    citationMatches: perPairingResults.every((r) => r.matched),
    citationMatchReason: summarizeCitationReason(perPairingResults),
    citationMatchScore: Math.round((matchedCount / perPairingResults.length) * 100),
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
    let citationMatchScore;
    if (Array.isArray(q.expectedChunkText) && q.expectedChunkText.length > 0) {
      const chunkResult = await computeChunkTextMatch(provider, q.expectedChunkText, actualAnswer, output.chunkGroundingData);
      citationMatches = chunkResult.citationMatches;
      citationMatchReason = chunkResult.citationMatchReason;
      citationMatchScore = chunkResult.citationMatchScore;
    }

    perQuestionBreakdown.push({
      predefinedQuestionId: q.predefinedQuestionId,
      question: q.question,
      actualAnswer,
      riskStatus,
      expectedRiskStatus: q.expectedRiskStatus,
      riskStatusMatches,
      matches,
      reason,
      score,
      actualCitedFileNames,
      citationMatches,
      citationMatchReason,
      citationMatchScore,
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
module.exports.jaccardSimilarity = jaccardSimilarity;
module.exports.greedyPairBySimilarity = greedyPairBySimilarity;
