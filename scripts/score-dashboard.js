'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');

function computeAccuracy(namedScores) {
  const scores = [
    namedScores.answerContentMatch,
    namedScores.report_quality,
    namedScores.fraudRiskScoreMatch,
    namedScores.entityFieldsMatch,
  ];
  const weight = 100 / scores.length;
  return Math.round(scores.reduce((sum, s) => sum + weight * s, 0));
}

function scoreDashboard(resultsFilePath) {
  const raw = fs.readFileSync(resultsFilePath, 'utf8');
  const parsed = JSON.parse(raw);
  const results = parsed.results.results;
  if (!results || results.length === 0) {
    throw new Error(`No results found in ${resultsFilePath}`);
  }

  return results.map((result) => {
    const bucketId = result.response?.output?.report?.bucketId;
    if (!result.response?.output || !result.gradingResult?.namedScores) {
      return { bucketId, error: result.error || 'missing response output or grading result' };
    }

    const output = result.response.output;
    const namedScores = result.gradingResult.namedScores;

    const ingestionTime = output.ingestion.timeMs / 1000;
    const processingTime = output.processing.timeMs / 1000;

    const accuracy = computeAccuracy(namedScores);
    if (Number.isNaN(accuracy)) {
      return { bucketId, error: 'Computed accuracy score is NaN — a named score is missing from the results file' };
    }

    return { bucketId, ingestionTime, processingTime, accuracy };
  });
}

function main() {
  const resultsFilePath = process.argv[2] || path.join(process.cwd(), 'results.json');
  const dashboard = scoreDashboard(resultsFilePath);
  console.log(JSON.stringify(dashboard, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { scoreDashboard, computeAccuracy };
