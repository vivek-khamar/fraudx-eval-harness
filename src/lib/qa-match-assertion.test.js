'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const promptfoo = require('promptfoo');
const qaMatchAssertion = require('./qa-match-assertion');
const {
  computeRiskStatusMatch, buildQuestionGradingPrompt, parseGraderVerdict,
  jaccardSimilarity, greedyPairBySimilarity,
} = require('./qa-match-assertion');

test('computeRiskStatusMatch returns the fraction of matching risk determinations', () => {
  const expectedQa = [
    { predefinedQuestionId: 1, question: 'Q1?', expectedRiskStatus: 'RISK_DETECTED' },
    { predefinedQuestionId: 2, question: 'Q2?', expectedRiskStatus: 'UNSURE' },
    { predefinedQuestionId: 3, question: 'Q3?', expectedRiskStatus: 'RISK_DETECTED' },
  ];
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 1, question: 'Q1?', riskStatus: 'RISK_DETECTED' },
        { predefinedQuestionId: 2, question: 'Q2?', riskStatus: 'RISK_DETECTED' }, // mismatch vs UNSURE
        { predefinedQuestionId: 3, question: 'Q3?', riskStatus: 'RISK_DETECTED' },
      ],
    },
  };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 2 / 3);
});

test('computeRiskStatusMatch returns 0 for a question missing from the real report entirely', () => {
  const expectedQa = [{ predefinedQuestionId: 1, question: 'Q1?', expectedRiskStatus: 'RISK_DETECTED' }];
  const output = { report: { questions: [] } };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 0);
});

test('computeRiskStatusMatch matches by question text even when predefinedQuestionId differs between the actual report and golden data (ids are re-minted per claim-processing run, not stable)', () => {
  const expectedQa = [
    { predefinedQuestionId: 113, question: 'Is there evidence of fraud?', expectedRiskStatus: 'RISK_DETECTED' },
  ];
  const output = {
    report: {
      // Same question text, but a completely different predefinedQuestionId — as happens
      // when the same claim is re-ingested/re-processed and the platform mints fresh ids.
      questions: [{ predefinedQuestionId: 1625, question: 'Is there evidence of fraud?', riskStatus: 'RISK_DETECTED' }],
    },
  };
  assert.equal(computeRiskStatusMatch(output, expectedQa), 1);
});

test('buildQuestionGradingPrompt embeds the question, expected answer, actual answer, and asks for a 0-100 score', () => {
  const question = { predefinedQuestionId: 1, question: 'Is there fraud?', expectedAnswerSummary: 'Yes, per doc X.' };
  const prompt = buildQuestionGradingPrompt(question, 'Yes, doc X confirms it.');

  assert.match(prompt, /Is there fraud\?/);
  assert.match(prompt, /Yes, per doc X\./);
  assert.match(prompt, /Yes, doc X confirms it\./);
  assert.match(prompt, /0-100 scale/);
  assert.match(prompt, /"matches": boolean, "score": number, "reason": string/);
});

test('parseGraderVerdict parses a clean JSON response with a score', () => {
  const result = parseGraderVerdict('{"matches": true, "score": 87, "reason": "content matches"}');
  assert.deepEqual(result, { matches: true, reason: 'content matches', score: 87 });
});

test('parseGraderVerdict parses a response with no score field (the citation-grading shape) and returns score: undefined', () => {
  const result = parseGraderVerdict('{"matches": true, "reason": "content matches"}');
  assert.deepEqual(result, { matches: true, reason: 'content matches', score: undefined });
});

test('parseGraderVerdict extracts JSON even when wrapped in markdown code fences', () => {
  const response = '```json\n{"matches": false, "score": 12, "reason": "no match"}\n```';
  assert.deepEqual(parseGraderVerdict(response), { matches: false, reason: 'no match', score: 12 });
});

test('parseGraderVerdict throws a clear error when no JSON object is present', () => {
  assert.throws(() => parseGraderVerdict('not json at all'), /Could not find a JSON object/);
});

