'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNarrativePrompt, parseNarrativeResponse } = require('./narrative-analysis');

function sampleClaimSummary() {
  return {
    namedScores: { riskStatusMatch: 0.66, answerContentMatch: 0.57, citationMatch: 0.09, fraudRiskScoreMatch: 0, entityFieldsMatch: 0.67 },
    riskDistribution: { model: { det: 11, nd: 1, ns: 23 }, gold: { det: 17, nd: 0, ns: 18 } },
    semanticByGoldCategory: [
      { label: 'Gold: Risk Detected', count: 17, avgScore: 38 },
      { label: 'Gold: Not Sure', count: 18, avgScore: 82 },
      { label: 'Gold: Not Detected', count: 0, avgScore: 0 },
    ],
    metadataMatch: [
      { field: 'Risk Score (±10% tol.)', expected: '0.7524 · 75.24%', actual: '0.7071 · 70.71%', matches: false },
    ],
    questions: [
      {
        id: 1, question: 'Are any of the medical providers bad actors?', expectedRiskStatus: 'RISK_DETECTED',
        riskStatus: 'RISK_DETECTED', riskStatusMatches: true, score: 30, citationMatchScore: 50,
        reason: 'Names only one overlapping bad actor.', actualAnswerExcerpt: 'RISK DETECTED: ...',
      },
      {
        id: 2, question: 'Are any attorneys bad actors?', expectedRiskStatus: 'UNSURE',
        riskStatus: 'RISK_DETECTED', riskStatusMatches: false, score: 0, citationMatchScore: 0,
        reason: 'Opposite conclusion.', actualAnswerExcerpt: 'RISK DETECTED: ...',
      },
    ],
  };
}

test('buildNarrativePrompt embeds every computed figure and every question id', () => {
  const prompt = buildNarrativePrompt(sampleClaimSummary());

  assert.match(prompt, /riskStatusMatch.*0\.66/s);
  assert.match(prompt, /answerContentMatch.*0\.57/s);
  assert.match(prompt, /citationMatch.*0\.09/s);
  assert.match(prompt, /Gold: Risk Detected.*38/s);
  assert.match(prompt, /Gold: Not Sure.*82/s);
  assert.match(prompt, /"id": 1/);
  assert.match(prompt, /"id": 2/);
  assert.match(prompt, /Are any of the medical providers bad actors\?/);
  assert.match(prompt, /summaryPanel/);
  assert.match(prompt, /finalVerdict/);
  assert.match(prompt, /perQuestionVerdicts/);
});

test('parseNarrativeResponse parses a well-formed response', () => {
  const claimSummary = sampleClaimSummary();
  const response = JSON.stringify({
    summaryPanel: ['a'], questionsPanel: ['b'], citationsPanel: ['c'], overallPanel: ['d'],
    finalVerdict: { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'], reasoning: 'h' },
    perQuestionVerdicts: { 1: 'Right call', 2: 'Wrong call' },
  });

  const result = parseNarrativeResponse(response, claimSummary);
  assert.deepEqual(result.summaryPanel, ['a']);
  assert.deepEqual(result.finalVerdict, { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'], reasoning: 'h' });
  assert.deepEqual(result.perQuestionVerdicts, { 1: 'Right call', 2: 'Wrong call' });
});

test('parseNarrativeResponse extracts JSON even when wrapped in markdown code fences', () => {
  const claimSummary = { ...sampleClaimSummary(), questions: [] };
  const response = '```json\n' + JSON.stringify({
    summaryPanel: ['a'], questionsPanel: ['b'], citationsPanel: ['c'], overallPanel: ['d'],
    finalVerdict: { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'], reasoning: 'h' },
    perQuestionVerdicts: {},
  }) + '\n```';
  const result = parseNarrativeResponse(response, claimSummary);
  assert.deepEqual(result.summaryPanel, ['a']);
});

test('parseNarrativeResponse throws when a required panel array is missing', () => {
  const claimSummary = { ...sampleClaimSummary(), questions: [] };
  const response = JSON.stringify({
    questionsPanel: ['b'], citationsPanel: ['c'], overallPanel: ['d'],
    finalVerdict: { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'], reasoning: 'h' },
    perQuestionVerdicts: {},
  });
  assert.throws(() => parseNarrativeResponse(response, claimSummary), /summaryPanel/);
});

test('parseNarrativeResponse throws when finalVerdict is missing a required sub-field', () => {
  const claimSummary = { ...sampleClaimSummary(), questions: [] };
  const response = JSON.stringify({
    summaryPanel: ['a'], questionsPanel: ['b'], citationsPanel: ['c'], overallPanel: ['d'],
    finalVerdict: { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'] },
    perQuestionVerdicts: {},
  });
  assert.throws(() => parseNarrativeResponse(response, claimSummary), /reasoning/);
});

test('parseNarrativeResponse throws when perQuestionVerdicts is missing an entry for a question id that was in the input', () => {
  const claimSummary = sampleClaimSummary(); // has question ids 1 and 2
  const response = JSON.stringify({
    summaryPanel: ['a'], questionsPanel: ['b'], citationsPanel: ['c'], overallPanel: ['d'],
    finalVerdict: { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'], reasoning: 'h' },
    perQuestionVerdicts: { 1: 'Right call' }, // missing id 2
  });
  assert.throws(() => parseNarrativeResponse(response, claimSummary), /perQuestionVerdicts.*2/s);
});

test('parseNarrativeResponse throws a clear error when no JSON object is present', () => {
  assert.throws(() => parseNarrativeResponse('not json at all', { questions: [] }), /Could not find a JSON object/);
});

const { generateNarrativeAnalysis } = require('./narrative-analysis');

test('generateNarrativeAnalysis calls provider.callApi exactly once with the built prompt and returns the parsed result', async () => {
  const claimSummary = sampleClaimSummary();
  const calls = [];
  const provider = {
    callApi: async (prompt) => {
      calls.push(prompt);
      return {
        output: JSON.stringify({
          summaryPanel: ['a'], questionsPanel: ['b'], citationsPanel: ['c'], overallPanel: ['d'],
          finalVerdict: { netRead: ['e'], whatWentRight: ['f'], whatWentWrong: ['g'], reasoning: 'h' },
          perQuestionVerdicts: { 1: 'Right call', 2: 'Wrong call' },
        }),
      };
    },
  };

  const result = await generateNarrativeAnalysis(provider, claimSummary);

  assert.equal(calls.length, 1);
  assert.equal(calls[0], buildNarrativePrompt(claimSummary));
  assert.deepEqual(result.summaryPanel, ['a']);
});

test('generateNarrativeAnalysis throws when provider.callApi returns an error', async () => {
  const claimSummary = sampleClaimSummary();
  const provider = { callApi: async () => ({ error: 'rate limited' }) };
  await assert.rejects(() => generateNarrativeAnalysis(provider, claimSummary), /rate limited/);
});
