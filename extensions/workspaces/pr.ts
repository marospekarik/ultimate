import { exec } from '../../lib/exec.ts'
import { git } from '../../lib/git.ts'
import { projectKey } from '../../lib/project-identity.ts'

export type Gh = (
  cwd: string,
  remote: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<string>

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED'

export const realGh: Gh = async (cwd, remote, args, signal) => {
  const command = `gh ${args.join(' ')}`
  const full = [...args]
  if (args[0] === 'pr') {
    const repo = projectKey(await git(cwd, 'remote', 'get-url', remote))
    if (!repo)
      throw new Error(`Cannot run \`${command}\`: git remote ${remote} is not a GitHub repository`)
    full.push('--repo', repo)
  }
  try {
    const { stdout } = await exec('gh', full, {
      cwd,
      signal,
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout.trim()
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { stderr?: string }
    if (failed.code === 'ENOENT')
      throw new Error('gh is not installed: install the GitHub CLI, then run `gh auth login`', {
        cause: error,
      })
    throw new Error(`\`${command}\` failed in ${cwd}: ${failed.stderr?.trim() || failed.message}`, {
      cause: error,
    })
  }
}

export function decidePolls(
  entries: readonly { id: string }[],
  states: Readonly<Record<string, PrState | undefined>>,
) {
  const result = { merged: [] as string[], closed: [] as string[], waiting: [] as string[] }
  for (const { id } of entries) {
    const state = states[id]
    if (state === 'MERGED') result.merged.push(id)
    else if (state === 'CLOSED') result.closed.push(id)
    else result.waiting.push(id)
  }
  return result
}

export function parsePr(value: unknown): { remote: string; base: string } | undefined {
  if (value === undefined) return undefined
  const { remote, base } = (value && typeof value === 'object' ? value : {}) as Record<
    string,
    unknown
  >
  if (typeof remote !== 'string' || !remote || typeof base !== 'string' || !base)
    throw new Error('lander.pr must be { "remote": <remote name>, "base": <branch name> }')
  return { remote, base }
}
