'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const promptfoo = require('promptfoo');
const qaMatchAssertion = require('./qa-match-assertion');
const { computeRiskStatusMatch, buildQuestionGradingPrompt, parseGraderVerdict } = require('./qa-match-assertion');

test('computeRiskStatusMatch returns the fraction of matching risk determinations', () => {
  const expectedQa = [
    { predefinedQuestionId: 1, expectedRiskStatus: 'RISK_DETECTED' },
    { predefinedQuestionId: 2, expectedRiskStatus: 'UNSURE' },
    { predefinedQuestionId: 3, expectedRiskStatus: 'RISK_DETECTED' },
  ];
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 1, riskStatus: 'RISK_DETECTED' },
        { predefinedQuestionId: 2, riskStatus: 'RISK_DETECTED' }, // mismatch vs UNSURE
        { predefinedQuestionId: 3, riskStatus: 'RISK_DETECTED' },
      ],
    },
  };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 2 / 3);
});

test('computeRiskStatusMatch returns 0 for a question missing from the real report entirely', () => {
  const expectedQa = [{ predefinedQuestionId: 1, expectedRiskStatus: 'RISK_DETECTED' }];
  const output = { report: { questions: [] } };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 0);
});

test('buildQuestionGradingPrompt embeds the question, expected answer, and actual answer', () => {
  const question = { predefinedQuestionId: 1, question: 'Is there fraud?', expectedAnswerSummary: 'Yes, per doc X.' };
  const prompt = buildQuestionGradingPrompt(question, 'Yes, doc X confirms it.');

  assert.match(prompt, /Is there fraud\?/);
  assert.match(prompt, /Yes, per doc X\./);
  assert.match(prompt, /Yes, doc X confirms it\./);
  assert.match(prompt, /"matches": boolean, "reason": string/);
});

test('parseGraderVerdict parses a clean JSON response', () => {
  const result = parseGraderVerdict('{"matches": true, "reason": "content matches"}');
  assert.deepEqual(result, { matches: true, reason: 'content matches' });
});

test('parseGraderVerdict extracts JSON even when wrapped in markdown code fences', () => {
  const response = '```json\n{"matches": false, "reason": "no match"}\n```';
  assert.deepEqual(parseGraderVerdict(response), { matches: false, reason: 'no match' });
});

test('parseGraderVerdict throws a clear error when no JSON object is present', () => {
  assert.throws(() => parseGraderVerdict('not json at all'), /Could not find a JSON object/);
});

test('parseGraderVerdict throws a clear error when matches or reason fields are missing or the wrong type', () => {
  assert.throws(() => parseGraderVerdict('{"matches": "yes", "reason": "ok"}'), /missing matches\/reason fields/);
  assert.throws(() => parseGraderVerdict('{"matches": true}'), /missing matches\/reason fields/);
});

function mockLoadApiProvider(t, callApiImpl) {
  const original = promptfoo.loadApiProvider;
  assert.equal(typeof original, 'function', 'mock target must already exist — loadApiProvider moved or was renamed');
  promptfoo.loadApiProvider = async () => ({ callApi: callApiImpl });
  t.after(() => {
    promptfoo.loadApiProvider = original;
  });
}

function fakeContext(overrides) {
  return {
    vars: {
      expected: {
        qa: [
          { predefinedQuestionId: 1, question: 'Q1?', expectedAnswerSummary: 'A1', expectedRiskStatus: 'RISK_DETECTED' },
          { predefinedQuestionId: 2, question: 'Q2?', expectedAnswerSummary: 'A2', expectedRiskStatus: 'UNSURE' },
          { predefinedQuestionId: 3, question: 'Q3?', expectedAnswerSummary: 'A3', expectedRiskStatus: 'RISK_DETECTED' },
        ],
      },
    },
    test: { assert: [{ metric: 'qa_match' }], options: { provider: 'anthropic:messages:claude-sonnet-4-5' } },
    ...overrides,
  };
}

function fakeOutput() {
  return {
    report: {
      questions: [
        { predefinedQuestionId: 1, riskStatus: 'RISK_DETECTED', answer: 'ans1' },
        { predefinedQuestionId: 2, riskStatus: 'RISK_DETECTED', answer: 'ans2' }, // mismatch vs UNSURE
        { predefinedQuestionId: 3, riskStatus: 'RISK_DETECTED', answer: 'ans3' },
      ],
    },
  };
}

