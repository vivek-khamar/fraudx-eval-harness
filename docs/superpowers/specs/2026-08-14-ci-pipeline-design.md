# CI Pipeline Design

## Goal

Give this repo a GitHub Actions workflow that can run the unit test suite and, separately, the full real-FraudX eval + PDF report flow, without either one running automatically on every push or PR.

## Background

This repo currently has no CI configuration at all (`.github/workflows/` doesn't exist) and no git remote configured. The README's existing "## CI" section only says to "wrap `npm run eval` in a CI workflow step" — it was aspirational, not implemented.

Two very different kinds of work exist in this repo, and they must be triggered differently:

- **`npm test`** — 116 unit tests (`provider.test.js`, `config-shape.test.js`, `scripts/score-dashboard.test.js`, `scripts/qa-match-assertion.test.js`, `scripts/metadata-match-assertion.test.js`, `scripts/generate-pdf-report.test.js`, `fraudx-client.test.js`, `scripts/generate-tests-vars.test.js`). All mocked — no live network calls, no credentials, runs in about a second.
- **`npm run eval`** — logs into the real FraudX gateway, ingests a golden claim's documents, waits for real processing, grades the result with a real LLM grader, and (via `npm run score`, chained on) writes the console dashboard and PDF reports. This hits a live paid endpoint with real credentials, and the ingestion/processing poll timeouts default to 60 minutes each (`FRAUDX_UPLOAD_POLL_TIMEOUT_MS`, `FRAUDX_PROCESSING_POLL_TIMEOUT_MS`), so a single claim can realistically take well over an hour.

Given that gap, the pipeline must never trigger the real eval automatically — it needs to be an explicit, deliberate action.

## Decisions

- **Platform:** GitHub Actions. One new file: `.github/workflows/ci.yml`.
- **Trigger:** `workflow_dispatch` only, with a required `mode` input (`choice`, options `tests-only` / `full-eval`, default `tests-only`). Nothing runs on `push` or `pull_request`.
- **Jobs:**
  - `unit-tests` — always runs regardless of `mode`. Checks out the repo, sets up Node 22.x (satisfies `engines: ">=20.16.0 <21 || >=22.3.0"`) with npm's dependency cache (`actions/setup-node`'s `cache: 'npm'`, keyed off the existing `package-lock.json`), runs `npm ci`, then `npm test`. No secrets required.
  - `full-eval` — only runs when `mode == 'full-eval'` (`if: inputs.mode == 'full-eval'`), and only after `unit-tests` succeeds (`needs: unit-tests`). This is a deliberate gate: `full-eval` costs real time (30-60+ minutes) and money (real API/grader calls) — if the code is broken, `unit-tests` fails in seconds and `full-eval` never starts. Runs `npm run eval` (which internally chains `eval:raw` — the real promptfoo run against `FRAUDX_TEST_ENDPOINT` — and `score`, which writes the console dashboard and generates PDF reports into `reports/`), reading required config from GitHub Actions secrets (below). Sets `timeout-minutes: 240` as an explicit safety net (GitHub's default job timeout is 360 minutes; 240 gives generous headroom for the current single golden claim while still failing a truly hung run well before the platform default).
- **Concurrency:** a `concurrency` block scoped to the `full-eval` job only (not `unit-tests`, which should stay free to run anytime) — group name `fraudx-full-eval`, `cancel-in-progress: false` (queue a second dispatch rather than cancel an in-flight real claim). This mirrors the reasoning the README already documents for local `--max-concurrency 1`: the real FraudX platform has shared, account-level ingestion limits, so two real evals should never run concurrently.
- **Artifact upload:** `full-eval` uploads `reports/**` (the generated PDFs only, not `results.json`) via `actions/upload-artifact`, with `if: always()` on that step — so PDFs are still available for inspection even when the eval step itself exits nonzero (which happens whenever an assertion doesn't meet its pass bar; that's a meaningful signal about the FraudX pipeline's quality, not a CI misconfiguration, and shouldn't suppress the artifact).
- **Secrets:** `full-eval` needs the following, added to the GitHub repo (or a GitHub Environment) as Actions secrets — this workflow only ever reads them via `${{ secrets.NAME }}`; it never writes or logs them, and no secret values are handled in this design/implementation process itself:
  - `FRAUDX_TEST_ENDPOINT`
  - `FRAUDX_LOGIN_EMAIL`
  - `FRAUDX_LOGIN_PASSWORD`
  - `GRADER_PROVIDER`
  - `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` — both are passed through as env vars (from whichever secrets exist; an unset secret becomes an empty string, which is harmless) since `GRADER_PROVIDER`'s value determines which one promptfoo actually needs at runtime, and this workflow has no way to know that value ahead of time.

  These are passed as job-level `env:` vars (not a generated `.env` file) — `dotenv` (used by `provider.js` and `scripts/generate-pdf-report.js`) does not override already-set `process.env` values, so real CI-injected env vars take effect exactly as a local `.env` file would.
- **Scope explicitly excluded** (per your choices): no automatic `push`/`pull_request` triggers; `tests-only` mode runs `npm test` only (no mock-server end-to-end smoke run); no `results.json` upload, only the `reports/` PDFs.

## Testing

There's no meaningful way to unit-test a GitHub Actions YAML file. Verification is:
1. Validate the YAML parses and the job graph (`needs`, `if` conditions) is structurally correct using `actionlint` if available, or a manual review against GitHub's workflow syntax.
2. Push the workflow file and manually dispatch it once in `tests-only` mode (no secrets required) to confirm `unit-tests` runs and passes.
3. Document, but do not require, a manual `full-eval` dispatch as part of this work — that needs real secrets configured in the GitHub repo first, which is your action to take separately.

## Documentation

Update the README's existing "## CI" section to describe the actual workflow (trigger, modes, gate, secrets, artifacts) instead of the current aspirational one-liner.
