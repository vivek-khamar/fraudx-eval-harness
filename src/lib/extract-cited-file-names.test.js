'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCitedCitationsFromText } = require('./extract-cited-file-names');

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