test('parseGraderVerdict throws a clear error when matches or reason fields are missing or the wrong type', () => {
  assert.throws(() => parseGraderVerdict('{"matches": "yes", "reason": "ok"}'), /missing matches\/reason fields/);
  assert.throws(() => parseGraderVerdict('{"matches": true}'), /missing matches\/reason fields/);
});

test('parseGraderVerdict throws when score is present but out of range or the wrong type', () => {
  assert.throws(
    () => parseGraderVerdict('{"matches": true, "score": 150, "reason": "ok"}'),
    /score must be a number in \[0,100\]/
  );
  assert.throws(
    () => parseGraderVerdict('{"matches": true, "score": -1, "reason": "ok"}'),
    /score must be a number in \[0,100\]/
  );
  assert.throws(
    () => parseGraderVerdict('{"matches": true, "score": "87", "reason": "ok"}'),
    /score must be a number in \[0,100\]/
  );
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
        { predefinedQuestionId: 1, question: 'Q1?', riskStatus: 'RISK_DETECTED', answer: 'ans1' },
        { predefinedQuestionId: 2, question: 'Q2?', riskStatus: 'RISK_DETECTED', answer: 'ans2' }, // mismatch vs UNSURE
        { predefinedQuestionId: 3, question: 'Q3?', riskStatus: 'RISK_DETECTED', answer: 'ans3' },
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
    expectedRiskStatus: 'RISK_DETECTED',
    riskStatusMatches: true,
    matches: true,
    reason: 'looks right',
    score: undefined,
    actualCitedFileNames: [],
    citationMatches: undefined,
    citationMatchReason: undefined,
    citationMatchScore: undefined,
  });
});

test('qaMatchAssertion carries the grader\'s score through to perQuestionBreakdown, without affecting answerContentMatch', async (t) => {
  let callCount = 0;
  mockLoadApiProvider(t, async () => {
    callCount += 1;
    const scores = [90, 40, 70];
    return { output: JSON.stringify({ matches: true, score: scores[callCount - 1], reason: `reason ${callCount}` }) };
  });

  const result = await qaMatchAssertion(fakeOutput(), fakeContext());

  assert.equal(result.perQuestionBreakdown[0].score, 90);
  assert.equal(result.perQuestionBreakdown[1].score, 40);
  assert.equal(result.perQuestionBreakdown[2].score, 70);
  // all three mocked "matches: true" -> answerContentMatch is unaffected by the score values above
  assert.equal(result.namedScores.answerContentMatch, 1);
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

test('qaMatchAssertion matches the actual question by question text, not predefinedQuestionId, since ids are re-minted every claim-processing run', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'looks right' }) }));

  const context = fakeContext();
  // Golden data was captured from one run; predefinedQuestionId 1 there may not exist at all
  // in a fresh run's report — only the question text is guaranteed to still line up.
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 9001, question: 'Q1?', riskStatus: 'RISK_DETECTED', answer: 'ans1' },
        { predefinedQuestionId: 9002, question: 'Q2?', riskStatus: 'RISK_DETECTED', answer: 'ans2' },
        { predefinedQuestionId: 9003, question: 'Q3?', riskStatus: 'RISK_DETECTED', answer: 'ans3' },
      ],
    },
  };

  const result = await qaMatchAssertion(output, context);

  assert.equal(result.perQuestionBreakdown[0].actualAnswer, 'ans1');
  assert.notEqual(result.perQuestionBreakdown[0].actualAnswer, 'NO ANSWER PROVIDED');
  assert.equal(result.namedScores.riskStatusMatch, 2 / 3);
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

