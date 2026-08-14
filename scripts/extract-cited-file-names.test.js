'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCitedFileNamesFromText } = require('./extract-cited-file-names');

test('extractCitedFileNamesFromText returns the decoded fileName from a single citation tag', () => {
  const text = 'see <InTextCitation fileName="JOSE%2BBRIONES.pdf" documentId="abc-123"></InTextCitation>';
  assert.deepEqual(extractCitedFileNamesFromText(text), ['JOSE+BRIONES.pdf']);
});

test('extractCitedFileNamesFromText dedupes repeated citations of the same file, keeping first-appearance order', () => {
  const text = [
    '<InTextCitation fileName="b.pdf" documentId="1"></InTextCitation>',
    '<InTextCitation fileName="a.pdf" documentId="2"></InTextCitation>',
    '<InTextCitation fileName="b.pdf" documentId="3"></InTextCitation>',
  ].join(' ');
  assert.deepEqual(extractCitedFileNamesFromText(text), ['b.pdf', 'a.pdf']);
});

test('extractCitedFileNamesFromText returns an empty array when there are no citation tags', () => {
  assert.deepEqual(extractCitedFileNamesFromText('No sources found to answer this query!'), []);
});

test('extractCitedFileNamesFromText returns an empty array for null, undefined, or empty-string input', () => {
  assert.deepEqual(extractCitedFileNamesFromText(null), []);
  assert.deepEqual(extractCitedFileNamesFromText(undefined), []);
  assert.deepEqual(extractCitedFileNamesFromText(''), []);
});

test('extractCitedFileNamesFromText ignores documentId and every other tag attribute, extracting only fileName', () => {
  const text = '<InTextCitation url="https://x" chunkId="c1" fileName="report.pdf" fileType="pdf" documentId="doc-guid-1" sourceIndex="1" occurrenceIndex="1"></InTextCitation>';
  assert.deepEqual(extractCitedFileNamesFromText(text), ['report.pdf']);
});

test('extractCitedFileNamesFromText is reusable across multiple calls without leaking regex state', () => {
  // Guards against a module-level `g`-flag RegExp whose lastIndex isn't reset between calls,
  // which would silently make every other call return [] regardless of its own input.
  const first = extractCitedFileNamesFromText('<InTextCitation fileName="one.pdf"></InTextCitation>');
  const second = extractCitedFileNamesFromText('no citations here');
  const third = extractCitedFileNamesFromText('<InTextCitation fileName="two.pdf"></InTextCitation>');
  assert.deepEqual(first, ['one.pdf']);
  assert.deepEqual(second, []);
  assert.deepEqual(third, ['two.pdf']);
});
