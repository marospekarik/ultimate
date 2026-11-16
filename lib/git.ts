import { readdir, realpath } from 'node:fs/promises'
import { exec } from './exec.ts'
import { meansNone } from './errors.ts'

/** Where and how long a git command runs; defaults: 30 seconds, 1 MiB of output. `timeout: 0` waits indefinitely. */
export type GitOptions = {
  cwd: string
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

/**
 * Program-running config the host's git must never honour, repo-local or not: these make git itself start a command
 * (fsmonitor on status and index refresh, hooks on commit/merge/checkout, a pager, an external diff, or gpg when a
 * commit is signed). `-c` is command scope, which beats every config file (git-config(1), SCOPES), so a worktree's
 * `.git/config` — or a gitdir a tampered `.git` pointer names — cannot make the host run a program.
 */
const NEUTRALISE = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.pager=',
  '-c',
  'diff.external=',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
]

/**
 * Program-running config whose value the user set in their global config and the host must keep: the lander's push to
 * `fork` over HTTPS uses the global `gh` credential helper, SSH uses `core.sshCommand`, and a git-lfs checkout uses
 * `filter.<name>.smudge`. Re-applying the global values at command scope keeps them, while a repo-local value of the
 * same key cannot run instead. Read once per process; `GIT_CONFIG_GLOBAL` keys the cache so a test can point it at a
 * temporary file.
 */
const GLOBAL_KEY =
  /^(core\.sshCommand|credential\.helper|credential\..*\.helper|filter\..*\.(smudge|clean|process)|merge\..*\.driver)$/i

type Trusted = { args: string[]; keys: Set<string> }
let trusted: Promise<Trusted> | undefined
let trustedEnv: string | undefined

async function trustedGlobal(): Promise<Trusted> {
  const key = process.env.GIT_CONFIG_GLOBAL ?? ''
  if (trusted && trustedEnv === key) return trusted
  trustedEnv = key
  trusted = (async () => {
    const args: string[] = []
    const keys = new Set<string>()
    const result = await exec('git', ['config', '--global', '--null', '--list']).catch(meansNone)
    // `--null --list` prints `key\nvalue\0` pairs; repeated keys keep their order (a `credential.<url>.helper=`
    // reset before the real helper, for example), and `-c` preserves that order. Git lowercases section and key
    // names, so the filter is case-insensitive.
    for (const pair of (result?.stdout ?? '').split('\0')) {
      const newline = pair.indexOf('\n')
      if (newline <= 0) continue
      const name = pair.slice(0, newline)
      if (!GLOBAL_KEY.test(name)) continue
      args.push('-c', `${name}=${pair.slice(newline + 1)}`)
      keys.add(name)
    }
    // Always override the unscoped keys too, so a repo-local sshCommand or helper cannot run when global sets none.
    // Git lowercases section and key names, so the canonical names are lowercase here.
    for (const name of ['core.sshcommand', 'credential.helper'])
      if (!keys.has(name)) args.push('-c', `${name}=`)
    return { args, keys }
  })()
  return trusted
}

/** Subcommands that materialise files and so can run a smudge/process filter or, for merge, a merge driver. */
const WRITES = new Set(['checkout', 'reset', 'merge', 'switch', 'restore'])
const writesFiles = (args: readonly string[]) =>
  WRITES.has(args[0] ?? '') || (args[0] === 'worktree' && args[1] === 'add')

const DRIVER_KEY = /^(filter\..*\.(smudge|clean|process)|merge\..*\.driver)$/i

/**
 * Repo-local filter and merge-driver commands the subcommand would run, forced empty. The global values for the same
 * keys are re-applied above, so git-lfs keeps working while a driver only the repository defines cannot run a program
 * (`.gitattributes` names the driver, but the command to run always comes from config).
 */
async function localDrivers(cwd: string, global: ReadonlySet<string>): Promise<string[]> {
  const result = await exec('git', ['config', '--null', '--list'], { cwd }).catch(meansNone)
  const args: string[] = []
  for (const pair of (result?.stdout ?? '').split('\0')) {
    const newline = pair.indexOf('\n')
    if (newline <= 0) continue
    const name = pair.slice(0, newline)
    if (!global.has(name) && DRIVER_KEY.test(name)) args.push('-c', `${name}=`)
  }
  return args
}

/** Options for `runGit` besides the working directory. */
export type RunGitOptions = {
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

/**
 * Run git in `cwd` with the host's neutralising config prepended; resolves `{ stdout, stderr }`, rejects with
 * execFile's error, stderr in its message. Every host-side git call should go through this or `git`.
 */
export async function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const global = await trustedGlobal()
  const prefix: string[] = [...NEUTRALISE, ...global.args]
  if (writesFiles(args)) prefix.push(...(await localDrivers(cwd, global.keys)))
  return exec('git', [...prefix, ...args], {
    cwd,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    ...options,
  })
}

/** Run git in `cwd` and return its trimmed stdout; a failure rejects with execFile's error, stderr in its message. */
export async function git(cwd: string | GitOptions, ...args: string[]) {
  const options = typeof cwd === 'string' ? { cwd } : cwd
  const { stdout } = await runGit(options.cwd, args, options)
  return stdout.trim()
}

export const noRepository = 'Isolation needs a Git repository'
export const noCommit = 'Isolation needs a first commit'

/** Whether the repository holding `cwd` (or `cwd` itself, outside Git) has nothing in it but `.git`. */
export async function empty(cwd: string) {
  const top = await git(cwd, 'rev-parse', '--show-toplevel').catch(
    // Outside Git the folder itself is what a new repository would hold.
    () => cwd,
  )
  return (await readdir(top)).every((name) => name === '.git')
}

/** The checkout and branch an isolate of `cwd` would branch from, or why there is none. */
export async function isolatable(
  cwd: string,
): Promise<{ source: string; target: string } | { reason: string }> {
  const top = await git(cwd, 'rev-parse', '--show-toplevel').catch(meansNone)
  if (!top) return { reason: noRepository }
  const source = await realpath(top)
  const target = await git(source, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  if (!target) return { reason: 'Isolation needs a checked-out branch' }
  if (!(await git(source, 'rev-parse', '--verify', '--quiet', 'HEAD').catch(() => '')))
    return { reason: noCommit }
  // A preview lands on its own branch, never on the branch of the checkout it previews.
  const preview = process.env.ULTIMATE_PREVIEW_BRANCH
  const project = process.env.ULTIMATE_PROJECT
  if (
    preview &&
    project &&
    source === (await realpath(await git(project, 'rev-parse', '--show-toplevel')))
  )
    return { source, target: preview }
  return { source, target }
}
