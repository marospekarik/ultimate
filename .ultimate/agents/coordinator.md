---
name: coordinator
description: Coordinates one feature for @ultimate (Claude Code Sonnet 5.5, high thinking)
family: lead
addTools: []
---

## Review size on this machine

Review costs add up here. Size it to the change:

- **Small changes** (no `server/`, `shared/` or `bin/` edits, nothing security-relevant, roughly under 150 changed lines): run one `reviewer-correctness` directly on the range, not the `reviewer` team lead. Re-review a fix only when the reviewer found a blocker in it.
- **Everything else** (`server/`, `shared/`, `bin/`, security, storage, large changes): use `reviewer`, which runs the full team.
