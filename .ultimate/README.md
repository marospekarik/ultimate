This is Ultimate's own repository, and this setup is the one it is built with: Ultimate plans, delegates, checks its
work, and changes its own code while you talk to it.

## What it adds

Every built-in is already on; this setup adds how the repository is landed and reviewed:

- `settings.json`: each worktree isolate installs its dependencies, and the lander runs `pnpm check`, then
  `pnpm test` (2 workers) and `pnpm test:e2e`, one after the other, and pushes to the `fork` remote. This checkout
  has no push access to `origin` (`HazAT/ultimate`): `main` goes to the user's fork, and changes reach upstream as pull
  requests from branches there. Where `AGENTS.md` says the lander pushes to `origin`, read `fork` for this checkout.
- `skills/merge-upstream`: how to merge `origin/main` into this diverged `main` when Update now predicts conflicts.
- `agents/reviewer-*.md`: the review team (correctness, simplicity, architecture), each on its own model; the shipped
  `reviewer` starts them in parallel and returns one merged verdict.

To adopt parts of this setup in another project, ask its @ultimate for a tour (the `adopt-ultimate-setup` skill);
onboarding offers it too.

## How to work with it

See [the work model](../AGENTS.md#how-work-is-organised-a-forest-of-conversation-trees) for coordination and
[Surfaces](../README.md#surfaces) for apps beside the conversation.

## How it runs

See [reload layers](../AGENTS.md#layers-and-how-they-reload), [running the server](../docs/running.md) and
[durability](../docs/durability.md) before changing the running system.

## Read more

`README.md` to start, `AGENTS.md` for the reload layers and the rules, `extensions/README.md` to write extensions.
