'use strict';

const fs = require('node:fs');
const path = require('node:path');
const promptfoo = require('promptfoo');
const puppeteer = require('puppeteer');
const { entitiesMatch, fraudRiskScoreMatches } = require('../src/lib/metadata-match-assertion');
const { generateNarrativeAnalysis } = require('../src/lib/narrative-analysis');
const {
  renderReportHtml, computeRiskDistribution, computeSemanticByGoldCategory,
} = require('../src/lib/html-report-template');
const { computeAccuracy, scoreDashboard, dashboardHasErrors } = require('./score-dashboard');

function formatTimestampForFilename(isoTimestamp) {
  return isoTimestamp.replace(/:/g, '-').replace(/\.\d+Z$/, '');
}

// Formats a Date in IST (Asia/Kolkata) — see prior design note in the
// pre-rewrite version of this file for why this must not depend on the
// host machine's own timezone.
function formatLocalTimestamp(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => {
    const value = parts.find((p) => p.type === type).value;
    return type === 'hour' && value === '24' ? '00' : value;
  };
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

const RISK_STATUS_ORDER = ['RISK_DETECTED', 'UNSURE', 'RISK_NOT_DETECTED'];
function riskStatusSortKey(riskStatus) {
  const index = RISK_STATUS_ORDER.indexOf(riskStatus);
  return index === -1 ? RISK_STATUS_ORDER.length : index;
}
function sortByRiskStatus(perQuestionBreakdown) {
  return [...perQuestionBreakdown].sort((a, b) => riskStatusSortKey(a.riskStatus) - riskStatusSortKey(b.riskStatus));
}

function uniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath);
  const base = filePath.slice(0, filePath.length - ext.length);
  let n = 2;
  let candidate = `${base}-${n}${ext}`;
  while (fs.existsSync(candidate)) {
    n += 1;
    candidate = `${base}-${n}${ext}`;
  }
  return candidate;
}

function findComponent(gradingResult, metric) {
  return (gradingResult.componentResults || []).find((c) => c.assertion && c.assertion.metric === metric);
}

const REQUIRED_NAMED_SCORES = ['riskStatusMatch', 'answerContentMatch', 'report_quality', 'fraudRiskScoreMatch', 'entityFieldsMatch'];
function hasRequiredNamedScores(namedScores) {
  return REQUIRED_NAMED_SCORES.every((key) => typeof namedScores?.[key] === 'number' && !Number.isNaN(namedScores[key]));
}

function isClaimRenderable(result) {
  const output = result.response?.output;
  return Boolean(
    output && output.ingestion &&
    typeof output.ingestion.docsSubmitted === 'number' &&
    typeof output.ingestion.docsComplete === 'number' &&
    output.processing && result.vars?.expected &&
    hasRequiredNamedScores(result.gradingResult?.namedScores)
  );
}

const FALLBACK_NARRATIVE = {
  summaryPanel: ['Narrative analysis unavailable for this run.'],
  questionsPanel: ['Narrative analysis unavailable for this run.'],
  citationsPanel: ['Narrative analysis unavailable for this run.'],
  overallPanel: ['Narrative analysis unavailable for this run.'],
  finalVerdict: {
    netRead: ['Narrative analysis unavailable for this run.'],
    whatWentRight: ['Narrative analysis unavailable for this run.'],
    whatWentWrong: ['Narrative analysis unavailable for this run.'],
    reasoning: 'Narrative analysis unavailable for this run.',
  },
  perQuestionVerdicts: {},
};