test('qaMatchAssertion combines riskStatusMatch and answerContentMatch into namedScores and an averaged score, calling the grader once per question', async (t) => {
  let callCount = 0;
  mockLoadApiProvider(t, async () => {
    callCount += 1;
    const matches = callCount !== 3; // third question mismatches
    return { output: JSON.stringify({ matches, reason: `reason ${callCount}` }) };
  });

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(callCount, 3); // one call per question, not one batched call
  assert.equal(result.namedScores.riskStatusMatch, 2 / 3);
  assert.equal(result.namedScores.answerContentMatch, 2 / 3);
  assert.equal(result.score, (2 / 3 + 2 / 3) / 2);
  assert.equal(result.pass, true);
});

test('qaMatchAssertion returns one perQuestionBreakdown entry per question', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'looks right' }) }));

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(result.perQuestionBreakdown.length, 3);
  assert.deepEqual(result.perQuestionBreakdown[0], {
    predefinedQuestionId: 1,
    question: 'Q1?',
    actualAnswer: 'ans1',
    riskStatus: 'RISK_DETECTED',
    riskStatusMatches: true,
    matches: true,
    reason: 'looks right',
    actualCitedFileNames: [],
    expectedCitedFileNames: undefined,
    citationMatches: undefined,
  });
});

test('qaMatchAssertion sets riskStatusMatches false per-question when the actual riskStatus differs from expected', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'looks right' }) }));

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  // Question 2 expects UNSURE but fakeOutput reports RISK_DETECTED — a mismatch.
  assert.equal(result.perQuestionBreakdown[1].riskStatusMatches, false);
  assert.equal(result.perQuestionBreakdown[1].riskStatus, 'RISK_DETECTED');
  // Questions 1 and 3 both expect and get RISK_DETECTED — a match.
  assert.equal(result.perQuestionBreakdown[0].riskStatusMatches, true);
  assert.equal(result.perQuestionBreakdown[2].riskStatusMatches, true);
});

test('qaMatchAssertion grades a missing actual answer as NO ANSWER PROVIDED', async (t) => {
  let capturedPrompt;
  mockLoadApiProvider(t, async (prompt) => {
    capturedPrompt = prompt;
    return { output: JSON.stringify({ matches: false, reason: 'no answer' }) };
  });

  const output = { report: { questions: [] } }; // no actual answers exist at all
  await qaMatchAssertion(output, fakeContext());

  assert.match(capturedPrompt, /NO ANSWER PROVIDED/);
});

test('qaMatchAssertion fails when score is below an explicit threshold on the qa_match assert entry', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: false, reason: 'low' }) }));

  const context = fakeContext({ test: { assert: [{ metric: 'qa_match', threshold: 0.9 }], options: {} } });
  const result = await qaMatchAssertion(fakeOutput(), context);

  // riskStatusMatch = 2/3, answerContentMatch = 0, score = (2/3 + 0) / 2 = 1/3, below threshold 0.9
  assert.equal(result.pass, false);
});

test('qaMatchAssertion propagates an error thrown by the grader provider instead of swallowing it', async (t) => {
  mockLoadApiProvider(t, async () => {
    throw new Error('grader provider timed out');
  });

  await assert.rejects(() => qaMatchAssertion(fakeOutput(), fakeContext()), /grader provider timed out/);
});

test('qaMatchAssertion propagates a response.error from the grader provider', async (t) => {
  mockLoadApiProvider(t, async () => ({ error: 'rate limited' }));

  await assert.rejects(() => qaMatchAssertion(fakeOutput(), fakeContext()), /rate limited/);
});

test('qaMatchAssertion propagates a parse error when the grader response has no JSON object', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: 'not json at all' }));

  await assert.rejects(() => qaMatchAssertion(fakeOutput(), fakeContext()), /Could not find a JSON object/);
});

function fakeContextWithCitations() {
  return {
    vars: {
      expected: {
        qa: [
          { predefinedQuestionId: 1, question: 'Q1?', expectedAnswerSummary: 'A1', expectedRiskStatus: 'RISK_DETECTED', expectedCitedFileNames: ['a.pdf', 'b.pdf'] },
          { predefinedQuestionId: 2, question: 'Q2?', expectedAnswerSummary: 'A2', expectedRiskStatus: 'UNSURE', expectedCitedFileNames: ['c.pdf'] },
          { predefinedQuestionId: 3, question: 'Q3?', expectedAnswerSummary: 'A3', expectedRiskStatus: 'RISK_DETECTED' }, // no expectedCitedFileNames — not graded for citations
        ],
      },
    },
    test: { assert: [{ metric: 'qa_match' }], options: { provider: 'anthropic:messages:claude-sonnet-4-5' } },
  };
}

