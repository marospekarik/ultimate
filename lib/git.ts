import { readdir, realpath } from 'node:fs/promises'
import { exec } from './exec.ts'
import { meansNone } from './errors.ts'

export type GitOptions = {
  cwd: string
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

const COMMAND_SCOPE_PROGRAM_RUNNING_CONFIG_OFF = [
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
  '-c',
  'log.showSignature=false',
]

const GLOBAL_PROGRAM_RUNNING_KEY =
  /^(core\.sshCommand|credential\.helper|credential\..*\.helper|filter\..*\.(smudge|clean|process)|merge\..*\.driver)$/i

const singleQuotedProgramPath = (path: string) => `'${path.replaceAll("'", "'\\''")}'`
const gitDefaultSsh = () =>
  process.env.GIT_SSH ? singleQuotedProgramPath(process.env.GIT_SSH) : 'ssh'

type GlobalProgramConfig = { args: string[]; keys: Set<string> }
let globalProgramConfig: Promise<GlobalProgramConfig> | undefined
let globalProgramConfigFile: string | undefined

function configPairs(nullSeparatedList: string) {
  return nullSeparatedList.split('\0').flatMap((pair) => {
    const newline = pair.indexOf('\n')
    return newline > 0 ? [{ name: pair.slice(0, newline), value: pair.slice(newline + 1) }] : []
  })
}

async function reappliedGlobalProgramConfig(): Promise<GlobalProgramConfig> {
  const file = process.env.GIT_CONFIG_GLOBAL ?? ''
  if (globalProgramConfig && globalProgramConfigFile === file) return globalProgramConfig
  globalProgramConfigFile = file
  globalProgramConfig = (async () => {
    const resetCredentialHelperList = ['-c', 'credential.helper=']
    const args = [...resetCredentialHelperList]
    const keys = new Set<string>()
    const result = await exec('git', ['config', '--global', '--null', '--list']).catch(meansNone)
    for (const { name, value } of configPairs(result?.stdout ?? '')) {
      if (!GLOBAL_PROGRAM_RUNNING_KEY.test(name)) continue
      args.push('-c', `${name}=${value}`)
      keys.add(name)
    }
    if (!keys.has('core.sshcommand')) args.push('-c', `core.sshcommand=${gitDefaultSsh()}`)
    return { args, keys }
  })()
  return globalProgramConfig
}

const ATTRIBUTE_DRIVER_KEY = /^(filter\..*\.(smudge|clean|process)|merge\..*\.driver)$/i

async function emptiedRepositoryOnlyDrivers(
  cwd: string,
  global: ReadonlySet<string>,
): Promise<string[]> {
  const result = await exec('git', ['config', '--null', '--list'], { cwd }).catch(meansNone)
  return configPairs(result?.stdout ?? '').flatMap(({ name }) =>
    !global.has(name) && ATTRIBUTE_DRIVER_KEY.test(name) ? ['-c', `${name}=`] : [],
  )
}

export type RunGitOptions = Omit<GitOptions, 'cwd'>

export async function gitArgs(cwd: string, args: readonly string[]): Promise<string[]> {
  const global = await reappliedGlobalProgramConfig()
  return [
    ...COMMAND_SCOPE_PROGRAM_RUNNING_CONFIG_OFF,
    ...global.args,
    ...(await emptiedRepositoryOnlyDrivers(cwd, global.keys)),
    ...args,
  ]
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return exec('git', await gitArgs(cwd, args), {
    cwd,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    ...options,
  })
}

export async function git(cwd: string | GitOptions, ...args: string[]) {
  const options = typeof cwd === 'string' ? { cwd } : cwd
  const { stdout } = await runGit(options.cwd, args, options)
  return stdout.trim()
}

export const noRepository = 'Isolation needs a Git repository'
export const noCommit = 'Isolation needs a first commit'

export async function empty(cwd: string) {
  const repositoryRootOrNewRepositoryFolder = await git(cwd, 'rev-parse', '--show-toplevel').catch(
    () => cwd,
  )
  return (await readdir(repositoryRootOrNewRepositoryFolder)).every((name) => name === '.git')
}

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
  const previewLandingBranch = process.env.ULTIMATE_PREVIEW_BRANCH
  const project = process.env.ULTIMATE_PROJECT
  if (
    previewLandingBranch &&
    project &&
    source === (await realpath(await git(project, 'rev-parse', '--show-toplevel')))
  )
    return { source, target: previewLandingBranch }
  return { source, target }
}