function fakeContextWithExpectedChunkText() {
  return {
    vars: {
      expected: {
        qa: [
          { predefinedQuestionId: 1, question: 'Q1?', expectedAnswerSummary: 'A1', expectedRiskStatus: 'RISK_DETECTED', expectedChunkText: ['The gold passage about attorney X.'] },
          { predefinedQuestionId: 2, question: 'Q2?', expectedAnswerSummary: 'A2', expectedRiskStatus: 'UNSURE', expectedChunkText: ['The gold passage about provider Y.'] },
          { predefinedQuestionId: 3, question: 'Q3?', expectedAnswerSummary: 'A3', expectedRiskStatus: 'RISK_DETECTED' }, // no expectedChunkText — not graded for citations
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
        { predefinedQuestionId: 1, question: 'Q1?', riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>' },
        { predefinedQuestionId: 2, question: 'Q2?', riskStatus: 'UNSURE', answer: 'see <InTextCitation fileName="b.pdf" documentId="doc-2" chunkId="chunk-2"></InTextCitation>' },
        { predefinedQuestionId: 3, question: 'Q3?', riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="c.pdf" documentId="doc-3" chunkId="chunk-3"></InTextCitation>' }, // no expectedChunkText — excluded
      ],
    },
    chunkGroundingData: new Map([
      ['doc-1:chunk-1', 'The actual chunk text for attorney X, matching the gold passage.'],
      ['doc-2:chunk-2', 'A completely unrelated chunk about something else.'],
      ['doc-3:chunk-3', 'Text for question 3, irrelevant since ungraded.'],
    ]),
  };
}

test('jaccardSimilarity is 1 for identical text, case- and punctuation-insensitive', () => {
  assert.equal(jaccardSimilarity('The Cat Sat.', 'the cat sat'), 1);
});

test('jaccardSimilarity is 0 for completely disjoint text', () => {
  assert.equal(jaccardSimilarity('apples oranges grapes', 'trucks bicycles trains'), 0);
});

test('jaccardSimilarity is a fraction for partial word overlap', () => {
  // {a,b,c} vs {a,b,d}: intersection {a,b} = 2, union {a,b,c,d} = 4 -> 0.5
  assert.equal(jaccardSimilarity('a b c', 'a b d'), 0.5);
});

test('jaccardSimilarity is 0, not 1, when either side is empty', () => {
  assert.equal(jaccardSimilarity('', ''), 0);
  assert.equal(jaccardSimilarity('something', ''), 0);
  assert.equal(jaccardSimilarity('', 'something'), 0);
});

test('greedyPairBySimilarity pairs by content similarity, not position — proving reordered items still match', () => {
  // Primary items are about cats then dogs; candidates are in the OPPOSITE order (dogs then
  // cats). Positional pairing would pair "cats" with the dogs candidate and vice versa;
  // similarity-based pairing must still pair cats-with-cats and dogs-with-dogs.
  const primaryTexts = ['A passage about cats and kittens.', 'A passage about dogs and puppies.'];
  const candidateTexts = ['Some text about dogs and puppies.', 'Some text about cats and kittens.'];

  const matches = greedyPairBySimilarity(primaryTexts, candidateTexts);

  assert.equal(matches[0], 'Some text about cats and kittens.');
  assert.equal(matches[1], 'Some text about dogs and puppies.');
});

test('greedyPairBySimilarity leaves a primary item unpaired (undefined) when there are more primary items than candidates', () => {
  const primaryTexts = ['about cats', 'about dogs', 'about birds'];
  const candidateTexts = ['some cats content', 'some dogs content'];

  const matches = greedyPairBySimilarity(primaryTexts, candidateTexts);

  assert.equal(matches[0], 'some cats content');
  assert.equal(matches[1], 'some dogs content');
  assert.equal(matches[2], undefined);
});

test('greedyPairBySimilarity leaves extra candidates unused when there are more of them than primary items', () => {
  const primaryTexts = ['about cats'];
  const candidateTexts = ['some cats content', 'some dogs content', 'some birds content'];

  const matches = greedyPairBySimilarity(primaryTexts, candidateTexts);

  assert.equal(matches.length, 1);
  assert.equal(matches[0], 'some cats content');
});

test('greedyPairBySimilarity never assigns the same candidate to two different primary items', () => {
  // Both primary items are more similar to the same single candidate than to anything else —
  // the assignment must still be one-to-one, so only one of them can claim it.
  const primaryTexts = ['apple banana cherry', 'apple banana date'];
  const candidateTexts = ['apple banana cherry date'];

  const matches = greedyPairBySimilarity(primaryTexts, candidateTexts);

  const claimedCount = matches.filter((m) => m === candidateTexts[0]).length;
  assert.equal(claimedCount, 1);
});

// Distinguishes the per-question answer-content grading call (buildQuestionGradingPrompt)
// from the new chunk-text semantic-match call (buildChunkTextMatchPrompt) by prompt
// content, so a single mock can serve both call sites with different canned verdicts.
function isChunkTextMatchPrompt(prompt) {
  return prompt.includes('Expected source passage:');
}

test('qaMatchAssertion computes citationMatch via chunk-text semantic match using output.chunkGroundingData', async (t) => {
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      const matches = prompt.includes('attorney X');
      return { output: JSON.stringify({ matches, reason: matches ? 'Chunk supports the passage' : 'Chunk is unrelated' }) };
    }
    return { output: JSON.stringify({ matches: true, reason: 'answer content ok' }) };
  });

  const result = await qaMatchAssertion(fakeOutputWithCitations(), fakeContextWithExpectedChunkText());

  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
  assert.equal(result.perQuestionBreakdown[0].citationMatchReason, 'Chunk supports the passage');
  assert.equal(result.perQuestionBreakdown[0].citationMatchScore, 100);
  assert.equal(result.perQuestionBreakdown[1].citationMatches, false);
  assert.equal(result.perQuestionBreakdown[1].citationMatchReason, 'Chunk is unrelated');
  assert.equal(result.perQuestionBreakdown[1].citationMatchScore, 0);
  assert.equal(result.perQuestionBreakdown[2].citationMatches, undefined);
  assert.equal(result.perQuestionBreakdown[2].citationMatchScore, undefined);
  assert.equal(result.namedScores.citationMatch, 0.5); // 1 of 2 graded questions matched
});

