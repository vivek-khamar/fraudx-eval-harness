'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCitedCitationsFromText, formatAnswerWithCitations } = require('./extract-cited-file-names');

test('extractCitedCitationsFromText returns the decoded fileName, documentId, and chunkId from a single citation tag', () => {
  const text = 'see <InTextCitation fileName="JOSE%2BBRIONES.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>';
  assert.deepEqual(extractCitedCitationsFromText(text), [
    { fileName: 'JOSE+BRIONES.pdf', documentId: 'doc-1', chunkId: 'chunk-1' },
  ]);
});

test('extractCitedCitationsFromText does not dedupe two citations of the same file when their chunkId differs', () => {
  const text = [
    '<InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    '<InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-2"></InTextCitation>',
  ].join(' ');
  assert.deepEqual(extractCitedCitationsFromText(text), [
    { fileName: 'a.pdf', documentId: 'doc-1', chunkId: 'chunk-1' },
    { fileName: 'a.pdf', documentId: 'doc-1', chunkId: 'chunk-2' },
  ]);
});

test('extractCitedCitationsFromText dedupes repeated citations of the same (documentId, chunkId) pair, keeping first-appearance order', () => {
  const text = [
    '<InTextCitation fileName="b.pdf" documentId="doc-2" chunkId="chunk-2"></InTextCitation>',
    '<InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    '<InTextCitation fileName="b.pdf" documentId="doc-2" chunkId="chunk-2"></InTextCitation>',
  ].join(' ');
  assert.deepEqual(extractCitedCitationsFromText(text), [
    { fileName: 'b.pdf', documentId: 'doc-2', chunkId: 'chunk-2' },
    { fileName: 'a.pdf', documentId: 'doc-1', chunkId: 'chunk-1' },
  ]);
});

test('extractCitedCitationsFromText returns an empty array when there are no citation tags', () => {
  assert.deepEqual(extractCitedCitationsFromText('No sources found to answer this query!'), []);
});

test('extractCitedCitationsFromText returns an empty array for null, undefined, or empty-string input', () => {
  assert.deepEqual(extractCitedCitationsFromText(null), []);
  assert.deepEqual(extractCitedCitationsFromText(undefined), []);
  assert.deepEqual(extractCitedCitationsFromText(''), []);
});

test('extractCitedCitationsFromText skips a citation tag missing fileName, documentId, or chunkId', () => {
  const text = [
    '<InTextCitation documentId="doc-1" chunkId="chunk-1"></InTextCitation>', // no fileName
    '<InTextCitation fileName="b.pdf" chunkId="chunk-2"></InTextCitation>', // no documentId
    '<InTextCitation fileName="c.pdf" documentId="doc-3"></InTextCitation>', // no chunkId
    '<InTextCitation fileName="d.pdf" documentId="doc-4" chunkId="chunk-4"></InTextCitation>', // complete
  ].join(' ');
  assert.deepEqual(extractCitedCitationsFromText(text), [
    { fileName: 'd.pdf', documentId: 'doc-4', chunkId: 'chunk-4' },
  ]);
});

test('extractCitedCitationsFromText ignores every other tag attribute (url, fileType, sourceIndex, occurrenceIndex)', () => {
  const text = '<InTextCitation url="https://x" chunkId="chunk-1" fileName="report.pdf" fileType="pdf" documentId="doc-1" sourceIndex="1" occurrenceIndex="1"></InTextCitation>';
  assert.deepEqual(extractCitedCitationsFromText(text), [
    { fileName: 'report.pdf', documentId: 'doc-1', chunkId: 'chunk-1' },
  ]);
});

test('extractCitedCitationsFromText is reusable across multiple calls without leaking regex state', () => {
  const first = extractCitedCitationsFromText('<InTextCitation fileName="one.pdf" documentId="d1" chunkId="c1"></InTextCitation>');
  const second = extractCitedCitationsFromText('no citations here');
  const third = extractCitedCitationsFromText('<InTextCitation fileName="two.pdf" documentId="d2" chunkId="c2"></InTextCitation>');
  assert.deepEqual(first, [{ fileName: 'one.pdf', documentId: 'd1', chunkId: 'c1' }]);
  assert.deepEqual(second, []);
  assert.deepEqual(third, [{ fileName: 'two.pdf', documentId: 'd2', chunkId: 'c2' }]);
});

test('formatAnswerWithCitations replaces each citation tag with a numbered [n] marker, in order of first appearance', () => {
  const text = [
    'First point <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>.',
    'Second point <InTextCitation fileName="b.pdf" documentId="doc-2" chunkId="chunk-2"></InTextCitation>.',
  ].join(' ');

  const { cleanedText, legend } = formatAnswerWithCitations(text);

  assert.equal(
    cleanedText,
    'First point [1]. Second point [2].'
  );
  assert.deepEqual(legend, [
    { number: 1, fileName: 'a.pdf' },
    { number: 2, fileName: 'b.pdf' },
  ]);
});

test('formatAnswerWithCitations reuses the same marker number when the same (documentId, chunkId) is cited twice', () => {
  const text = [
    'See <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>',
    'and again <InTextCitation fileName="a.pdf" documentId="doc-1" chunkId="chunk-1"></InTextCitation>.',
  ].join(' ');

  const { cleanedText, legend } = formatAnswerWithCitations(text);

  assert.equal(cleanedText, 'See [1] and again [1].');
  assert.deepEqual(legend, [{ number: 1, fileName: 'a.pdf' }]);
});

test('formatAnswerWithCitations removes a tag missing fileName, documentId, or chunkId with no marker left behind', () => {
  const text = 'See <InTextCitation documentId="doc-1" chunkId="chunk-1"></InTextCitation> for details.';

  const { cleanedText, legend } = formatAnswerWithCitations(text);

  assert.equal(cleanedText, 'See  for details.');
  assert.deepEqual(legend, []);
});

test('formatAnswerWithCitations returns the text unchanged and an empty legend when there are no citation tags', () => {
  const { cleanedText, legend } = formatAnswerWithCitations('No sources found to answer this query!');
  assert.equal(cleanedText, 'No sources found to answer this query!');
  assert.deepEqual(legend, []);
});

test('formatAnswerWithCitations returns the input unchanged (and an empty legend) for null, undefined, or empty-string input, without throwing', () => {
  assert.deepEqual(formatAnswerWithCitations(null), { cleanedText: null, legend: [] });
  assert.deepEqual(formatAnswerWithCitations(undefined), { cleanedText: undefined, legend: [] });
  assert.deepEqual(formatAnswerWithCitations(''), { cleanedText: '', legend: [] });
});

test('formatAnswerWithCitations is reusable across multiple calls without leaking regex state', () => {
  const first = formatAnswerWithCitations('<InTextCitation fileName="one.pdf" documentId="d1" chunkId="c1"></InTextCitation>');
  const second = formatAnswerWithCitations('no citations here');
  const third = formatAnswerWithCitations('<InTextCitation fileName="two.pdf" documentId="d2" chunkId="c2"></InTextCitation>');
  assert.equal(first.cleanedText, '[1]');
  assert.equal(second.cleanedText, 'no citations here');
  assert.equal(third.cleanedText, '[1]');
});
