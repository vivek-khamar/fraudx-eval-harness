# PDF Report Restructure: Two Sections + Visual Cleanup

## Goal

Today's PDF (`scripts/generate-pdf-report.js`) is one long flowing document:
a plain-text header (bucket id, ingestion time, processing time, accuracy,
generated-at), then the question-by-question breakdown, then the claim
metadata table, then the overall summary. Ingestion and scoring/QA
information are interleaved with no visual separation.

Reference: `GroundX-Ingestion-Monitoring-Report_2026-08-07.pdf` (an SRE
monitoring report from a different, unrelated system) demonstrates a much
clearer information architecture worth adopting — a compact stat-card grid
for headline numbers, a short narrative "verdict" callout, and clearly
labeled sections — **without** attempting to reproduce its custom branding
(dark gradient hero banner, logo, colored rounded cards with drop shadows).
Per your call: adopt the *structure*, keep pdfkit's existing plain-drawing
style; and only surface ingestion numbers we can actually populate honestly
(we have no GPU/pod/quota/concurrency telemetry — that's a different
system's SRE stack, not ours).

## Decisions

### Two top-level sections

1. **Document Ingestion** — how the source documents copied into the fresh
   bucket, before any claim processing happened.
2. **Claim Processing** — the report itself: per-question Q&A results,
   entity/metadata match, overall summary. This is today's existing content,
   relabeled and regrouped under an explicit section header rather than
   floating unlabeled at the top of the page.

A short preamble above both sections keeps only identity/provenance fields
that belong to neither: report title, Bucket ID, Generated at.

### Reusable stat-card row helper

```js
// Draws `cards.length` equal-width bordered boxes in a row: a large bold
// value on top, a small label beneath. `color` (optional, per card) tints
// just the value text — e.g. green for a clean success count, red for a
// nonzero failure count — everything else (borders, labels) stays plain
// black/gray, matching pdfkit's existing minimal aesthetic elsewhere in
// this file (drawTableRow's borders, the `#cccccc` question dividers).
function drawStatCardRow(doc, cards) {
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 10;
  const cardWidth = (usableWidth - gap * (cards.length - 1)) / cards.length;
  const cardHeight = 60;
  if (doc.y + cardHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();
  const startY = doc.y;
  cards.forEach((card, i) => {
    const x = doc.page.margins.left + i * (cardWidth + gap);
    doc.rect(x, startY, cardWidth, cardHeight).stroke('#cccccc');
    doc.fontSize(18).font('Helvetica-Bold').fillColor(card.color || 'black')
      .text(String(card.value), x + 8, startY + 10, { width: cardWidth - 16 });
    doc.fontSize(9).font('Helvetica').fillColor('black')
      .text(card.label, x + 8, startY + 36, { width: cardWidth - 16 });
  });
  doc.y = startY + cardHeight + 12;
  doc.x = doc.page.margins.left;
}
```

### Section 1: Document Ingestion

Stat-card row, using only data the pipeline actually has:

| Value | Label | Color |
|---|---|---|
| `sourceDocs.length` | Docs submitted | — |
| `sourceDocs.length - failedDocuments.length` | Docs complete | green |
| `failedDocuments.length` | Docs failed | red if > 0, else black |
| `ingestion.timeMs / 1000` (formatted, e.g. `12.3s`) | Ingestion time | — |

Below the card row: if `failedDocuments.length > 0` (per the ingestion-
resilience design in `2026-08-18-bucket-driven-baseline-design.md`), a
"Failed documents" list — one line per entry, `fileName: error`. Omitted
entirely (no heading, no empty box) when there are none, so a clean run's
report doesn't grow a section for something that didn't happen.

`output.ingestion` gains the two new counts needed here — `provider.js`
already knows `sourceDocs.length` and (after the ingestion-resilience
change) `failedDocuments.length` at the point it builds `output`:

```js
ingestion: {
  timeMs: ingestionTimeMs,
  docsSubmitted: sourceDocs.length,
  docsComplete: sourceDocs.length - failedDocuments.length,
},
```

(`docsFailed` is `failedDocuments.length`, read directly off the
already-planned `output.failedDocuments` rather than duplicated onto
`ingestion` too.)

### Section 2: Claim Processing

Stat-card row using today's existing dashboard numbers, now placed under an
explicit heading instead of a bare header:

| Value | Label |
|---|---|
| `accuracy` | Accuracy |
| `processing.timeMs / 1000` (formatted) | Processing time |
| `namedScores.riskStatusMatch` (formatted as a %) | Risk status match |
| `namedScores.answerContentMatch` (formatted as a %) | Answer content match |

`citationMatch` is a 5th card only when defined (`namedScores.citationMatch
!== undefined`) — the row helper takes a plain array, so a variable card
count (4 or 5) is just a longer/shorter array, no special-casing in the
helper itself.

Then, in order: the existing per-question breakdown (reformatted below),
the existing claim-metadata table (unchanged content, just moved under this
section's heading), the existing overall-summary paragraph (unchanged).

### Q&A breakdown formatting improvements

Current per-question layout is six separate label/value lines (`Risk Status
Match`, `Citation Match`, `Match`, `Answer`, `Reason`, plus the question
heading). Two changes, both purely cosmetic (no data change):

1. **Risk status as a colored tag next to the question number**, using the
   question's actual `riskStatus` (not just whether it matched) — e.g.
   `Q3: {question}` followed immediately by a small colored
   `[RISK DETECTED]` / `[UNSURE]` / `[RISK NOT DETECTED]` tag (red / gray /
   green respectively) on the same line. This is new *visible* information
   (today's PDF never shows what the actual risk status *was*, only whether
   it matched the expected one) — surfaced for free from data already in
   `perQuestionBreakdown`.
2. **Collapse the three match indicators onto one line**, color-coded
   instead of plain "YES"/"NO" text on separate lines:
   `Risk Status Match: YES   Citation Match: NO (reason)   Answer Match: YES`
   — green for YES, red for NO, gray for N/A — reusing
   `formatCitationMatch`'s existing reason-rendering unchanged. This cuts
   three lines to one per question, leaving more room for the Answer/Reason
   paragraphs that actually vary in length.

`Answer:` and `Reason:` stay as full-width flowing paragraphs exactly as
today (no change — they're already the right shape for variable-length
text).

### Color palette (kept minimal, no new dependency)

Reuses pdfkit's built-in named colors only (`'green'`, `'red'`, `'gray'`,
`'black'`) — no hex palette, no gradients, matching the "adopt structure not
branding" decision. `doc.fillColor(...)` before text, reset to `'black'`
immediately after each colored fragment (pdfkit's fill color is stateful
across calls, same gotcha the existing code already navigates for
`doc.x`/`doc.y` — see `drawTableRow`'s comment on this).

## Testing

- `scripts/generate-pdf-report.test.js`:
  - `drawStatCardRow` renders N cards' values and labels, re-parsed via
    `pdf-parse` (same technique every existing PDF-content test already
    uses).
  - Document Ingestion section: docs submitted/complete/failed counts and
    ingestion time appear; a claim with `failedDocuments` renders the
    "Failed documents" list with each `fileName`/`error`; a claim with none
    renders no such heading at all (assert the heading text does *not*
    appear).
  - Claim Processing section: existing accuracy/processing-time assertions
    move under this section's heading; a 5th citationMatch card appears
    only when `namedScores.citationMatch !== undefined`.
  - Q&A section: a question's actual `riskStatus` renders as a tag
    (`RISK DETECTED`/`UNSURE`/`RISK NOT DETECTED`) distinct from whether it
    *matched*; the three match indicators render on one line, not three.
  - Existing tests for `formatCitationMatch`, `sortByRiskStatus`,
    `uniqueFilePath`, `formatTimestampForFilename`, `formatLocalTimestamp`,
    `humanizeFieldName` are unchanged — none of their behavior changes,
    only where their output gets placed on the page.

## Out of scope

- No attempt to reproduce the reference report's actual visual branding
  (colors, logo, rounded corners, dark hero banner) — explicitly rejected in
  favor of adopting its information architecture within pdfkit's existing
  plain style.
- No new ingestion telemetry beyond docs submitted/complete/failed and
  ingestion time — we have no GPU/pod/quota/concurrency data to show,
  regardless of what the reference report displays.
- No charts/graphs (the reference's throughput-over-time and per-step-timing
  charts) — nothing in this pipeline's data supports them (no time-series
  telemetry, only start/end timestamps for two coarse phases).
