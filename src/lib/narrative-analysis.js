'use strict';

function buildNarrativePrompt(claimSummary) {
  return [
    'You are analyzing the results of an automated fraud-risk claim evaluation.',
    'Below are the already-computed scores and per-question breakdown for one claim.',
    'Do NOT invent or recompute any number — only interpret the numbers given.',
    '',
    `Named scores: ${JSON.stringify(claimSummary.namedScores)}`,
    `Risk distribution (model output vs gold expected): ${JSON.stringify(claimSummary.riskDistribution)}`,
    `Semantic match by gold category: ${JSON.stringify(claimSummary.semanticByGoldCategory)}`,
    `Claim metadata match: ${JSON.stringify(claimSummary.metadataMatch)}`,
    '',
    'Per-question breakdown:',
    JSON.stringify(claimSummary.questions, null, 2),
    '',
    'Respond with only a JSON object, no other text, in exactly this shape:',
    JSON.stringify({
      summaryPanel: ['3-5 short bullet strings covering key facts, hallucinations, gaps'],
      questionsPanel: ['3-5 short bullet strings covering risk-direction and semantic match'],
      citationsPanel: ['3-5 short bullet strings covering citation accuracy'],
      overallPanel: ['3-5 short bullet strings covering the overall takeaway'],
      finalVerdict: {
        netRead: ['3-6 short bullet strings summarizing the net read'],
        whatWentRight: ['2-5 short bullet strings'],
        whatWentWrong: ['2-5 short bullet strings'],
        reasoning: 'one paragraph explaining the error pattern, if any',
      },
      perQuestionVerdicts: { '<questionId>': 'one short sentence per question, keyed by its id, for every question id given above' },
    }, null, 2),
  ].join('\n');
}

const REQUIRED_PANELS = ['summaryPanel', 'questionsPanel', 'citationsPanel', 'overallPanel'];
const REQUIRED_FINAL_VERDICT_FIELDS = ['netRead', 'whatWentRight', 'whatWentWrong', 'reasoning'];

function parseNarrativeResponse(responseOutput, claimSummary) {
  const text = typeof responseOutput === 'string' ? responseOutput : JSON.stringify(responseOutput);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Could not find a JSON object in narrative response: ${text}`);
  }
  const parsed = JSON.parse(match[0]);

  for (const panel of REQUIRED_PANELS) {
    if (!Array.isArray(parsed[panel])) {
      throw new Error(`Narrative response missing required panel array "${panel}": ${text}`);
    }
  }
  if (typeof parsed.finalVerdict !== 'object' || parsed.finalVerdict === null) {
    throw new Error(`Narrative response missing "finalVerdict" object: ${text}`);
  }
  for (const field of REQUIRED_FINAL_VERDICT_FIELDS) {
    const value = parsed.finalVerdict[field];
    const isValid = field === 'reasoning' ? typeof value === 'string' : Array.isArray(value);
    if (!isValid) {
      throw new Error(`Narrative response's finalVerdict missing required field "${field}": ${text}`);
    }
  }
  if (typeof parsed.perQuestionVerdicts !== 'object' || parsed.perQuestionVerdicts === null) {
    throw new Error(`Narrative response missing "perQuestionVerdicts" object: ${text}`);
  }
  const missingIds = (claimSummary.questions || [])
    .map((q) => q.id)
    .filter((id) => typeof parsed.perQuestionVerdicts[id] !== 'string');
  if (missingIds.length > 0) {
    throw new Error(`Narrative response's perQuestionVerdicts is missing entries for question id(s): ${missingIds.join(', ')}`);
  }

  return {
    summaryPanel: parsed.summaryPanel,
    questionsPanel: parsed.questionsPanel,
    citationsPanel: parsed.citationsPanel,
    overallPanel: parsed.overallPanel,
    finalVerdict: parsed.finalVerdict,
    perQuestionVerdicts: parsed.perQuestionVerdicts,
  };
}

module.exports = { buildNarrativePrompt, parseNarrativeResponse };
