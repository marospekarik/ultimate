import { exec } from '../../lib/exec.ts'
import { fastForwardUpstream, Refusal, standingUpstream } from '../../lib/fast-forward.ts'
import type { Git } from '../../lib/fast-forward.ts'
import { cloneLock, FETCH_EVERY, fetchedAt, gitPath, withLock } from '../../lib/clone.ts'
import { conflictsPredicted, mergeUpstream } from '../../lib/merge.ts'
import { quoteMentions } from '../../lib/mentions.ts'
import { githubRepo } from '../../lib/project-identity.ts'
import type { PrResult, PullResult, PushResult, SyncState } from './refs.ts'

export type Run = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string }>

export type Context = {
  protectedBranches: string[]
  defaultBranch?: string
}

async function upstreamOf(git: Git, branch: string) {
  const remote = await git('config', `branch.${branch}.remote`).catch(() => '')
  const merge = await git('config', `branch.${branch}.merge`).catch(() => '')
  return remote && merge ? { remote, branch: merge.replace(/^refs\/heads\//, '') } : undefined
}

export async function fetchIfDue(git: Git, root: string, now: number, force = false) {
  const branch = await git('symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  const upstream = branch ? await upstreamOf(git, branch) : undefined
  if (!upstream) return undefined
  const lock = await gitPath(git, root, cloneLock)
  return withLock(lock, async () => {
    const last = await fetchedAt(git, root)
    if (!force && last !== undefined && now - last < FETCH_EVERY) return undefined
    return git('fetch', '--quiet', upstream.remote).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
  })
}

export async function stateOf(git: Git, root: string, context: Context): Promise<SyncState> {
  const standing = await standingUpstream(git)
  const dirty = Boolean(await git('status', '--porcelain', '--untracked-files=no'))
  const branch =
    standing.branch === 'HEAD' && standing.refused?.includes('detached') ? '' : standing.branch
  const state: SyncState = {
    root,
    ...(branch ? { branch } : {}),
    ahead: standing.ahead,
    behind: standing.behind,
    dirty,
    commits: [],
    protected: branch !== '' && context.protectedBranches.includes(branch),
  }
  const at = await fetchedAt(git, root)
  if (at !== undefined) state.fetchedAt = at
  const repo = await githubRepo(root)
  if (repo) state.repo = repo.replace(/^github\.com\//, '')
  const base = branch && context.defaultBranch !== branch ? context.defaultBranch : undefined
  if (base) state.base = base
  if (!branch || !standing.remote) {
    return { ...state, ...(standing.refused ? { pullRefused: standing.refused } : {}) }
  }
  state.upstream = standing.remote
  if (standing.behind) {
    const log = await git('log', '-5', '--format=%h%x09%s', `${branch}..${standing.remote}`)
    state.commits = log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ...subject] = line.split('\t')
        return { sha, subject: subject.join('\t') }
      })
  }
  if (standing.diverged) {
    state.diverged = true
    const predicted = await conflictsPredicted(root, standing.remote)
    if (predicted !== undefined) state.conflicts = predicted
  }
  if (standing.behind) {
    if (dirty)
      state.pullRefused = 'The checkout has uncommitted changes: commit or discard them, then pull'
    else if (state.conflicts) {
      state.pullRefused = `Merging ${standing.remote} into ${branch} would conflict`
      state.merge = true
    }
  }
  if (standing.ahead) {
    const refused = pushRefusal(state)
    if (refused) state.pushRefused = refused
  }
  return state
}

export function pushRefusal(state: SyncState): string | undefined {
  if (!state.branch) return 'The checkout is on a detached HEAD: check out a branch, then push'
  if (!state.upstream)
    return `${state.branch} has no upstream: set one with git branch --set-upstream-to`
  if (state.protected)
    return `${state.branch} is protected: push a branch of its own and open a PR instead`
  if (state.dirty) return 'The checkout has uncommitted changes: commit or discard them, then push'
  if (state.behind && state.ahead)
    return `${state.branch} has diverged from ${state.upstream}: pull first`
  if (state.behind) return `${state.branch} is behind ${state.upstream}: pull first`
  if (!state.ahead) return `${state.branch} has nothing to push`
  return undefined
}

export async function pull(
  git: Git,
  root: string,
  serialize: <T>(operation: () => Promise<T>) => Promise<T>,
): Promise<PullResult> {
  try {
    const moved = await serialize(() =>
      fastForwardUpstream(git, undefined, async (standing) =>
        mergeUpstream(git, await conflictsPredicted(root, standing.remote), standing),
      ),
    )
    return {
      ok: true,
      from: moved.before.slice(0, 7),
      to: moved.after.slice(0, 7),
      commits: moved.behind,
      ...('restore' in moved ? { merged: true as const, restore: moved.restore as string } : {}),
    }
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, refused: error.message }
    throw error
  }
}

export async function push(git: Git, root: string, context: Context): Promise<PushResult> {
  const state = await stateOf(git, root, context)
  const refused = pushRefusal(state)
  if (refused) return { ok: false, refused }
  const upstream = (await upstreamOf(git, state.branch!))!
  try {
    await git('push', upstream.remote, `HEAD:refs/heads/${upstream.branch}`)
  } catch (error) {
    return {
      ok: false,
      refused: `${(error as Error).message}. Nothing was forced; pull, then push again`,
    }
  }
  return { ok: true, pushed: `${upstream.remote}/${upstream.branch}` }
}

export async function openPr(
  git: Git,
  root: string,
  context: Context,
  run: Run = exec,
): Promise<PrResult> {
  const state = await stateOf(git, root, context)
  if (!state.branch)
    return { ok: false, refused: 'The checkout is on a detached HEAD: check out a branch first' }
  if (!state.repo)
    return { ok: false, refused: 'origin is not a GitHub repository: open the PR by hand' }
  if (!state.base)
    return {
      ok: false,
      refused: 'origin has no default branch: run git remote set-head origin --auto',
    }
  if (state.base === state.branch)
    return {
      ok: false,
      refused: `${state.branch} is the PR's base: switch to a branch of its own, then open the PR`,
    }
  if (state.protected)
    return {
      ok: false,
      refused: `${state.branch} is protected: open the PR from a branch of its own`,
    }
  if (state.dirty)
    return {
      ok: false,
      refused: 'The checkout has uncommitted changes: commit or discard them, then open the PR',
    }
  const remote = (await upstreamOf(git, state.branch))?.remote ?? 'origin'
  try {
    await git('push', remote, `HEAD:refs/heads/${state.branch}`)
  } catch (error) {
    return {
      ok: false,
      refused: `Could not push ${state.branch} to ${remote}, so no PR was opened (${(error as Error).message}). Open PRs need push access to ${state.repo}; forks are not supported`,
    }
  }
  const title = quoteMentions(await git('log', '-1', '--format=%s'))
  try {
    const result = await run(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        state.repo,
        '--base',
        state.base,
        '--head',
        state.branch,
        '--title',
        title,
        '--body',
        '',
      ],
      { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 120_000 },
    )
    return { ok: true, url: result.stdout.trim().split('\n').at(-1) ?? '' }
  } catch (error) {
    const { stderr = '' } = error as { stderr?: string }
    return { ok: false, refused: `gh pr create failed: ${stderr.trim() || String(error)}` }
  }
}