test('qaMatchAssertion computes citationMatchScore as the fraction of this question\'s pairings that matched, not just the all-or-nothing citationMatches boolean', async (t) => {
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      // Two of this run's three cited chunks match, one does not.
      const matches = !prompt.includes('chunk-3-text');
      return { output: JSON.stringify({ matches, reason: matches ? 'matches' : 'does not match' }) };
    }
    return { output: JSON.stringify({ matches: true, reason: 'answer ok' }) };
  });

  const output = fakeOutputWithCitations();
  output.report.questions[0].answer = [
    'see <InTextCitation fileName="a1.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    'and <InTextCitation fileName="a2.pdf" documentId="doc-1" chunkId="chunk-2"></InTextCitation>',
    'and <InTextCitation fileName="a3.pdf" documentId="doc-1" chunkId="chunk-3"></InTextCitation>',
  ].join(' ');
  output.chunkGroundingData.set('doc-1:chunk-1', 'chunk-1-text about billing');
  output.chunkGroundingData.set('doc-1:chunk-2', 'chunk-2-text about billing');
  output.chunkGroundingData.set('doc-1:chunk-3', 'chunk-3-text about billing');

  const context = fakeContextWithExpectedChunkText();
  context.vars.expected.qa[0].expectedChunkText = ['gold passage about billing A', 'gold passage about billing B', 'gold passage about billing C'];
  context.vars.expected.qa[1].expectedChunkText = undefined;

  const result = await qaMatchAssertion(output, context);

  assert.equal(result.perQuestionBreakdown[0].citationMatches, false); // not ALL matched
  assert.equal(result.perQuestionBreakdown[0].citationMatchScore, 67); // 2 of 3 matched, rounded
});

test('qaMatchAssertion sets citationMatchScore to 0 (not undefined) when no citation resolves at all', async (t) => {
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      throw new Error('grader must not be called for a citation that never resolved');
    }
    return { output: JSON.stringify({ matches: true, reason: 'ok' }) };
  });

  const output = fakeOutputWithCitations();
  output.report.questions[0].answer = 'see <InTextCitation fileName="missing.pdf" documentId="doc-x" chunkId="chunk-x"></InTextCitation>';

  const context = fakeContextWithExpectedChunkText();
  context.vars.expected.qa[1].expectedChunkText = undefined;

  const result = await qaMatchAssertion(output, context);

  assert.equal(result.perQuestionBreakdown[0].citationMatches, false);
  assert.equal(result.perQuestionBreakdown[0].citationMatchScore, 0);
});

