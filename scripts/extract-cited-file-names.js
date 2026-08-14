'use strict';

const TAG_REGEX = /<InTextCitation\b([^>]*)>/g;
const FILE_NAME_ATTR_REGEX = /fileName="([^"]*)"/;

// Extracts every fileName= attribute from <InTextCitation ...> tags in a single
// answer's raw text, decodeURIComponent-ing each (the real report URL-encodes
// fileName, e.g. "JOSE%2BBRIONES...pdf" -> "JOSE+BRIONES...pdf"), deduplicated
// in order of first appearance. documentId (also present on the tag) is
// intentionally NOT extracted here — it's assigned per-ingestion and differs
// on every eval run, so it can't be used as a stable identifier the way
// fileName can (see docs/superpowers/specs/2026-08-14-citation-match-design.md).
function extractCitedFileNamesFromText(text) {
  if (!text) {
    return [];
  }
  const fileNames = [];
  const seen = new Set();
  TAG_REGEX.lastIndex = 0;
  let match;
  while ((match = TAG_REGEX.exec(text)) !== null) {
    const fileNameMatch = FILE_NAME_ATTR_REGEX.exec(match[1]);
    if (fileNameMatch) {
      const fileName = decodeURIComponent(fileNameMatch[1]);
      if (!seen.has(fileName)) {
        seen.add(fileName);
        fileNames.push(fileName);
      }
    }
  }
  return fileNames;
}

module.exports = { extractCitedFileNamesFromText };
