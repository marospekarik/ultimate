---
name: merge-upstream
description: Merge origin/main into this checkout's diverged main when Update now predicts conflicts (the user pressed Update with @ultimate). Use in the merge branch @ultimate starts for it.
---

# Merge upstream into a diverged main

This checkout keeps commits of its own on `main` and has no push access to `origin`, so upstream arrives by merge.
**Update now** already merges by itself when `git merge-tree` predicts no conflict. You are here because it predicted
some.

## Steps

1. In your worktree: `git fetch origin`, then `git merge origin/main`. Never rebase, reset, stash or force-push.
2. List the conflicts with `git diff --name-only --diff-filter=U`. For each, read both sides and the upstream commits
   that touched it (`git log --oneline HEAD..origin/main -- <file>`).
3. Resolve by intent, not by side:
   - **Upstream solved the same problem we solved locally** (for example its #116 against our person-wins families, or
     its push `sw.js` against our caching worker): take upstream's version, remove our now-dead code and every leftover
     reference to it (`rg` the names), and say what was dropped.
   - **Our feature does not exist upstream** (for example the smart merge in `extensions/update`): keep it and adapt it to
     upstream's new API, so both changes survive. Don't revive an API upstream removed.
   - **Moved files** (for example tests moving into `extensions/<name>/test/`): follow upstream's layout, carry our extra
     cases into the new place, and leave nothing behind at the old path.
4. Keep this checkout's local intent:
   - `.ultimate/settings.json`: model families hold colours only (models are per person), the lander checks run one
     after the other with 2 test workers, `lander.push` is `fork`. Take new upstream keys.
   - `.ultimate/agents/coordinator.md` and the other files under `.ultimate/`.
5. Run `pnpm install --frozen-lockfile` when the lockfile changed, `pnpm check`, and the tests of every file you
   resolved, fast and e2e (`pnpm test <path>`, `pnpm test:e2e <path>`). Then `workspace submit`.
6. Report:
   - how each conflict was resolved, and what was dropped;
   - whether `server/`, `shared/`, `patches/` or `pnpm-lock.yaml` changed (a restart), and whether `bin/` did (a
     human `pnpm start`).

## When the lander fails

Most failures here are 30 s timeouts of full-server tests under load, in files the merge didn't touch. Run those files
alone on your tip. A test that is near 30 s even alone gets fixed at its cause in its own test-only commit (split it,
or share one server between cases); never raise the timeout. Don't resubmit in a loop: report the numbers and the tip.