test('qaMatchAssertion pairs each resolved citation with its most similar expected passage, spending one call per pair, even when this run cites them in a different order than the baseline', async (t) => {
  const prompts = [];
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      prompts.push(prompt);
      return { output: JSON.stringify({ matches: true, reason: `pair ${prompts.length} matches` }) };
    }
    return { output: JSON.stringify({ matches: true, reason: 'answer ok' }) };
  });

  const output = fakeOutputWithCitations();
  // This run cites the IME chunk FIRST and the billing chunk SECOND — the opposite order from
  // expectedChunkText below — to prove pairing follows content similarity, not citation order.
  output.report.questions[0].answer = [
    'see <InTextCitation fileName="a1.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    'and <InTextCitation fileName="a2.pdf" documentId="doc-1" chunkId="chunk-2"></InTextCitation>',
  ].join(' ');
  output.chunkGroundingData.set('doc-1:chunk-1', 'Details about the IME report from Dr Smith.');
  output.chunkGroundingData.set('doc-1:chunk-2', 'Details about the billing dispute Form C-8.1B.');

  // This test isolates question 1's pairing behavior. Question 2 is also graded for citations
  // by default (fakeContextWithExpectedChunkText) and its citation always resolves
  // (fakeOutputWithCitations), which would add an uncounted grader call — so it's excluded here.
  const context = fakeContextWithExpectedChunkText();
  context.vars.expected.qa[0].expectedChunkText = [
    'A passage about the billing dispute and Form C-8.1B.',
    'A passage about the IME report and Dr Smith.',
  ];
  context.vars.expected.qa[1].expectedChunkText = undefined;

  const result = await qaMatchAssertion(output, context);

  assert.equal(prompts.length, 2, 'exactly one call per resolved citation, no fallback search across every candidate');
  // Resolved chunk-1 (IME) is this run's first-cited chunk, so it's processed first.
  assert.match(prompts[0], /IME report/);
  assert.match(prompts[0], /Dr Smith/);
  assert.match(prompts[1], /billing dispute/);
  assert.match(prompts[1], /Form C-8\.1B/);
  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
});

test('qaMatchAssertion reports citationMatches false when one pair does not match, surfacing that pair\'s own reason', async (t) => {
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      const matches = !prompt.includes('IME report');
      return { output: JSON.stringify({ matches, reason: matches ? 'billing pair matches' : 'IME pair does not match' }) };
    }
    return { output: JSON.stringify({ matches: true, reason: 'answer ok' }) };
  });

  const output = fakeOutputWithCitations();
  output.report.questions[0].answer = [
    'see <InTextCitation fileName="a1.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    'and <InTextCitation fileName="a2.pdf" documentId="doc-1" chunkId="chunk-2"></InTextCitation>',
  ].join(' ');
  output.chunkGroundingData.set('doc-1:chunk-1', 'Details about the IME report from Dr Smith.');
  output.chunkGroundingData.set('doc-1:chunk-2', 'Details about the billing dispute Form C-8.1B.');

  const context = fakeContextWithExpectedChunkText();
  context.vars.expected.qa[0].expectedChunkText = [
    'A passage about the billing dispute and Form C-8.1B.',
    'A passage about the IME report and Dr Smith.',
  ];
  context.vars.expected.qa[1].expectedChunkText = undefined;

  const result = await qaMatchAssertion(output, context);

  assert.equal(result.perQuestionBreakdown[0].citationMatches, false);
  assert.equal(result.perQuestionBreakdown[0].citationMatchReason, 'IME pair does not match');
});

