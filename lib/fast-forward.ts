/**
 * Fetching origin and fast-forwarding a checkout's default branch to it, never stashing, rebasing or resetting: a
 * project's move updates its checkout with it, and the updater the Ultimate clone.
 */

/** Runs git in the checkout: resolves stdout, rejects with an Error naming the command and its output. */
export type Git = (...args: string[]) => Promise<string>

/**
 * The same GitHub repository over the other transport: SSH (`git@github.com:o/r.git`, `ssh://git://github.com/o/r`,
 * an SSH host alias such as `git@github.com-me:o/r.git` from `~/.ssh/config`) becomes `https://github.com/o/r.git` and
 * HTTPS becomes `git@github.com:o/r.git`; undefined for any other remote.
 */
export function otherTransport(url: string): string | undefined {
  const ssh =
    /^(?:ssh:\/\/)?git@github\.com(?:-[\w-]+)?[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i.exec(
      url.trim(),
    )
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}.git`
  const https = /^https:\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/i.exec(
    url.trim(),
  )
  if (https) return `git@github.com:${https[1]}/${https[2]}.git`
  return undefined
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Fetch origin; when that fails and origin is on GitHub, fetch once over the other transport into origin's refs,
 * without touching the remote's configuration (a machine may have only an SSH key or only an HTTPS login). After a
 * fallback, a missing `origin/HEAD` is set from the other transport's HEAD. Both failures are named when both fail.
 */
export async function fetchOrigin(git: Git): Promise<void> {
  try {
    await git('fetch', '--quiet', 'origin')
    return
  } catch (error) {
    const alternative = otherTransport(await git('remote', 'get-url', 'origin').catch(() => ''))
    if (!alternative) throw error
    try {
      await git('fetch', '--quiet', alternative, '+refs/heads/*:refs/remotes/origin/*')
    } catch (second) {
      throw new Error(`${message(error)}\nRetry over ${alternative}: ${message(second)}`, {
        cause: second,
      })
    }
    const head = await git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD').catch(() => '')
    if (head) return
    // `git remote set-head origin --auto` would ask origin's failing transport, so ask the working one.
    const symref = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(
      await git('ls-remote', '--symref', alternative, 'HEAD').catch(() => ''),
    )
    if (symref)
      await git('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${symref[1]}`)
  }
}

/** Where the checkout stands against `origin/<default branch>`, from the last fetch; `refused` says why it can't move. */
export type Standing = {
  /** The default branch, e.g. `main`. */
  branch: string
  /** `origin/<branch>`. */
  remote: string
  ahead: number
  behind: number
  /** Why a fast-forward is refused: uncommitted changes, another branch, a diverged branch. */
  refused?: string
  /** The refusal is only that the branch has commits of its own besides origin's new ones: a merge would move it. */
  diverged?: true
}

/** The checkout against origin's default branch (no fetch); throws only when origin has no default branch. */
export async function standing(git: Git): Promise<Standing> {
  const remote = await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => {
    throw new Error('origin has no default branch; run git remote set-head origin --auto')
  })
  const branch = remote.replace(/^origin\//, '')
  const [ahead = 0, behind = 0] = (
    await git('rev-list', '--left-right', '--count', `HEAD...${remote}`)
  )
    .split(/\s+/)
    .map(Number)
  const result: Standing = { branch, remote, ahead, behind }
  const current = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  if (await git('status', '--porcelain', '--untracked-files=no'))
    result.refused = 'The checkout has uncommitted changes'
  else if (current !== branch)
    result.refused = `The checkout is on ${current || 'a detached HEAD'}, not ${branch}`
  else if (ahead && behind) {
    result.refused = `${branch} has diverged from ${remote}`
    result.diverged = true
  }
  return result
}

/** A fast-forward refused by the checkout's state, not by a failing command. */
export class Refusal extends Error {}

/** What a fast-forward did: the commits it moved, `before..after`, and whether `pnpm-lock.yaml` changed with it. */
export type FastForward = Standing & {
  before: string
  after: string
  lockfile: boolean
}

/**
 * Fetch origin and fast-forward the checkout's default branch to it; throws the refusal of `standing` as a
 * `Refusal`. `diverged`, when given, replaces that refusal for a branch with commits of its own besides
 * origin's new ones: it moves the branch itself (a merge that stops on conflicts) and returns what moved it.
 * `owe` runs before a fast-forward that changes `pnpm-lock.yaml`, so an install owed is recorded before the
 * lockfile changes. `admit`, checked after the fetch and before the merge, refuses with the reason it returns.
 */
