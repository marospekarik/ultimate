import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { runGit } from './git.ts'
import type { Git } from './fast-forward.ts'
import { acquireLock } from './lock.ts'
import { meansNone } from './errors.ts'

export const gitIn =
  (root: string): Git =>
  async (...args) => {
    try {
      const nonInteractiveGitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      return (
        await runGit(root, args, { env: nonInteractiveGitEnv, timeout: 120_000 })
      ).stdout.trim()
    } catch (error) {
      const { stderr = '' } = error as { stderr?: string }
      throw new Error(`git ${args[0]} failed: ${stderr.trim() || String(error)}`, { cause: error })
    }
  }

export const FETCH_EVERY = 60 * 60_000

export const cloneLock = 'ultimate-git.lock'

export async function gitPath(git: Git, root: string, name: string) {
  const path = await git('rev-parse', '--git-path', name)
  return isAbsolute(path) ? path : join(root, path)
}

export async function fetchedAt(git: Git, root: string) {
  return stat(await gitPath(git, root, 'FETCH_HEAD')).then((info) => info.mtimeMs, meansNone)
}

export async function withLock<T>(
  cloneWideLockFile: string,
  work: () => Promise<T>,
  waitMs = 0,
): Promise<T | undefined> {
  let heldCloneLock: Awaited<ReturnType<typeof acquireLock>>
  try {
    heldCloneLock = await acquireLock(cloneWideLockFile, { pid: process.pid }, waitMs)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Ultimate core already owns'))
      return undefined
    throw error
  }
  try {
    return await work()
  } finally {
    await heldCloneLock.close()
  }
}
