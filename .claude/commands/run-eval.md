---
description: Run the FraudX claim eval (npm run eval) against a real source bucket
---

Run this project's live eval pipeline (`npm run eval`) against the real FraudX platform, using
the parameters below. Do not run this against the mock server — that's a separate documented
flow in README.md ("Running against the mock server").

## Parse arguments

Parse `$ARGUMENTS` for these fields (accept them in any order, as `key=value` pairs separated by
spaces or commas; also accept plain natural language like "bucket 31804 claim name foo-test" —
use judgment to extract the same fields either way):

- `bucketId` / `sourceBucketId` — **required**. The existing, already-processed bucket whose
  report becomes ground truth.
- `claimName` — the name for the new claim this run creates. The real platform will not let you
  reuse a claim name. If not given, propose one yourself (e.g. `<bucketId>-eval-<today's date>`)
  and confirm it with the user before proceeding — don't just invent one silently.
- `ingestionModel` — exact FraudX model catalog `displayName` (e.g. `openai-gpt-5.4`), not the
  bare model name. If omitted, check whether `INGESTION_MODEL_NAME` is already set in `.env`; if
  so use that; if not, ask the user for it.
- `processingModel` — same rules as `ingestionModel`, backed by `PROCESSING_MODEL_NAME`.

If `bucketId` is missing entirely, stop and ask for it — don't guess a bucket id.

## Before running

This creates a brand-new claim/bucket on the real FraudX platform and spends real grader API
calls — not free, not instant (ingestion + processing + grading commonly takes 30–90+ minutes,
sometimes longer for large documents). State back to the user, in one line, exactly what you're
about to run (bucket id, claim name, both model names) before executing, so they can catch a
wrong bucket id or model name before it kicks off a long real run.

## Run it

Execute in the background (this is long-running — do not block the conversation waiting on it,
and do not poll):

```bash
SOURCE_BUCKET_ID=<bucketId> CLAIM_NAME="<claimName>" \
  INGESTION_MODEL_NAME="<ingestionModel>" PROCESSING_MODEL_NAME="<processingModel>" \
  npm run eval
```

Leave every other env var (`FRAUDX_ENDPOINT_URI`, `GRADER_PROVIDER`, AWS credentials, etc.) to
come from the existing `.env` — never prompt for or override those here.

## When it finishes

Report back:
- The console dashboard's pass/fail/error summary (from `scripts/score-dashboard.js`'s JSON
  output, printed during the run).
- The generated PDF's path, under `reports/<bucketId>/`.
- If the command exited non-zero (a claim errored, e.g. a bad model name or an expired session),
  say so plainly — don't report success just because *a* PDF was written if the exit code was
  non-zero.