export async function fastForward(
  git: Git,
  owe?: () => Promise<void>,
  admit?: () => Promise<string | undefined>,
  diverged?: (state: Standing) => Promise<FastForward>,
): Promise<FastForward> {
  // Checked before fetching, so a dirty checkout is refused as such and its remote refs stay as they were.
  if (await git('status', '--porcelain', '--untracked-files=no'))
    throw new Refusal('The checkout has uncommitted changes')
  await fetchOrigin(git)
  const state = await standing(git)
  if (state.refused) {
    if (state.diverged && diverged) return await diverged(state)
    throw new Refusal(state.refused)
  }
  const refused = state.behind ? await admit?.() : undefined
  if (refused) throw new Refusal(refused)
  const before = await git('rev-parse', 'HEAD')
  const lockfile =
    !!state.behind &&
    !!(await git('diff', '--name-only', 'HEAD', state.remote, '--', 'pnpm-lock.yaml'))
  if (lockfile) await owe?.()
  if (state.behind) await git('merge', '--ff-only', '--quiet', state.remote)
  return { ...state, before, after: await git('rev-parse', 'HEAD'), lockfile }
}

/**
 * The current branch against its own upstream (`@{upstream}`): `branch` is the branch, `remote` its tracking ref
 * (e.g. `origin/main`). `refused` adds a detached HEAD, a branch without an upstream, uncommitted changes or a
 * diverged branch (with `diverged: true`, as `standing` does).
 */
export async function standingUpstream(git: Git): Promise<Standing> {
  const branch = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  const result: Standing = { branch: branch || 'HEAD', remote: '', ahead: 0, behind: 0 }
  if (!branch) {
    result.refused = 'The checkout is on a detached HEAD'
    return result
  }
  const upstream = await git(
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    `${branch}@{upstream}`,
  ).catch(() => '')
  if (!upstream) {
    result.refused = `${branch} has no upstream; set one with git branch --set-upstream-to`
    return result
  }
  const [ahead = 0, behind = 0] = (
    await git('rev-list', '--left-right', '--count', `${branch}...${upstream}`)
  )
    .split(/\s+/)
    .map(Number)
  Object.assign(result, { remote: upstream, ahead, behind })
  if (await git('status', '--porcelain', '--untracked-files=no'))
    result.refused = 'The checkout has uncommitted changes'
  else if (ahead && behind) {
    result.refused = `${branch} has diverged from ${upstream}`
    result.diverged = true
  }
  return result
}

/**
 * Fetch the current branch's upstream's remote and fast-forward the branch to it; throws `Refusal` for the states
 * `standingUpstream` refuses, handing a diverged branch to `diverged` instead (a merge that stops on conflicts,
 * such as `lib/merge.ts`'s `mergeUpstream`). `admit`, checked after the fetch and before the move, refuses with the
 * reason it returns. The result's `lockfile` says the move changed `pnpm-lock.yaml`; what an install owes is the
 * caller's to decide.
 */
export async function fastForwardUpstream(
  git: Git,
  admit?: () => Promise<string | undefined>,
  diverged?: (state: Standing) => Promise<FastForward>,
): Promise<FastForward> {
  // Checked before fetching, so a dirty checkout is refused as such and its remote refs stay as they were.
  if (await git('status', '--porcelain', '--untracked-files=no'))
    throw new Refusal('The checkout has uncommitted changes')
  const branch = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => {
    throw new Refusal('The checkout is on a detached HEAD')
  })
  const upstream = await git(
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    `${branch}@{upstream}`,
  ).catch(() => {
    throw new Refusal(`${branch} has no upstream; set one with git branch --set-upstream-to`)
  })
  await git('fetch', '--quiet', upstream.split('/')[0])
  const state = await standingUpstream(git)
  if (state.refused) {
    if (state.diverged && diverged) return await diverged(state)
    throw new Refusal(state.refused)
  }
  const refused = state.behind ? await admit?.() : undefined
  if (refused) throw new Refusal(refused)
  const before = await git('rev-parse', 'HEAD')
  const lockfile =
    !!state.behind &&
    !!(await git('diff', '--name-only', 'HEAD', state.remote, '--', 'pnpm-lock.yaml'))
  if (state.behind) await git('merge', '--ff-only', '--quiet', state.remote)
  return { ...state, before, after: await git('rev-parse', 'HEAD'), lockfile }
}
