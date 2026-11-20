Marks each open HazAT/ultimate pull request in the PRs surface by how worth adopting it is for this fork, judged by
TypeSafe's Jev System One through `classify`. This project only; it is not meant for upstream.

## What you see

In the PRs list, a small dot among a row's tags: green for **adopt** (worth pulling into the fork now), amber for
**watch** (useful later, or better once upstream merges it), a hollow ring for **ours** (your own PR, not judged), and
nothing for **skip**. Hover the dot for the verdict, Jev's confidence and a one-line reason. The PR's page shows the
same as a line under its title.

## How a PR is judged

One `classify` request per PR, with four questions (`fit.ts`):

- `verdict` (choice): adopt, watch or skip.
- `needed` (yes/no): does it solve a problem this setup has?
- `overlap` (yes/no): does it touch a local feature the fork carries?
- `cost` (score 0–3): integration cost and conflict risk against the local diff.

Jev leans towards adopt and calls most PRs needed, so `verdictOf` in `fit.ts` turns its answers into the mark:

- **skip** when Jev gives skip at least 40% or `needed` is under 0.45;
- **adopt** only with adopt at least 60%, `needed` at least 0.85, no `overlap` (under 0.5: a PR in the area of a local
  feature needs a closer look first) and `cost` under 2.5;
- **watch** otherwise.

The confidence shown is Jev's probability for that verdict. The reason line comes from `needed`, `overlap` and `cost`
(`cost` is an expected level, 0–3, rounded).

Jev's answers, not the verdicts, are kept in `pr-fit.json` in the instance home, keyed by PR number, head commit, and a
hash of the profile and questions: a PR is asked again only when it gets new commits or you change the profile or the
questions. Changing the thresholds in `verdictOf` asks nothing again. At most one round runs every
five minutes, started when the PRs surface asks for the verdicts. Closed PRs drop out.

## What leaves the machine

To TypeSafe (https://api.typesafe.ai): `profile.md`, and of each PR its title, author, labels, description (first 6,000
characters), changed file paths (first 60) and CI state. No diffs, comments or code. Your own PRs are never sent.

## Tuning it

Edit `profile.md` in this folder: describe the setup the PRs are judged against. Saving it changes the basis, so every
open PR is judged again on the next round. Change the questions in `fit.ts` the same way.

Without a TypeSafe key, or while `classify` is paused, the action returns nothing and the PRs list shows no marks.

## Wiring

`pull-requests` (a personal extension in `~/.ultimate/extensions`) declares the point `pull-requests.mark` in its
`ui.tsx`. A project extension cannot import a user extension's file (they live in different folders and the import
rules only allow contract imports within one tree), so `web.tsx` declares the same point by name; points match by
their string. Server-side it reads the PRs with `gh` directly and wants `ClassifyApi`.