test('qaMatchAssertion treats a resolved citation with no unclaimed expected passage left as an automatic non-match, spending no grader call on it', async (t) => {
  let chunkCallCount = 0;
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      chunkCallCount += 1;
      return { output: JSON.stringify({ matches: true, reason: 'pair matches' }) };
    }
    return { output: JSON.stringify({ matches: true, reason: 'answer ok' }) };
  });

  const output = fakeOutputWithCitations();
  // TWO citations in this run's answer, but only ONE expected gold passage — this run cited
  // more distinct chunks for this question than the baseline did.
  output.report.questions[0].answer = [
    'see <InTextCitation fileName="a1.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    'and <InTextCitation fileName="a2.pdf" documentId="doc-1" chunkId="chunk-2"></InTextCitation>',
  ].join(' ');
  output.chunkGroundingData.set('doc-1:chunk-1', 'Details about the billing dispute Form C-8.1B.');
  output.chunkGroundingData.set('doc-1:chunk-2', 'Details about the IME report from Dr Smith.');

  const context = fakeContextWithExpectedChunkText();
  context.vars.expected.qa[0].expectedChunkText = ['A passage about the billing dispute and Form C-8.1B.'];
  context.vars.expected.qa[1].expectedChunkText = undefined;

  const result = await qaMatchAssertion(output, context);

  assert.equal(chunkCallCount, 1, 'only one grader call, for the one resolved citation that claimed the sole expected passage');
  assert.equal(result.perQuestionBreakdown[0].citationMatches, false);
  assert.match(result.perQuestionBreakdown[0].citationMatchReason, /No unclaimed expected passage available/);
});

test('qaMatchAssertion ignores any expected passage left unclaimed after every resolved citation is paired', async (t) => {
  let chunkCallCount = 0;
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      chunkCallCount += 1;
      return { output: JSON.stringify({ matches: true, reason: 'pair matches' }) };
    }
    return { output: JSON.stringify({ matches: true, reason: 'answer ok' }) };
  });

  const output = fakeOutputWithCitations();
  // Only ONE citation in this run's answer, but TWO expected gold passages — this run cited
  // fewer distinct chunks for this question than the baseline did.
  output.report.questions[0].answer = 'see <InTextCitation fileName="a1.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>';
  output.chunkGroundingData.set('doc-1:chunk-1', 'Details about the billing dispute Form C-8.1B.');

  const context = fakeContextWithExpectedChunkText();
  context.vars.expected.qa[0].expectedChunkText = [
    'A passage about the billing dispute and Form C-8.1B.',
    'A passage about the IME report and Dr Smith.',
  ];
  context.vars.expected.qa[1].expectedChunkText = undefined;

  const result = await qaMatchAssertion(output, context);

  assert.equal(chunkCallCount, 1, 'only one resolved citation exists, so only one grader call is made regardless of extra expected passages');
  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
});

test('qaMatchAssertion skips a citation whose (documentId, chunkId) is not in chunkGroundingData, without crashing', async (t) => {
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      throw new Error('grader must not be called for a citation that never resolved');
    }
    return { output: JSON.stringify({ matches: true, reason: 'ok' }) };
  });

  const output = fakeOutputWithCitations();
  output.report.questions[0].answer = 'see <InTextCitation fileName="missing.pdf" documentId="doc-x" chunkId="chunk-x"></InTextCitation>';
  // doc-x:chunk-x is deliberately absent from chunkGroundingData

  // This test isolates question 1's unresolved-citation behavior. Question 2 is also graded
  // for citations by default (fakeContextWithExpectedChunkText) and its citation always
  // resolves (fakeOutputWithCitations), which would trigger the "must not be called" mock —
  // so it's excluded from citation grading here.
  const context = fakeContextWithExpectedChunkText();
  context.vars.expected.qa[1].expectedChunkText = undefined;

  const result = await qaMatchAssertion(output, context);

  assert.equal(result.perQuestionBreakdown[0].citationMatches, false);
  assert.equal(
    result.perQuestionBreakdown[0].citationMatchReason,
    'No cited chunk resolved to compare against the expected passage.'
  );
});

test('qaMatchAssertion treats a null chunkGroundingData (missing S3 file) as every citation unresolved', async (t) => {
  mockLoadApiProvider(t, async (prompt) => {
    if (isChunkTextMatchPrompt(prompt)) {
      throw new Error('grader must not be called when chunkGroundingData is null');
    }
    return { output: JSON.stringify({ matches: true, reason: 'ok' }) };
  });

  const output = fakeOutputWithCitations();
  output.chunkGroundingData = null;

  const result = await qaMatchAssertion(output, fakeContextWithExpectedChunkText());

  assert.equal(result.perQuestionBreakdown[0].citationMatches, false);
  assert.equal(result.perQuestionBreakdown[1].citationMatches, false);
});

