# Sync

Shows where the project's checkout stands against its Git upstream, and pulls, pushes or opens a PR from the status line. On by default; `extensions.disable: ["sync"]` turns it off. Where the project is not a Git repository, or on a preview, it shows nothing.

## Checking

The item follows the source checkout's current branch against its own upstream (`@{upstream}`, not `origin/HEAD`). Every running Ultimate compares them every 5 minutes, and 30 s after start, from local refs only: branch, upstream, ahead and behind (`standingUpstream` in `lib/fast-forward.ts`), uncommitted tracked files, and, for a diverged branch, what `git merge-tree` predicts. The upstream's remote is fetched only when `.git/FETCH_HEAD` is older than an hour, so several Ultimates on one repository fetch once between them (under the repository's shared clone lock from `lib/clone.ts`, the core's SQLite lock, which the update extension holds too). Git never prompts. Previews never fetch or move the checkout.

## Status line

Quiet and muted while in sync (`✓ in sync`, just the ✓ on a phone) or when the branch has no upstream (`· no upstream`; the popover says how to set one, there is no button for it). `↓N` when behind, `↑N` when ahead, `↑N ↓M` when diverged: brand colour, amber with a warning icon when Pull would be refused or the last fetch failed. The popover shows the counts, the newest commits the branch lacks, the refusals with what to do, when the remote was last fetched, and the actions.

- **Check now** fetches at once, bypassing the hourly gate.
- **Pull** (while behind) fast-forwards. A diverged branch merges: a restore ref first (`refs/ultimate-update/pre-…`, `git reset --hard <ref>` undoes it), the merge predicted with `git merge-tree`, aborted back on a conflict. It refuses uncommitted tracked files and never stashes, rebases or resets. Its writes run through `WorkspacesApi.serialize`, the queue the lander's fast-forwards hold, so a pull never races a landing. A predicted conflict refuses untouched, and the button becomes **Sync with @ultimate**: it asks the root @ultimate conversation to merge on a coordinator branch (once per range).
- **Push** (while ahead) is a plain `git push`: never forced. It refuses a dirty tree, a behind or diverged branch, a missing upstream and a protected branch, and then points at Open PR.
- **Open PR** pushes the branch to origin under its own name and runs `gh pr create --repo <owner/repo> --base <base> --head <branch> --title <latest commit subject>`. The base is origin's default branch. A push that fails is refused with that: PRs are same-repository only, there is no fork flow. `gh` errors show in the popover.

Pull, Push, Open PR and Sync with @ultimate are the user's alone (`userActions`).

## Protected branches

A branch is protected when it is listed in the project's settings:

```json
{ "sync": { "protected": ["main"] } }
```

or is origin's default branch, or is the lander's target while `lander.push` is set (the lander pushes it itself). A protected branch is never pushed by hand.
