#!/bin/bash
# PreToolUse guard for Bash: blocks any command whose text touches this project's
# sensitive files. `.env` holds real FraudX platform and AWS credentials — reading,
# catting, grepping, or even checking its existence via Bash requires explicit user
# confirmation first, rather than a command doing it silently.
#
# Scoped down from a more general personal denylist (kubectl/terraform/SQL-drops/
# force-push/etc., typically kept in a user's own ~/.claude/hooks/) to just the one
# rule that's actually relevant to this repo's risk profile, and committed here so
# it applies regardless of who's using Claude Code on this project.
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
block() { jq -n --arg r "$1" '{decision: "block", reason: $r}'; exit 0; }
allow() { echo '{"decision": "allow"}'; exit 0; }

[ -z "$CMD" ] && allow

if echo "$CMD" | grep -qE '([[:space:]/]|^)(\.env|[A-Za-z0-9_.-]*\.pem|[A-Za-z0-9_.-]*\.key)([[:space:]]|$|['"'"'\"])'; then
  block "Blocked: this command touches a sensitive file (.env/.pem/.key) in fraudx-claim-eval. Confirm with the user before accessing credentials directly."
fi

allow