function fakeOutputWithCitations() {
  return {
    report: {
      questions: [
        { predefinedQuestionId: 1, riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="b.pdf"></InTextCitation>' }, // cites b.pdf — one of the two expected — matches
        { predefinedQuestionId: 2, riskStatus: 'UNSURE', answer: 'see <InTextCitation fileName="wrong.pdf"></InTextCitation>' }, // expected c.pdf, cited wrong.pdf — no match
        { predefinedQuestionId: 3, riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="anything.pdf"></InTextCitation>' }, // no expectedCitedFileNames — excluded
      ],
    },
  };
}

test('qaMatchAssertion computes citationMatch as the fraction of graded questions citing at least one expected fileName', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const result = await qaMatchAssertion(fakeOutputWithCitations(), fakeContextWithCitations());

  // question 1: matched; question 2: not matched; question 3: excluded (ungraded) -> 1/2 graded.
  assert.equal(result.namedScores.citationMatch, 0.5);
  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
  assert.equal(result.perQuestionBreakdown[1].citationMatches, false);
  assert.equal(result.perQuestionBreakdown[2].citationMatches, undefined);
  assert.deepEqual(result.perQuestionBreakdown[0].actualCitedFileNames, ['b.pdf']);
});

test('qaMatchAssertion treats citing any one of several expectedCitedFileNames as a match, not requiring all of them', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  // question 1's expectedCitedFileNames is ['a.pdf', 'b.pdf'] but the actual answer only cites
  // b.pdf — this must still count as a match ("at least one", not "all of them").
  const result = await qaMatchAssertion(fakeOutputWithCitations(), fakeContextWithCitations());

  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
});

test('qaMatchAssertion sets namedScores.citationMatch to undefined when no question has expectedCitedFileNames', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(result.namedScores.citationMatch, undefined);
  assert.equal('citationMatch' in result.namedScores, false);
  assert.ok(result.perQuestionBreakdown.every((v) => v.citationMatches === undefined));
  // falls back to the 2-signal average exactly as before this feature existed
  assert.equal(result.score, (result.namedScores.riskStatusMatch + result.namedScores.answerContentMatch) / 2);
});

test('qaMatchAssertion folds citationMatch into its own score as a 3-way average when at least one question is graded for it', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const result = await qaMatchAssertion(fakeOutputWithCitations(), fakeContextWithCitations());

  const { riskStatusMatch, answerContentMatch, citationMatch } = result.namedScores;
  assert.equal(result.score, (riskStatusMatch + answerContentMatch + citationMatch) / 3);
});

test('qaMatchAssertion treats a question with expectedCitedFileNames as an empty array as NOT graded for citations', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const context = fakeContext();
  context.vars.expected.qa[0].expectedCitedFileNames = [];

  const result = await qaMatchAssertion(fakeOutput(), context);

  assert.equal(result.perQuestionBreakdown[0].citationMatches, undefined);
  assert.equal('citationMatch' in result.namedScores, false);
});

test('qaMatchAssertion correctly reads expectedCitedFileNames when vars are built by the real generate-tests-vars.js pipeline, not hand-authored', async (t) => {
  const { buildTestsVars } = require('./generate-tests-vars');
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const rawClaim = {
    bucketId: 1,
    claimCategoryId: 1,
    expectedFraudRiskScore: 0.5,
    expectedClaimantName: 'X',
    expectedDefendant: 'Y',
    expectedInsuranceFirm: 'Z',
    summary: 'S',
    questions: [
      { id: 1, question: 'Q1?', expectedAnswer: 'A1', expectedRiskStatus: 'RISK_DETECTED', expectedCitedFileNames: ['a.pdf'] },
    ],
  };
  const [{ vars }] = buildTestsVars([rawClaim]);
  const context = { vars, test: { assert: [{ metric: 'qa_match' }], options: {} } };
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 1, riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="a.pdf"></InTextCitation>' },
      ],
    },
  };

  const result = await qaMatchAssertion(output, context);

  assert.equal(result.namedScores.citationMatch, 1);
  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
});