test('qaMatchAssertion sets namedScores.citationMatch to undefined when no question has expectedChunkText', async (t) => {
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

  const result = await qaMatchAssertion(fakeOutputWithCitations(), fakeContextWithExpectedChunkText());

  const { riskStatusMatch, answerContentMatch, citationMatch } = result.namedScores;
  assert.equal(result.score, (riskStatusMatch + answerContentMatch + citationMatch) / 3);
});

test('qaMatchAssertion treats an empty-array expectedChunkText as NOT graded for citations', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const context = fakeContext();
  context.vars.expected.qa[0].expectedChunkText = [];

  const result = await qaMatchAssertion(fakeOutput(), context);

  assert.equal(result.perQuestionBreakdown[0].citationMatches, undefined);
  assert.equal('citationMatch' in result.namedScores, false);
});

test('qaMatchAssertion correctly reads expectedChunkText when vars are built by the real build-tests-vars.js pipeline, not hand-authored', async (t) => {
  const { buildTestsVars, buildExpectedQa } = require('../../scripts/build-tests-vars');
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  const existingReport = {
    summary: 'S',
    fraudRiskScore: 0.5,
    claimantName: 'X',
    defendant: 'Y',
    insuranceFirm: 'Z',
    questions: [
      { predefinedQuestionId: 1, question: 'Q1?', answer: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>', riskStatus: 'RISK_DETECTED' },
    ],
  };
  const existingGroundingData = new Map([['doc-1:chunk-1', 'gold passage text']]);
  const expectedQa = buildExpectedQa(existingReport.questions, existingGroundingData);
  const [{ vars }] = buildTestsVars({
    sourceBucketId: 1, claimCategoryId: 1, tags: undefined, newClaimName: 'x',
    ingestionModelId: 1, processingModelId: 9, existingReport, expectedQa,
  });
  const context = { vars, test: { assert: [{ metric: 'qa_match' }], options: {} } };
  const output = {
    report: {
      questions: [
        { predefinedQuestionId: 1, question: 'Q1?', riskStatus: 'RISK_DETECTED', answer: 'see <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>' },
      ],
    },
    chunkGroundingData: new Map([['doc-1:chunk-1', 'gold passage text']]),
  };

  const result = await qaMatchAssertion(output, context);

  assert.equal(result.namedScores.citationMatch, 1);
  assert.equal(result.perQuestionBreakdown[0].citationMatches, true);
});

test('qaMatchAssertion lists a fileName cited via two different chunks only once in actualCitedFileNames', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, reason: 'ok' }) }));

  // Citations are deduplicated by (documentId, chunkId), not by fileName — one source document
  // split across two cited chunks is two distinct citations, but still one cited file.
  const output = fakeOutput();
  output.report.questions[0].answer = [
    'see <InTextCitation fileName="same.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    'and <InTextCitation fileName="same.pdf" documentId="doc-1" chunkId="chunk-2"></InTextCitation>',
  ].join(' ');

  const result = await qaMatchAssertion(output, fakeContext());

  assert.deepEqual(result.perQuestionBreakdown[0].actualCitedFileNames, ['same.pdf']);
});

test('qaMatchAssertion carries expectedRiskStatus through to perQuestionBreakdown', async (t) => {
  mockLoadApiProvider(t, async () => ({ output: JSON.stringify({ matches: true, score: 90, reason: 'ok' }) }));

  const output = {
    report: {
      questions: [{ predefinedQuestionId: 1, question: 'Q1?', riskStatus: 'RISK_DETECTED', answer: 'Yes.' }],
    },
  };
  const context = {
    vars: {
      expected: {
        qa: [{ predefinedQuestionId: 1, question: 'Q1?', expectedRiskStatus: 'UNSURE', expectedAnswerSummary: 'Unsure.' }],
      },
    },
    test: { options: { provider: 'openai:chat:gpt-4o' } },
  };

  const result = await qaMatchAssertion(output, context);
  assert.equal(result.perQuestionBreakdown[0].expectedRiskStatus, 'UNSURE');
});
