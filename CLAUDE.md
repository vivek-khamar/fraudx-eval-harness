# Working conventions for this repo

These are conventions established in practice, not enforced by tooling — read them before
assuming a different default.

- **Work directly on `master`. No branch/PR flow.** Commit directly to `master` and push when
  asked; don't create a feature branch or open a PR unless explicitly requested.
- **Design before building.** For any non-trivial change, write a design spec to
  `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and an implementation plan to
  `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` before writing code — see existing files there
  for the expected shape. Small, well-scoped fixes don't need this ceremony.
- **`/run-eval`** (`.claude/commands/run-eval.md`) triggers a real eval run (`npm run eval`)
  against the live FraudX platform from inside a Claude Code session — state the resolved
  parameters back before running, since it creates a real claim and takes 30–90+ minutes.
- **`.env` holds real credentials** (FraudX login, AWS). A project-level hook
  (`.claude/hooks/block-sensitive-files.sh`) blocks any Bash command that touches `.env`/`.pem`/
  `.key` files — this is intentional, not a bug; ask the user directly instead of working around it.
- See `README.md` for how the eval pipeline actually works (architecture, setup, running against
  the mock server, CI).
