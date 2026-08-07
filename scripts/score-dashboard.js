'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');

const INGEST_BUDGET_MS = Number(process.env.INGEST_BUDGET_MS || 120000);
const CLAIM_BUDGET_MS = Number(process.env.CLAIM_BUDGET_MS || 600000);
const RUBRIC_WEIGHT = 0.6;
const CITATION_WEIGHT = 0.4;

function budgetScore(budgetMs, measuredMs) {
  return Math.round(100 * Math.min(1, budgetMs / measuredMs));
}

function scoreDashboard(resultsFilePath) {
  const raw = fs.readFileSync(resultsFilePath, 'utf8');
  const parsed = JSON.parse(raw);
  const result = parsed.results.results[0];
  if (!result) {
    throw new Error(`No results found in ${resultsFilePath}`);
  }
  if (result.error || !result.response?.output || !result.gradingResult?.namedScores) {
    throw new Error(`Eval result is not scorable: ${result.error || 'missing response output or grading result'}`);
  }

  const output = result.response.output;
  const namedScores = result.gradingResult.namedScores;

  const ingestTime = budgetScore(INGEST_BUDGET_MS, output.ingestion.timeMs);
  const claimProcTime = budgetScore(CLAIM_BUDGET_MS, output.processing.timeMs);

  const rubricScore = namedScores.qa_summary_accuracy;
  const citationScore = namedScores.citation_accuracy;
  const acc = Math.round(100 * (RUBRIC_WEIGHT * rubricScore + CITATION_WEIGHT * citationScore));
  if (Number.isNaN(acc)) {
    throw new Error('Computed accuracy score is NaN — a named score is missing from the results file');
  }

  return { ingestTime, claimProcTime, acc, entAcc: null };
}

function main() {
  const resultsFilePath = process.argv[2] || path.join(process.cwd(), 'results.json');
  const dashboard = scoreDashboard(resultsFilePath);
  console.log(JSON.stringify(dashboard, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { scoreDashboard, budgetScore };
