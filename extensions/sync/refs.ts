/** Sync in the browser: where the project checkout's branch stands against its upstream. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

export type SyncState = {
  /** The project's source checkout; absent outside a Git repository. */
  root?: string
  branch?: string
  /** The branch's own upstream (`@{upstream}`), e.g. `origin/main`; absent without one. */
  upstream?: string
  ahead: number
  behind: number
  /** Uncommitted changes to tracked files. */
  dirty: boolean
  /** Commits on both sides. */
  diverged?: true
  /** Whether merging the upstream into the diverged branch would conflict (`git merge-tree`); absent when git can't say. */
  conflicts?: boolean
  /** The newest commits the branch lacks (at most 5), newest first. */
  commits: { sha: string; subject: string }[]
  /** Why Pull would be refused; absent when it would run. */
  pullRefused?: string
  /** Why Push would be refused; absent when it would run. */
  pushRefused?: string
  /** The branch is protected: the lander's target or listed in `sync.protected`. Push is refused and Open PR is offered. */
  protected: boolean
  /** Pull is only refused by a predicted conflict: @ultimate can merge it on a branch. */
  merge?: true
  /** The PR's base: a branch the lander targets, else origin's default branch. */
  base?: string
  /** `owner/repo` of a GitHub origin; Open PR needs it. */
  repo?: string
  /** When the upstream's remote was last fetched (ms), by any Ultimate on this repository. */
  fetchedAt?: number
  /** Why the last fetch failed; the counts are from the fetch before. */
  error?: string
  /** A preview of another Ultimate: it never fetches or moves the checkout, and shows no item. */
  preview?: true
}

export type PullResult =
  | { ok: true; from: string; to: string; commits: number; merged?: true; restore?: string }
  | { ok: false; refused: string }
export type PushResult = { ok: true; pushed: string } | { ok: false; refused: string }
export type PrResult = { ok: true; url: string } | { ok: false; refused: string }

/** No arguments → the state from the last check (local refs only). */
export const StateAction = actionRef<null, SyncState>('sync', 'state')
/** No arguments → fetch the upstream's remote now (bypassing the hourly gate), then the refreshed state. */
export const CheckAction = actionRef<null, SyncState>('sync', 'check')
/** The user's: fast-forward, or merge a diverged branch (restore ref, conflicts predicted first). Never stashes, rebases or resets. */
export const PullAction = actionRef<null, PullResult>('sync', 'pull')
/** The user's: push the branch to its upstream. Never forces; refuses protected, dirty, behind and diverged. */
export const PushAction = actionRef<null, PushResult>('sync', 'push')
/** The user's: `gh pr create` for the branch against the base, pushing it first when needed. */
export const PrAction = actionRef<null, PrResult>('sync', 'pr')
/** The user's: ask @ultimate to merge the upstream into the branch on a coordinator branch; its conversation id. */
export const MergeAction = actionRef<null, { id: number }>('sync', 'merge')