function buildClaimData(result, generatedAt) {
  const output = result.response.output;
  const report = output.report;
  const expected = result.vars.expected;
  const namedScores = result.gradingResult.namedScores;
  const qaMatchComponent = findComponent(result.gradingResult, 'qa_match');
  const perQuestionBreakdown = sortByRiskStatus((qaMatchComponent && qaMatchComponent.perQuestionBreakdown) || []);
  const failedDocuments = output.failedDocuments || [];

  const fraudScoreMatches = fraudRiskScoreMatches(report.fraudRiskScore, expected.fraudRiskScore);
  const metadataMatch = [
    {
      field: 'Risk Score (±10% tol.)',
      expected: `${expected.fraudRiskScore.toFixed(4)} · ${(expected.fraudRiskScore * 100).toFixed(2)}%`,
      actual: `${report.fraudRiskScore.toFixed(4)} · ${(report.fraudRiskScore * 100).toFixed(2)}%`,
      matches: fraudScoreMatches,
    },
    { field: 'Claimant Name', expected: expected.claimantName, actual: report.claimantName, matches: entitiesMatch(report.claimantName, expected.claimantName) },
    { field: 'Defendant', expected: expected.defendant, actual: report.defendant, matches: entitiesMatch(report.defendant, expected.defendant) },
    { field: 'Insurance Firm', expected: expected.insuranceFirm, actual: report.insuranceFirm, matches: entitiesMatch(report.insuranceFirm, expected.insuranceFirm) },
  ];

  return {
    bucketId: report.bucketId,
    claimantName: report.claimantName,
    generatedAt,
    docsSubmitted: output.ingestion.docsSubmitted,
    docsComplete: output.ingestion.docsComplete,
    docsFailed: failedDocuments.length,
    failedDocuments,
    ingestionTimeMs: output.ingestion.timeMs,
    processingTimeMs: output.processing.timeMs,
    namedScores,
    accuracy: computeAccuracy(namedScores),
    fraudRiskScoreExpected: expected.fraudRiskScore,
    fraudRiskScoreActual: report.fraudRiskScore,
    fraudRiskScoreMatches: fraudScoreMatches,
    metadataMatch,
    perQuestionBreakdown,
  };
}

function buildNarrativeClaimSummary(claimData) {
  return {
    namedScores: claimData.namedScores,
    riskDistribution: computeRiskDistribution(claimData.perQuestionBreakdown),
    semanticByGoldCategory: computeSemanticByGoldCategory(claimData.perQuestionBreakdown),
    metadataMatch: claimData.metadataMatch,
    questions: claimData.perQuestionBreakdown.map((q) => ({
      id: q.predefinedQuestionId,
      question: q.question,
      expectedRiskStatus: q.expectedRiskStatus,
      riskStatus: q.riskStatus,
      riskStatusMatches: q.riskStatusMatches,
      score: q.score,
      citationMatchScore: q.citationMatchScore,
      reason: q.reason,
      actualAnswerExcerpt: (q.actualAnswer || '').slice(0, 600),
    })),
  };
}

async function generatePdfReports(resultsFilePath, reportsDir, now = () => new Date(), providedProvider) {
  const raw = fs.readFileSync(resultsFilePath, 'utf8');
  const parsed = JSON.parse(raw);
  const results = parsed.results.results;
  const generatedAt = formatLocalTimestamp(now());

  const provider = providedProvider || await promptfoo.loadApiProvider(process.env.GRADER_PROVIDER);
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  const written = [];
  try {
    for (const result of results) {
      const bucketId = result.response?.output?.report?.bucketId;
      if (bucketId === undefined) {
        console.error('Skipping claim unknown: no report was ever produced.');
        continue;
      }
      if (!isClaimRenderable(result)) {
        console.error(`Skipping claim ${bucketId}: missing required data for PDF generation.`);
        continue;
      }

      const claimData = buildClaimData(result, generatedAt);
      try {
        claimData.narrative = await generateNarrativeAnalysis(provider, buildNarrativeClaimSummary(claimData));
      } catch (err) {
        console.error(`Narrative analysis failed for claim ${bucketId}, using fallback: ${err.message}`);
        claimData.narrative = FALLBACK_NARRATIVE;
      }

      const html = renderReportHtml(claimData);
      const page = await browser.newPage();
      let pdfBuffer;
      try {
        await page.setContent(html);
        pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
      } finally {
        await page.close();
      }

      const fileName = `report-${formatTimestampForFilename(generatedAt)}.pdf`;
      const filePath = uniqueFilePath(path.join(reportsDir, String(bucketId), fileName));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, pdfBuffer);
      written.push(filePath);
    }
  } finally {
    await browser.close();
  }
  return written;
}

function main() {
  const resultsFilePath = process.argv[2] || path.join(process.cwd(), 'results.json');
  const reportsDir = process.argv[3] || path.join(process.cwd(), 'reports');
  generatePdfReports(resultsFilePath, reportsDir)
    .then((written) => {
      for (const filePath of written) {
        console.log(`Wrote ${filePath}`);
      }
      console.log(`Wrote ${written.length} report(s).`);
      if (dashboardHasErrors(scoreDashboard(resultsFilePath))) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

if (require.main === module) {
  main();
}

module.exports = {
  generatePdfReports,
  formatTimestampForFilename,
  formatLocalTimestamp,
  sortByRiskStatus,
  uniqueFilePath,
};
