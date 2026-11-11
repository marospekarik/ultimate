/**
 * Git in a repository shared by every extension that fetches it (the updater, git sync): the prompting-free runner,
 * the repository-wide lock and the `FETCH_HEAD` fetch gate.
 */
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { exec } from './exec.ts'
import type { Git } from './fast-forward.ts'
// oxlint-disable-next-line no-restricted-imports -- the core's process-safe lock, shared with secrets and tailscale
import { acquireLock } from '../server/lock.ts'

/** Git in `root`, never prompting: an HTTPS fetch or push without a login must fail rather than hang. */
export const gitIn =
  (root: string): Git =>
  async (...args) => {
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      return (await exec('git', args, { cwd: root, env, timeout: 120_000 })).stdout.trim()
    } catch (error) {
      const { stderr = '' } = error as { stderr?: string }
      throw new Error(`git ${args[0]} failed: ${stderr.trim() || String(error)}`, { cause: error })
    }
  }

/** A repository is fetched when its last fetch, by any Ultimate on it, is older than this. */
export const FETCH_EVERY = 60 * 60_000

/** The lock file every fetch, merge or install of one repository holds, so Ultimates sharing it take turns. */
export const cloneLock = 'ultimate-git.lock'

/** `name` inside the repository's git directory, shared by every Ultimate on it. */
export async function gitPath(git: Git, root: string, name: string) {
  const path = await git('rev-parse', '--git-path', name)
  return isAbsolute(path) ? path : join(root, path)
}

/** When the repository was last fetched (`FETCH_HEAD`'s mtime), or undefined before the first fetch. */
export async function fetchedAt(git: Git, root: string) {
  return stat(await gitPath(git, root, 'FETCH_HEAD')).then(
    (info) => info.mtimeMs,
    () => undefined,
  )
}

/**
 * Run `work` holding `lock`, so fetches, merges and installs of one repository never overlap across Ultimates or
 * extensions sharing it; undefined without running while another still holds it after `waitMs`. The lock is the
 * core's SQLite-held one (`server/lock.ts`): the exclusive transaction ends with its process, so a dead holder never
 * blocks the next.
 */
export async function withLock<T>(
  lock: string,
  work: () => Promise<T>,
  waitMs = 0,
): Promise<T | undefined> {
  let held: Awaited<ReturnType<typeof acquireLock>>
  try {
    held = await acquireLock(lock, { pid: process.pid }, waitMs)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Ultimate core already owns'))
      return undefined
    throw error
  }
  try {
    return await work()
  } finally {
    await held.close()
  }
}
