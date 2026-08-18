'use strict';

const TAG_REGEX = /<InTextCitation\b([^>]*)>/g;
const FILE_NAME_ATTR_REGEX = /fileName="([^"]*)"/;
const DOCUMENT_ID_ATTR_REGEX = /documentId="([^"]*)"/;
const CHUNK_ID_ATTR_REGEX = /chunkId="([^"]*)"/;

// Full open+close tag pair, unlike TAG_REGEX (which only needs the opening tag's
// attributes to extract data) — here the *entire* tag, including its closing
// </InTextCitation>, must be matched and removed, or the literal closing-tag text
// would be left behind in the cleaned prose.
const FULL_TAG_REGEX = /<InTextCitation\b([^>]*)><\/InTextCitation>/g;

// Extracts fileName, documentId, and chunkId from every <InTextCitation ...>
// tag in a single answer's raw text, decodeURIComponent-ing fileName (the
// real report URL-encodes it, e.g. "JOSE%2BBRIONES...pdf" ->
// "JOSE+BRIONES...pdf"). Deduplicated by the (documentId, chunkId) pair, NOT
// by fileName alone — a single source document is commonly split into many
// distinct cited chunks, and documentId/chunkId together identify exactly
// which chunk was cited, which fileName alone cannot. Order of first
// appearance is preserved. A tag missing any of the three attributes is
// skipped entirely — a citation missing documentId or chunkId can't be
// looked up in the S3 chunk-grounding file, so it's useless downstream.
function extractCitedCitationsFromText(text) {
  if (!text) {
    return [];
  }
  const citations = [];
  const seen = new Set();
  TAG_REGEX.lastIndex = 0;
  let match;
  while ((match = TAG_REGEX.exec(text)) !== null) {
    const attrs = match[1];
    const fileNameMatch = FILE_NAME_ATTR_REGEX.exec(attrs);
    const documentIdMatch = DOCUMENT_ID_ATTR_REGEX.exec(attrs);
    const chunkIdMatch = CHUNK_ID_ATTR_REGEX.exec(attrs);
    if (!fileNameMatch || !documentIdMatch || !chunkIdMatch) {
      continue;
    }
    const fileName = decodeURIComponent(fileNameMatch[1]);
    const documentId = documentIdMatch[1];
    const chunkId = chunkIdMatch[1];
    const key = `${documentId}:${chunkId}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({ fileName, documentId, chunkId });
    }
  }
  return citations;
}

// Replaces every citation tag in `text` with a small inline [n] marker — same
// source cited twice reuses the same number — and returns an ordered legend for
// the sources actually referenced, for a short "Sources:" line below the answer.
// A tag missing fileName/documentId/chunkId (the same "useless downstream" case
// extractCitedCitationsFromText already skips) is removed with no marker, rather
// than left as raw markup.
function formatAnswerWithCitations(text) {
  if (!text) {
    return { cleanedText: text, legend: [] };
  }
  const citations = extractCitedCitationsFromText(text);
  const numberByKey = new Map(citations.map((c, i) => [`${c.documentId}:${c.chunkId}`, i + 1]));

  FULL_TAG_REGEX.lastIndex = 0;
  const cleanedText = text.replace(FULL_TAG_REGEX, (whole, attrs) => {
    const fileNameMatch = FILE_NAME_ATTR_REGEX.exec(attrs);
    const documentIdMatch = DOCUMENT_ID_ATTR_REGEX.exec(attrs);
    const chunkIdMatch = CHUNK_ID_ATTR_REGEX.exec(attrs);
    if (!fileNameMatch || !documentIdMatch || !chunkIdMatch) {
      return '';
    }
    const n = numberByKey.get(`${documentIdMatch[1]}:${chunkIdMatch[1]}`);
    return n ? `[${n}]` : '';
  });

  const legend = citations.map((c, i) => ({ number: i + 1, fileName: c.fileName }));
  return { cleanedText, legend };
}

module.exports = {
  extractCitedCitationsFromText,
  formatAnswerWithCitations,
  FILE_NAME_ATTR_REGEX,
  DOCUMENT_ID_ATTR_REGEX,
  CHUNK_ID_ATTR_REGEX,
};
