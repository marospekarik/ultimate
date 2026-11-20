import type {
  ConversationId,
  JsonObject,
  ConversationDocToken,
  TaskRuntime,
  Tx,
} from '@earendil-works/pi-durable'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { availableParallelism, loadavg, tmpdir } from 'node:os'
import { join, matchesGlob } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { copyJson } from '@earendil-works/chord/json'
import type { Context } from '@earendil-works/chord/context'
import { withAbortSignal } from '@earendil-works/chord/context'
import { defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { debounce, deadline } from '../../lib/timers.ts'
import { exec } from '../../lib/exec.ts'
import { git } from '../../lib/git.ts'
import { overshadowed, retriedLater, settled } from '../../lib/errors.ts'
import { needsRestart as restartNeeded } from '../../lib/layers.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { quoteMentions } from '../../lib/mentions.ts'
import { runGroup, sweepPidFiles } from '../../lib/process-group.ts'
import { landingWeight } from '../../lib/token-weight.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { CheckRan, SubmissionFailed, SubmissionLanded } from './api.ts'
import { decidePolls, parsePr, realGh } from './pr.ts'
import type { Gh, PrState } from './pr.ts'
import { setup } from '../../lib/worktree-setup.ts'
import { addCheckout, treePath } from './tree.ts'
import type { Landed, LanderEntry, LanderOutcome, QueueEntry, WorkspaceIndex } from './types.ts'
import { LanderLog } from './entries.ts'
import { LanderReportEntry } from './refs.ts'

const recentSubmitCardOutcomeLimit = 50
export async function landerPath(home: string, source: string, settings: JsonObject) {
  const configured = await treePath(settings, landerName(source))
  if (configured) return configured
  await mkdir(join(home, 'lander'), { recursive: true })
  return join(await realpath(join(home, 'lander')), landerHash(source))
}
const landerHash = (source: string) =>
  createHash('sha256').update(source).digest('hex').slice(0, 12)
const landerName = (source: string) => `ult-lander-${landerHash(source)}`
const checkoutCreationQueues = new Map<string, Promise<string>>()
export async function landerCheckout(
  home: string,
  source: string,
  settings: JsonObject,
  tip = 'HEAD',
) {
  const path = await landerPath(home, source, settings)
  const queued = settled(checkoutCreationQueues.get(path) ?? Promise.resolve()).then(async () => {
    const registered = (await git(source, 'worktree', 'list', '--porcelain'))
      .split('\n\n')
      .some((entry) => entry.split('\n').includes(`worktree ${path}`))
    if (!registered) {
      await rm(path, { recursive: true, force: true })
      await git(source, 'worktree', 'prune')
      await addCheckout(settings, source, path, landerName(source), ['--detach', tip])
    }
    return path
  })
  checkoutCreationQueues.set(path, queued)
  try {
    return await queued
  } finally {
    if (checkoutCreationQueues.get(path) === queued) checkoutCreationQueues.delete(path)
  }
}
export const log = (
  tx: Tx,
  id: ConversationId,
  entry: Pick<
    QueueEntry,
    'id' | 'conversationId' | 'tip' | 'target' | 'at' | 'divergence' | 'subject' | 'steps'
  >,
  data: Omit<LanderEntry, 'submission' | 'conversationId' | 'tip' | 'target' | 'at'>,
) => {
  const at = Date.now()
  if (data.step)
    entry.steps.push({
      step: data.step,
      at,
      ...(data.runs ? { runs: data.runs } : {}),
      ...(data.check ? { check: data.check } : {}),
    })
  return tx.appendEntry(LanderLog, id, {
    data: {
      submission: entry.id,
      conversationId: entry.conversationId,
      tip: entry.tip,
      target: entry.target,
      at,
      sourceEntry: entry.at,
      divergence: entry.divergence,
      ...(entry.subject && (data.step === 'queued' || data.step === 'started' || data.outcome)
        ? { subject: entry.subject }
        : {}),
      ...data,
    },
  })
}
const starterLine = (
  branch: ConversationId,
  sha: string,
  outcome: WorkspaceIndex['results'][string],
) =>
  [
    `#${branch}${outcome.subject?.title ? ` ${outcome.subject.title}` : ''} ${outcome.commits?.length ? `landed as ${sha.slice(0, 7)} on ${outcome.target}` : `had nothing new to land on ${outcome.target}`}`,
    ...(outcome.pushed ? [`pushed`] : []),
    ...(outcome.reason ? [outcome.reason] : []),
    ...(outcome.needsRestart ? ['needs restart'] : []),
    ...(outcome.flaky?.length ? [`flaky: ${outcome.flaky.join(', ')}`] : []),
    ...(outcome.slow?.length ? [`slow: ${outcome.slow.join(', ')}`] : []),
    ...(outcome.skipped?.length ? [`skipped: ${outcome.skipped.join(', ')}`] : []),
  ]
    .join(' · ')
    .replace(/\s*\n\s*/g, ' ')

type Host = Pick<
  ExtensionHost,
  | 'home'
  | 'ultimateRoot'
  | 'harness'
  | 'projectSettings'
  | 'userHome'
  | 'projectRoot'
  | 'doc'
  | 'metadata'
  | 'notice'
  | 'emit'
  | 'resource'
>
type Seconds = number
type PathGlob = string
type Check = { command: string; timeout?: Seconds; stall?: Seconds; skipWhenOnly?: PathGlob[] }
type ConcurrentCheckGroup = Check[]
type Settings = {
  checks: (Check | ConcurrentCheckGroup)[]
  push?: string
  pr?: { remote: string; base: string }
}
const pullRequestPollIntervalMs = 5 * 60 * 1000
const maxTargetMoveAttempts = 3
type CheckLimits = { stall: Seconds; total: Seconds }
const defaultCheckLimitsSeconds: CheckLimits = { stall: 2 * 60, total: 10 * 60 }
export const limitsFor = (check: Check, limits: CheckLimits): CheckLimits => {
  const total = check.timeout ?? limits.total
  const stall = Math.min(check.stall ?? limits.stall, total)
  return { stall, total }
}
const vitestFailureLine = /^\s*(FAIL|×|✗)\s/
const seconds = (value: number) => (value < 60 ? `${value} s` : `${+(value / 60).toFixed(1)} min`)
const slowShareOfLimit = 0.8
export const slowNote = (command: string, ms: number, limits: CheckLimits) =>
  ms > limits.total * 1000 * slowShareOfLimit
    ? `${command} · ${seconds(Math.round(ms / 1000))} of ${seconds(limits.total)} (${Math.round(ms / limits.total / 10)} %)`
    : undefined

export const checkPids = (home: string) => join(home, 'lander-checks')
export const sweepChecks = async (home: string) => {
  const isResumedProcessCheck = (name: string) => name.startsWith(`${process.pid}-`)
  await sweepPidFiles(checkPids(home), isResumedProcessCheck)
  const names = await readdir(checkTemp(home)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const name of names)
    if (!name.startsWith(`${process.pid}-`))
      await rm(join(checkTemp(home), name), { recursive: true, force: true })
}
export const checkTemp = (home: string) => join(tmpdir(), `ultimate-lander-${landerHash(home)}`)

export async function runLanderCheck(
  path: string,
  command: string,
  context: Context,
  pids: string,
  temp: string,
  limits: CheckLimits = defaultCheckLimitsSeconds,
): Promise<CheckRun> {
  const tmp = createTempBeforeWatchdog(temp)
  let output = ''
  let partial = ''
  const failed = new Set<string>()
  let stopped: string | undefined
  const watchdog = new AbortController()
  const signal = AbortSignal.any([
    watchdog.signal,
    ...(context.abortSignal ? [context.abortSignal] : []),
  ])
  const stop = (reason: string) => {
    if (signal.aborted) return
    stopped = reason
    watchdog.abort()
  }
  const stalled = () => stop(`Stalled: no output for ${seconds(limits.stall)}, stopped`)
  const stallDeadline = debounce(limits.stall * 1000, stalled)
  stallDeadline()
  const cancelTotal = deadline(limits.total * 1000, () =>
    stop(`Timed out after ${seconds(limits.total)}`),
  )
  const report = (reason: string, heading: string) => {
    const tests = [...failed].slice(-20)
    const failedFiles = [...failed]
      .filter((test) => test.startsWith('FAIL'))
      .map((test) => test.slice('FAIL'.length).replace(/\s+/g, ' ').trim())
    return {
      failure: [reason, ...(tests.length ? [heading, ...tests] : []), output].join('\n').trim(),
      cause: [reason, ...failedFiles.slice(0, 5)].join(': '),
    }
  }
  const onOutput = (text: string) => {
    output = (output + text).slice(-3000)
    const split = (partial + text).split('\n')
    partial = split.pop()!.slice(-1000)
    for (const line of split) {
      const plain = stripVTControlCharacters(line).trim()
      if (vitestFailureLine.test(plain)) failed.add(plain.slice(0, 300))
    }
    stallDeadline()
  }
  try {
    let exit: Awaited<ReturnType<typeof runGroup>>
    try {
      exit = await runGroup('/bin/bash', ['-c', command], {
        cwd: path,
        env: { ...process.env, TMPDIR: tmp },
        pidFile: join(pids, `${process.pid}-${randomUUID()}.pid`),
        signal,
        grace: 2000,
        onOutput,
      })
    } catch (error) {
      context.abortSignal?.throwIfAborted()
      return { failure: `${output}\n${String(error)}`.trim(), cause: String(error) }
    }
    context.abortSignal?.throwIfAborted()
    if (stopped) return { ...report(stopped, 'Failed tests so far:'), timedOut: true }
    if (exit.outOfMemory) return report(`Out of memory: exit ${exit.code}`, 'Failed tests so far:')
    if (exit.code !== 0) return report(`exit ${exit.code}`, 'Failed tests:')
    const last = lines(stripVTControlCharacters(output)).findLast((line) => line.trim())
    return { summary: last?.trim().slice(0, 200) }
  } finally {
    stallDeadline.cancel()
    cancelTotal()
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
      retriedLater,
    )
  }
}

type CheckRun =
  | { failure?: undefined; summary?: string; timedOut?: undefined }
  | { failure: string; cause: string; summary?: undefined; timedOut?: boolean }

function createTempBeforeWatchdog(temp: string) {
  mkdirSync(temp, { recursive: true })
  return mkdtempSync(join(temp, `${process.pid}-`))
}

const parseCheck = (value: unknown): Check | undefined => {
  if (typeof value === 'string') return { command: value }
  if (!value || typeof value !== 'object') return undefined
  const { command, timeout, stall, skipWhenOnly } = value as {
    command?: unknown
    timeout?: unknown
    stall?: unknown
    skipWhenOnly?: unknown
  }
  if (typeof command !== 'string') return undefined
  const fields = [timeout, stall]
  if (!fields.every((field) => field === undefined || (typeof field === 'number' && field > 0)))
    return undefined
  if (
    skipWhenOnly !== undefined &&
    !(Array.isArray(skipWhenOnly) && skipWhenOnly.every((glob) => typeof glob === 'string'))
  )
    return undefined
  return {
    command,
    ...(typeof timeout === 'number' ? { timeout } : {}),
    ...(typeof stall === 'number' ? { stall } : {}),
    ...(skipWhenOnly ? { skipWhenOnly } : {}),
  }
}
type LanderKeys = { checks?: unknown; push?: unknown; pr?: unknown }
export const landerSettings = async (
  host: Pick<Host, 'projectSettings' | 'userHome' | 'projectRoot'>,
): Promise<Settings> => {
  const userLanders = (await readSettings(userSettingsPath(host.userHome))).landers as
    | Record<string, LanderKeys>
    | undefined
  const userLander = userLanders?.[host.projectRoot]
  const projectLander = (await host.projectSettings()).lander as LanderKeys | undefined
  const lander = { ...projectLander, ...userLander }
  const entries = lander?.checks ?? []
  const checks = Array.isArray(entries)
    ? entries.map((entry) =>
        Array.isArray(entry)
          ? entry.length > 0
            ? entry.map(parseCheck)
            : [undefined]
          : parseCheck(entry),
      )
    : undefined
  if (!checks?.every((group) => (Array.isArray(group) ? group.every(Boolean) : group)))
    throw new Error(
      'lander.checks must be an array of checks or check groups; a check is a command or { "command", "timeout", "stall", "skipWhenOnly" } with timeout and stall in seconds and skipWhenOnly a list of path globs',
    )
  if (lander?.push !== undefined && typeof lander.push !== 'string')
    throw new Error('lander.push must be a remote name')
  const pr = parsePr(lander?.pr)
  if (pr && lander?.push)
    throw new Error(
      'lander.pr and lander.push cannot both be set: pr pushes the branch and opens a pull request, push moves the target',
    )
  const outsidePreview = !process.env.ULTIMATE_PREVIEW_BRANCH
  const pushOutsidePreview = lander?.push && outsidePreview ? lander.push : undefined
  const prOutsidePreview = pr && outsidePreview ? pr : undefined
  return {
    checks: checks as Settings['checks'],
    ...(pushOutsidePreview ? { push: pushOutsidePreview } : {}),
    ...(prOutsidePreview ? { pr: prOutsidePreview } : {}),
  }
}
export const contains = (cwd: string, ancestor: string, descendant: string) =>
  git(cwd, 'merge-base', '--is-ancestor', ancestor, descendant).then(
    () => true,
    () => false,
  )
const lines = (text: string) => text.split('\n').filter(Boolean)

type MachineLoad = { line: string; top: string }
export const describeLoad = (oneMinute: number, cores: number, ps: string): MachineLoad => ({
  line: `load ${oneMinute.toFixed(1)} on ${cores} cores`,
  top: [
    'Top CPU (pid %cpu command):',
    ...lines(ps)
      .map((line) => line.trim().replace(/\s+/g, ' '))
      .filter((line) => line.split(' ')[2] !== 'ps')
      .slice(0, 5)
      .map((line) => `  ${line.slice(0, 100)}`),
  ].join('\n'),
})
const machineLoad = async () =>
  describeLoad(
    loadavg()[0],
    availableParallelism(),
    (await exec('ps', ['-eo', 'pid,pcpu,args', '--sort=-pcpu', '--no-headers'])).stdout,
  )
const failure = (error: unknown) => {
  const output = error as Error & { stdout?: string; stderr?: string }
  return `${output.stdout ?? ''}${output.stderr ?? ''}${output.stdout || output.stderr ? '' : output.message}`
    .trim()
    .slice(-3000)
}
const remote = (cwd: string, signal: AbortSignal, ...args: string[]) =>
  git({ cwd, signal, timeout: 300000 }, ...args)

type Runtime = TaskRuntime<{ source: string }, State, null, object>
type CheckedIntegration = {
  base: string
  integrated: string
  flaky: string[]
  slow?: string[]
  skipped?: string[]
}
const landedOutcome = (landed: Landed): LanderOutcome => ({
  outcome: 'landed',
  sha: landed.sha,
  base: landed.base,
  commits: landed.commits,
  paths: landed.paths,
  flaky: landed.flaky,
  ...(landed.slow?.length ? { slow: landed.slow } : {}),
  ...(landed.skipped?.length ? { skipped: landed.skipped } : {}),
  ...(landed.weight ? { weight: landed.weight } : {}),
})
type CommittedDeliveryDecision = {
  phase: 'deliver'
  id: string
  conversationId: ConversationId
  headline: string
  outcome: WorkspaceIndex['results'][string]
  concluded: boolean
  starter?: ConversationId
}
type ConcludedBranchRelease = { phase: 'release'; conversationId: ConversationId }

type BranchReportHeldAsNote = ConversationId
type UnderwayReportPhase = {
  phase: 'report'
  id: string
  conversationId: BranchReportHeldAsNote
  text: string
  headline: string
  outcome: WorkspaceIndex['results'][string]
}

type State =
  | { phase: 'next' }
  | { phase: 'land'; id: string; attempt: number; pushRetried?: boolean }
  | { phase: 'poll' }
  | UnderwayReportPhase
  | CommittedDeliveryDecision
  | { phase: 'card-failed'; error: string }
  | ConcludedBranchRelease

export async function hasPendingLanderReport(tx: Tx, index: WorkspaceIndex, id: ConversationId) {
  for (const taskId of Object.values(index.landers)) {
    const state = (await tx.task(taskId))?.state
    if (!state || state.status === 'terminal') continue
    const checkpoint = state.checkpoint as State | undefined
    if (checkpoint?.phase === 'report' && checkpoint.conversationId === id) return true
  }
  return false
}

export async function activeLandingCards(tx: Tx, index: WorkspaceIndex) {
  const results: string[] = []
  for (const taskId of Object.values(index.landers)) {
    const task = await tx.task(taskId)
    const checkpoint = task?.state.checkpoint as State | undefined
    if (checkpoint?.phase === 'deliver' && checkpoint.concluded && checkpoint.starter !== undefined)
      results.push(checkpoint.id)
  }
  return results
}

export function createLander(
  host: Host,
  Workspaces: ConversationDocToken<WorkspaceIndex>,
  serializeSourceWrites: <T>(source: string, operation: () => Promise<T>) => Promise<T>,
  after: {
    starter: (id: ConversationId, context: Context) => Promise<ConversationId | undefined>
    working: (tx: Tx, id: ConversationId) => Promise<boolean>
    conclude: (tx: Tx, id: ConversationId) => Promise<void>
    reserveLanding: import('./api.ts').BranchesService['reserveLanding']
    retireLanding: import('./api.ts').BranchesService['retireLanding']
    submitLanding: import('./api.ts').BranchesService['submitLanding']
    release: (id: ConversationId, context: Context) => Promise<unknown>
  },
  limits: CheckLimits = defaultCheckLimitsSeconds,
) {
  async function resetTrackedIntegration(source: string, tip: string) {
    const path = await landerCheckout(host.home, source, await host.projectSettings(), tip)
    await git(path, 'reset', '--hard', '-q')
    await git(path, 'checkout', '-q', '--detach', '--force', tip)
    await git(path, 'clean', '-fdq')
    return path
  }

  function landingOutcomeCommitter(runtime: Runtime, context: Context, entry: QueueEntry) {
    const id = entry.id
    const commitLandingOutcome = (text: string, outcome: LanderOutcome, sha = outcome.sha) =>
      runtime.commit(async (tx) => {
        const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
        const steps = draft.queue.find((item) => item.id === id)!.steps
        draft.queue = draft.queue.filter((item) => item.id !== id)
        if (outcome.sha) draft.items[String(entry.conversationId)].landed = outcome.sha
        draft.results[id] = {
          ...outcome,
          at: entry.at,
          divergence: entry.divergence,
          target: entry.target,
          tip: entry.tip,
          lander: runtime.conversationId,
          steps,
          conversationId: entry.conversationId,
          ...(entry.subject ? { subject: entry.subject } : {}),
        }
        for (const old of Object.keys(draft.results).slice(0, -recentSubmitCardOutcomeLimit))
          delete draft.results[old]
        await log(tx, runtime.conversationId, entry, outcome)
        if (outcome.outcome === 'failed')
          await host.emit(tx, SubmissionFailed, {
            submission: id,
            conversationId: entry.conversationId,
            target: entry.target,
            reason: outcome.reason ?? '',
          })
        if (outcome.outcome === 'landed') {
          const subject = entry.subject ?? {}
          const commits = (outcome.commits ?? []).map((commit) => {
            const space = commit.indexOf(' ')
            return { sha: commit.slice(0, space), subject: commit.slice(space + 1) }
          })
          await host.emit(tx, SubmissionLanded, {
            submission: id,
            conversationId: entry.conversationId,
            at: entry.at,
            sha: outcome.sha!,
            base: outcome.base!,
            target: entry.target,
            lander: runtime.conversationId,
            divergence: entry.divergence,
            title: subject.title ?? (await tx.doc(host.metadata, entry.conversationId)).title ?? '',
            ...(subject.summary ? { summary: subject.summary } : {}),
            ...(subject.feature ? { feature: subject.feature } : {}),
            commits: commits.slice(0, 10),
            commitCount: commits.length,
            paths: (outcome.paths ?? []).slice(0, 8),
            ...(outcome.pushed ? { pushed: outcome.pushed } : {}),
            ...(outcome.needsRestart ? { needsRestart: true as const } : {}),
          })
        }
        return {
          status: 'running',
          checkpoint: {
            phase: 'report',
            id,
            conversationId: entry.conversationId,
            outcome: draft.results[id],
            headline: starterLine(entry.conversationId, sha ?? '', draft.results[id]),
            text: `[lander] Submission ${id} (#${entry.conversationId}, ${entry.tip.slice(0, 7)}) ${text}\nLog: lander conversation #${runtime.conversationId}.`,
          },
        }
      }, context)
    return commitLandingOutcome
  }

  const Lander = defineTask<{ source: string }, State, null>({
    name: 'workspaces.lander',
    version: 1,
    initial: () => ({ phase: 'next' }),
    phases: {
      next: (task, runtime, context) =>
        runtime.commit(async (tx) => {
          const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
          const own = index.queue.filter((item) => item.source === task.input.source)
          const entry = own.find((item) => item.state !== 'pr')
          if (!entry) {
            if (own.length) return { status: 'running', checkpoint: { phase: 'poll' } }
            delete index.landers[task.input.source]
            return { status: 'terminal', outcome: { status: 'completed', result: null } }
          }
          entry.state = 'landing'
          await log(tx, runtime.conversationId, entry, { step: 'started' })
          return { status: 'running', checkpoint: { phase: 'land', id: entry.id, attempt: 1 } }
        }, context),
      land: async (task, runtime, context) => {
        const { id, attempt, pushRetried } = task.state.checkpoint
        const { signal } = runtime
        const index = (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        const entry = index.queue.find((item) => item.id === id)!
        const recordedFirstFastForward = async () =>
          (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!.queue.find(
            (item) => item.id === id,
          )?.landed
        const step = (
          text: string,
          {
            runs,
            result,
            output,
            ran,
          }: {
            runs?: string
            result?: LanderEntry['check']
            output?: string
            ran?: { ms: number; timedOut?: boolean }
          } = {},
        ) =>
          runtime.commit(async (tx) => {
            const saved = (await tx.doc(Workspaces, ROOT_CONVERSATION_ID)).queue.find(
              (item) => item.id === id,
            )!
            saved.step = text
            await log(tx, runtime.conversationId, saved, {
              step: text,
              ...(runs ? { runs } : {}),
              ...(result ? { check: result } : {}),
              ...(output ? { output } : {}),
            })
            if (result && ran)
              await host.emit(tx, CheckRan, {
                submission: id,
                command: result.command,
                result: ran.timedOut ? 'timeout' : result.result,
                ms: Math.round(ran.ms),
              })
          }, context)
        const commitLandingOutcome = landingOutcomeCommitter(runtime, context, entry)
        const summary = (landed: Landed, sha: string, how = '') =>
          [
            landed.commits.length
              ? `landed${how} as ${sha.slice(0, 7)} on ${entry.target}.`
              : `had nothing new to land on ${entry.target}.`,
            ...(landed.commits.length ? [`Commits:\n${landed.commits.join('\n')}`] : []),
            ...landed.flaky.map((command) => `Flaky: ${command}`),
            ...(landed.slow ?? []).map((command) => `Slow: ${command}`),
            ...(landed.skipped ?? []).map((command) => `Skipped: ${command}`),
          ].join('\n')
        const fail = async (reason: string, output?: string, hint?: string, load?: string) => {
          const landed = await recordedFirstFastForward()
          const detail = [output ? `${reason}:\n${output}` : reason, ...(hint ? [hint] : [])].join(
            '\n',
          )
          const facts = {
            reason: landed ? `Push failed: ${reason}` : reason,
            ...(output ? { output } : {}),
            ...(hint ? { hint } : {}),
            ...(load ? { load } : {}),
          }
          if (!landed)
            return commitLandingOutcome(`was not landed: ${detail}`, {
              outcome: 'failed',
              ...facts,
            })
          const needsRestart = await clonedCoreChanged(landed)
          return commitLandingOutcome(
            `${summary(landed, landed.sha, ' locally')}\nPush failed: ${detail}${needsRestart ? '\nNeeds restart.' : ''}`,
            { ...landedOutcome(landed), ...facts, ...(needsRestart ? { needsRestart } : {}) },
          )
        }
        const retry = (retried = pushRetried) =>
          runtime.commit(
            () => ({
              status: 'running',
              checkpoint: {
                phase: 'land',
                id,
                attempt: attempt + 1,
                ...(retried ? { pushRetried: retried } : {}),
              },
            }),
            context,
          )
        const { source, target } = entry
        const clonedCoreChanged = async (landed: Landed) =>
          (await realpath(source)) === (await realpath(host.ultimateRoot)) &&
          restartNeeded(landed.paths)
        const checkContext = withAbortSignal(signal, context)
        const push = async (settings: Settings, checkedCommit: string) => {
          if (!settings.push) return { text: 'Not pushed.' }
          await step(`pushing to ${settings.push}`)
          try {
            await remote(
              source,
              signal,
              'push',
              '-q',
              settings.push,
              `${checkedCommit}:refs/heads/${target}`,
            )
            return {
              remote: `${settings.push}/${target}`,
              text: `Pushed to ${settings.push}/${target}.`,
            }
          } catch (error) {
            if (signal.aborted) throw error
            if (!pushRetried) return { retry: retry(true) }
            return { retry: fail(`${settings.push} rejected the push`, failure(error)) }
          }
        }
        const landedReport = async (settings: Settings, landed: Landed, sha: string) => {
          const pushed = await push(settings, sha)
          if (pushed.retry) return pushed.retry
          const needsRestart = await clonedCoreChanged(landed)
          return commitLandingOutcome(
            [summary(landed, sha), pushed.text, ...(needsRestart ? ['Needs restart.'] : [])].join(
              '\n',
            ),
            {
              ...landedOutcome(landed),
              ...(pushed.remote ? { pushed: pushed.remote } : {}),
              ...(needsRestart ? { needsRestart } : {}),
            },
            sha,
          )
        }
        const openPullRequest = async (pr: NonNullable<Settings['pr']>, sha: string) => {
          const gh = host.resource<Gh>('workspaces.gh', () => realGh)
          const branch = index.items[String(entry.conversationId)].branch
          if (pr.base !== entry.target)
            return fail(
              `lander.pr.base (${pr.base}) is not the branch this project lands into (${entry.target})`,
              undefined,
              `Set lander.pr.base to "${entry.target}" or retarget the project, then submit again.`,
            )
          try {
            await gh(source, pr.remote, ['auth', 'status'], signal)
          } catch (error) {
            if (signal.aborted) throw error
            return fail(
              'GitHub CLI is not usable',
              failure(error),
              'Install gh and run `gh auth login`, then submit again.',
            )
          }
          await step(`pushing ${branch} to ${pr.remote}`)
          try {
            await remote(source, signal, 'push', '-q', pr.remote, `${sha}:refs/heads/${branch}`)
          } catch (error) {
            if (signal.aborted) throw error
            const current = (
              await remote(source, signal, 'ls-remote', pr.remote, `refs/heads/${branch}`)
            ).split(/\s/)[0]
            if (!current) return fail(`${pr.remote} rejected the push of ${branch}`, failure(error))
            try {
              await remote(
                source,
                signal,
                'push',
                '-q',
                `--force-with-lease=refs/heads/${branch}:${current}`,
                pr.remote,
                `${sha}:refs/heads/${branch}`,
              )
            } catch (forced) {
              if (signal.aborted) throw forced
              return fail(`${pr.remote} rejected the push of ${branch}`, failure(forced))
            }
          }
          const find = async () => {
            const found = JSON.parse(
              await gh(
                source,
                pr.remote,
                ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url'],
                signal,
              ),
            ) as { number: number; url: string }[]
            return found[0]
          }
          let found = await runtime.memo<{ number: number; url: string }>(`pr:${id}`, context)
          if (!found) {
            let existing = await find()
            if (!existing) {
              const subject = entry.subject ?? {}
              const title = subject.title ?? `${branch} (${sha.slice(0, 7)})`
              await gh(
                source,
                pr.remote,
                [
                  'pr',
                  'create',
                  '--base',
                  pr.base,
                  '--head',
                  branch,
                  '--title',
                  quoteMentions(title),
                  '--body',
                  quoteMentions(
                    [subject.summary, `Diverged from the request: ${entry.divergence}`]
                      .filter(Boolean)
                      .join('\n\n'),
                  ),
                ],
                signal,
              )
              existing = await find()
              if (!existing)
                return fail(`Opened a pull request for ${branch}, but could not read it back`)
            }
            found = await runtime.memo(`pr:${id}`, existing, context)
          }
          const opened = { number: found.number, url: found.url, head: branch }
          await runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            for (const old of draft.queue.filter(
              (item) =>
                item.id !== id &&
                item.state === 'pr' &&
                item.conversationId === entry.conversationId,
            ))
              draft.queue.splice(draft.queue.indexOf(old), 1)
            const saved = draft.queue.find((item) => item.id === id)!
            saved.state = 'pr'
            saved.pr = opened
            delete saved.step
            await log(tx, runtime.conversationId, saved, { step: `opened PR #${opened.number}` })
            return { status: 'running', checkpoint: { phase: 'next' } }
          }, context)
        }
        try {
          const settings = await landerSettings(host)
          const landingFromEarlierTask = entry.landed
          if (
            landingFromEarlierTask &&
            attempt === 1 &&
            !pushRetried &&
            (await contains(source, landingFromEarlierTask.sha, `refs/heads/${target}`))
          )
            return await landedReport(settings, landingFromEarlierTask, landingFromEarlierTask.sha)
          let checkedIntegration = await runtime.memo<CheckedIntegration>(
            `prepared:${id}:${attempt}`,
            context,
          )
          if (!checkedIntegration) {
            let mergedBeforeChecks = await runtime.memo<{ base: string; sha: string }>(
              `merged:${id}:${attempt}`,
              context,
            )
            const path = await resetTrackedIntegration(
              source,
              mergedBeforeChecks?.sha ?? (await git(source, 'rev-parse', `refs/heads/${target}`)),
            )
            if (!mergedBeforeChecks) {
              await step('preparing')
              const localTargetTipBeforeIntegration = await git(path, 'rev-parse', 'HEAD')
              const mergeOrReportConflict = async (
                commit: string,
                message: string,
                reason: string,
                hint: string,
              ) => {
                try {
                  await git(path, 'merge', '--no-edit', '-m', message, commit)
                  return false
                } catch {
                  const conflicts = await git(path, 'diff', '--name-only', '--diff-filter=U')
                  await git(path, 'merge', '--abort').catch(overshadowed)
                  await fail(reason, conflicts, hint)
                  return true
                }
              }
              if (settings.push) {
                if (
                  await remote(path, signal, 'ls-remote', settings.push, `refs/heads/${target}`)
                ) {
                  await remote(path, signal, 'fetch', '-q', settings.push, target)
                  const fetched = await git(path, 'rev-parse', 'FETCH_HEAD')
                  if (!(await contains(path, fetched, 'HEAD'))) {
                    await step(`merging ${settings.push}/${target}`)
                    if (
                      await mergeOrReportConflict(
                        fetched,
                        `Merge ${settings.push}/${target}`,
                        `${settings.push}/${target} conflicts with local ${target}`,
                        `Reconcile ${settings.push}/${target} with local ${target}, then submit again.`,
                      )
                    )
                      return
                  }
                }
              }
              if (settings.pr) {
                const { remote: name, base: branch } = settings.pr
                if (await remote(path, signal, 'ls-remote', name, `refs/heads/${branch}`)) {
                  await step(`fetching ${name}/${branch}`)
                  await remote(path, signal, 'fetch', '-q', name, branch)
                  await git(path, 'checkout', '-q', '--detach', '--force', 'FETCH_HEAD')
                } else
                  await step(`${name}/${branch} does not exist yet, starting from local ${target}`)
              }
              await step('merging')
              if (
                await mergeOrReportConflict(
                  entry.tip,
                  `Merge ${entry.tip.slice(0, 7)} from #${entry.conversationId} into ${target}\n\nUltimate-Conversation: ${entry.conversationId}`,
                  `it conflicts with ${target} in`,
                  `Merge ${target} into your workspace, resolve, verify and submit again.`,
                )
              )
                return
              mergedBeforeChecks = await runtime.memo(
                `merged:${id}:${attempt}`,
                {
                  base: localTargetTipBeforeIntegration,
                  sha: await git(path, 'rev-parse', 'HEAD'),
                },
                context,
              )
            }
            const { base } = mergedBeforeChecks
            await step('setting up')
            await setup(source, path, await host.projectSettings(), signal)
            const flaky: string[] = []
            const slow: string[] = []
            const skipped: string[] = []
            const changed = lines(
              await git(path, 'diff', '--name-only', base, mergedBeforeChecks.sha),
            )
            const onlyMatches = (globs: PathGlob[]) =>
              changed.length > 0 &&
              changed.every((file) => globs.some((glob) => matchesGlob(file, glob)))
            for (const [position, group] of settings.checks.entries()) {
              const all = Array.isArray(group) ? group : [group]
              const members = all.filter((check) => !onlyMatches(check.skipWhenOnly ?? []))
              for (const check of all)
                if (!members.includes(check)) {
                  skipped.push(check.command)
                  await step(`skipped: ${check.command}`)
                }
              const commands = members.map((check) => check.command)
              const run = (command: string, member: number) =>
                runLanderCheck(
                  path,
                  command,
                  checkContext,
                  checkPids(host.home),
                  checkTemp(host.home),
                  limitsFor(members[member], limits),
                )
              const runCheckWithOneDurableRerun = async (
                command: string,
                member: number,
              ): Promise<{
                failure?: string
                load?: MachineLoad
                flaky?: string
                slow?: string
              }> => {
                const attemptMemoKey = `check:${id}:${attempt}:${Array.isArray(group) ? `${position}.${member}` : position}`
                const causeMemoKey = `${attemptMemoKey}:cause`
                const slowMemoKey = `${attemptMemoKey}:slow`
                const noteIfSlow = async (ms: number) => {
                  const note = slowNote(command, ms, limitsFor(members[member], limits))
                  if (note) await runtime.memo(slowMemoKey, note, context)
                }
                let memoizedFirstRun =
                  (await runtime.memo<'passed' | 'failed'>(attemptMemoKey, context)) ??
                  ((await runtime.memo<string>(causeMemoKey, context)) ? 'failed' : undefined)
                if (!memoizedFirstRun) {
                  await step(`checking: ${command}`, { runs: command })
                  const began = performance.now()
                  const ran = await run(command, member)
                  const ms = performance.now() - began
                  const unmemoizedResult = ran.failure === undefined ? 'passed' : 'failed'
                  const logAttemptBeforeMemo = step
                  await logAttemptBeforeMemo(`checked: ${command}`, {
                    result: {
                      command,
                      result: unmemoizedResult,
                      ...(ran.summary ? { summary: ran.summary } : {}),
                    },
                    output: ran.failure,
                    ran: { ms, timedOut: ran.timedOut },
                  })
                  if (ran.failure !== undefined)
                    await runtime.memo(causeMemoKey, ran.cause, context)
                  else await noteIfSlow(ms)
                  memoizedFirstRun = await runtime.memo(attemptMemoKey, unmemoizedResult, context)
                }
                const slowRun = async () => {
                  const note = await runtime.memo<string>(slowMemoKey, context)
                  return note ? { slow: note } : {}
                }
                if (memoizedFirstRun === 'passed') return slowRun()
                let rerun = await runtime.memo<{ failure?: string }>(
                  `${attemptMemoKey}:rerun`,
                  context,
                )
                if (!rerun) {
                  await step(`rerunning: ${command}`, { runs: command })
                  const began = performance.now()
                  const ran = await run(command, member)
                  const timing = { ms: performance.now() - began, timedOut: ran.timedOut }
                  if (ran.failure === undefined) await noteIfSlow(timing.ms)
                  if (ran.failure === undefined)
                    await step(`checked: ${command}`, {
                      result: {
                        command,
                        result: 'flaky',
                        ...(ran.summary ? { summary: ran.summary } : {}),
                      },
                      ran: timing,
                    })
                  else
                    await runtime.commit(async (tx) => {
                      await host.emit(tx, CheckRan, {
                        submission: id,
                        command,
                        result: ran.timedOut ? 'timeout' : 'failed',
                        ms: Math.round(timing.ms),
                      })
                    }, context)
                  rerun = await runtime.memo<{ failure?: string }>(
                    `${attemptMemoKey}:rerun`,
                    ran.failure === undefined ? {} : { failure: ran.failure },
                    context,
                  )
                }
                if (rerun.failure !== undefined)
                  return {
                    failure: rerun.failure,
                    load:
                      (await runtime.memo<MachineLoad>(`${attemptMemoKey}:load`, context)) ??
                      (await runtime.memo(`${attemptMemoKey}:load`, await machineLoad(), context)),
                  }
                const cause = await runtime.memo<string>(causeMemoKey, context)
                return {
                  flaky: cause ? `${command} · ${cause}` : command,
                  ...(await slowRun()),
                }
              }
              const settledCheckGroup = await Promise.allSettled(
                commands.map(runCheckWithOneDurableRerun),
              )
              const results = settledCheckGroup.map((outcome) => {
                if (outcome.status === 'rejected') throw outcome.reason
                return outcome.value
              })
              const failed = results.findIndex((result) => result.failure !== undefined)
              if (failed !== -1) {
                const { failure: output, load } = results[failed]
                return await fail(
                  `check failed twice: ${commands[failed]}`,
                  `${output}\n\n${load!.line}\n${load!.top}`,
                  'Fix it at its cause (a flaky test too: fix or delete it), verify and submit again.',
                  load!.line,
                )
              }
              flaky.push(...results.flatMap((result) => result.flaky ?? []))
              slow.push(...results.flatMap((result) => result.slow ?? []))
            }
            const checkedTreeChanged =
              (await git(path, 'rev-parse', 'HEAD')) !== mergedBeforeChecks.sha ||
              (await git(path, 'status', '--porcelain'))
            if (checkedTreeChanged)
              return await fail(
                'the integration checkout changed during checks',
                `${await git(path, 'log', '--oneline', '-3')}\n${await git(path, 'status', '--short')}`.trim(),
                'Submit again.',
              )
            checkedIntegration = await runtime.memo<CheckedIntegration>(
              `prepared:${id}:${attempt}`,
              {
                base,
                integrated: mergedBeforeChecks.sha,
                flaky,
                ...(slow.length ? { slow } : {}),
                ...(skipped.length ? { skipped } : {}),
              },
              context,
            )
          }
          const { base, integrated, flaky, slow, skipped } = checkedIntegration
          if (settings.pr) return await openPullRequest(settings.pr, integrated)
          await step('fast-forwarding')
          let refused: string | undefined
          const moved = await serializeSourceWrites(source, async () => {
            const current = await git(source, 'rev-parse', `refs/heads/${target}`)
            const replayAfterFastForward = current === integrated
            if (replayAfterFastForward) return false
            if (current !== base) return true
            try {
              const checkoutHoldingTargetBranch = (
                await git(source, 'worktree', 'list', '--porcelain')
              )
                .split('\n\n')
                .map((record) => record.split('\n'))
                .find((record) => record.includes(`branch refs/heads/${target}`))?.[0]
                .slice('worktree '.length)
              if (checkoutHoldingTargetBranch)
                await git(checkoutHoldingTargetBranch, 'merge', '-q', '--ff-only', integrated)
              else await git(source, 'update-ref', `refs/heads/${target}`, integrated, base)
            } catch (error) {
              refused = failure(error)
            }
            return false
          })
          if (refused)
            return fail(
              `the checkout of ${target} refused the fast-forward to ${integrated.slice(0, 7)}`,
              refused,
            )
          if (moved) {
            if (attempt < maxTargetMoveAttempts) return retry()
            return fail(`${target} kept moving during ${maxTargetMoveAttempts} attempts.`)
          }
          const weight = await landingWeight(source, base, integrated)
          const firstFastForwardCandidate: Landed = {
            sha: integrated,
            base,
            commits: lines(await git(source, 'log', '--oneline', `${base}..${integrated}`)),
            paths: lines(await git(source, 'diff', '--name-only', base, integrated)),
            flaky,
            ...(slow?.length ? { slow } : {}),
            ...(skipped?.length ? { skipped } : {}),
            ...(weight ? { weight } : {}),
          }
          let landed = firstFastForwardCandidate
          await runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            const saved = draft.queue.find((item) => item.id === id)!
            saved.landed ??= firstFastForwardCandidate
            landed = copyJson(saved.landed) as Landed
            draft.items[String(entry.conversationId)].landed = integrated
          }, context)
          return await landedReport(settings, landed, integrated)
        } catch (error) {
          if (signal.aborted) throw error
          return fail('it failed', failure(error))
        }
      },
      poll: async (task, runtime, context) => {
        const { source } = task.input
        const { signal } = runtime
        const gh = host.resource<Gh>('workspaces.gh', () => realGh)
        const index = (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!
        const open = index.queue.filter((item) => item.source === source && item.state === 'pr')
        if (
          open.length === 0 ||
          index.queue.some((item) => item.source === source && item.state !== 'pr')
        )
          return runtime.commit(
            () => ({ status: 'running', checkpoint: { phase: 'next' } }),
            context,
          )
        const states: Record<string, PrState | undefined> = {}
        const prRemote = (await landerSettings(host)).pr?.remote
        if (!prRemote)
          return runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            for (const item of draft.queue.filter(
              (entry) => entry.source === source && entry.state === 'pr',
            ))
              await log(tx, runtime.conversationId, item, {
                output: 'lander.pr is no longer set; its pull requests are not being polled',
              })
            host.notice('lander.pr is no longer set; open pull requests are not being polled')
            return {
              status: 'sleeping',
              until: runtime.now() + pullRequestPollIntervalMs,
              checkpoint: { phase: 'next' },
            }
          }, context)
        for (const item of open)
          try {
            const view = JSON.parse(
              await gh(
                source,
                prRemote,
                ['pr', 'view', String(item.pr!.number), '--json', 'state,url'],
                signal,
              ),
            ) as { state: PrState }
            states[item.id] = view.state
          } catch (error) {
            if (signal.aborted) throw error
            host.notice(`Polling PR #${item.pr!.number} failed: ${String(error)}`)
          }
        const decided = decidePolls(open, states)
        const ended = decided.merged[0] ?? decided.closed[0]
        if (ended === undefined)
          return runtime.sleepUntil(
            runtime.now() + pullRequestPollIntervalMs,
            { phase: 'next' },
            context,
          )
        const entry = open.find((item) => item.id === ended)!
        const commitLandingOutcome = landingOutcomeCommitter(runtime, context, entry)
        const pr = entry.pr!
        if (decided.closed[0] === ended)
          return commitLandingOutcome(
            `was not landed: PR #${pr.number} was closed without merging`,
            {
              outcome: 'failed',
              pr,
              reason: `PR #${pr.number} was closed without merging`,
              hint: 'Rework the branch and submit again to open a new pull request.',
            },
          )
        const settings = await landerSettings(host)
        const { remote: name, base: branch } = settings.pr!
        const target = entry.target
        try {
          await remote(
            source,
            signal,
            'fetch',
            '-q',
            name,
            `+refs/heads/${branch}:refs/remotes/${name}/${branch}`,
          )
        } catch (error) {
          if (signal.aborted) throw error
          host.notice(
            `Fetching ${name}/${branch} for merged PR #${pr.number} failed: ${String(error)}`,
          )
          return runtime.sleepUntil(
            runtime.now() + pullRequestPollIntervalMs,
            { phase: 'next' },
            context,
          )
        }
        const fetched = await git(source, 'rev-parse', `refs/remotes/${name}/${branch}`)
        const start = await runtime.memo<{ tip: string; base: string }>(
          `pr-merged:${entry.id}`,
          context,
        )
        const mergeAt =
          start ??
          (await runtime.memo(
            `pr-merged:${entry.id}`,
            {
              tip: fetched,
              base:
                (await git(source, 'merge-base', `refs/heads/${target}`, fetched).catch(
                  () => '',
                )) || (await git(source, 'rev-parse', `refs/heads/${target}`)),
            },
            context,
          ))
        let hint: string | undefined
        await serializeSourceWrites(source, async () => {
          const current = await git(source, 'rev-parse', `refs/heads/${target}`)
          if (current === mergeAt.tip) return
          if (!(await contains(source, current, mergeAt.tip))) {
            hint = `Local ${target} has diverged from ${name}/${branch}, so it was left alone: merge or rebase it yourself.`
            return
          }
          try {
            const worktree = (await git(source, 'worktree', 'list', '--porcelain'))
              .split('\n\n')
              .map((record) => record.split('\n'))
              .find((record) => record.includes(`branch refs/heads/${target}`))?.[0]
              .slice('worktree '.length)
            if (worktree) await git(worktree, 'merge', '-q', '--ff-only', mergeAt.tip)
            else await git(source, 'update-ref', `refs/heads/${target}`, mergeAt.tip, current)
          } catch (error) {
            hint = `Local ${target} could not be fast-forwarded to ${name}/${branch}: ${failure(error)}`
          }
        })
        const commits = lines(
          await git(source, 'log', '--oneline', `${mergeAt.base}..${mergeAt.tip}`),
        )
        const paths = lines(await git(source, 'diff', '--name-only', mergeAt.base, mergeAt.tip))
        const weight = await landingWeight(source, mergeAt.base, mergeAt.tip)
        const needsRestart =
          (await realpath(source)) === (await realpath(host.ultimateRoot)) && restartNeeded(paths)
        return commitLandingOutcome(
          [
            `was merged as PR #${pr.number} (${mergeAt.tip.slice(0, 7)} on ${name}/${branch}).`,
            ...(commits.length ? [`Commits:\n${commits.join('\n')}`] : []),
            ...(hint ? [hint] : []),
            ...(needsRestart ? ['Needs restart.'] : []),
          ].join('\n'),
          {
            outcome: 'landed',
            sha: mergeAt.tip,
            base: mergeAt.base,
            commits,
            paths,
            flaky: [],
            ...(weight ? { weight } : {}),
            pr,
            ...(hint ? { hint } : {}),
            ...(needsRestart ? { needsRestart } : {}),
          },
        )
      },
      report: async (task, runtime, context) => {
        const { id, conversationId, text, headline, outcome } = task.state.checkpoint
        const branch = conversationId
        const entry = { kind: LanderReportEntry.kind, data: { id, outcome } }
        const next = { status: 'running', checkpoint: { phase: 'next' } } as const
        if (outcome.outcome === 'failed') {
          await (
            await runtime.conversation(branch, context)
          )?.submit(
            {
              type: 'input',
              content: text,
              entry,
              whenBusy: 'followUp',
              requestId: `lander:${id}`,
            },
            context,
          )
          await runtime.commit(() => next, context)
          return
        }
        await (
          await host.harness().conversation(branch, context)
        )?.submit(
          {
            type: 'write',
            requestId: `lander:${id}`,
            entry: { ...entry, model: [{ role: 'user', content: text, timestamp: Date.now() }] },
          },
          context,
        )
        const starter = await after.starter(branch, context)
        await runtime.commit(async (tx) => {
          let concludedInThisCommit = false
          if (!(await after.working(tx, branch)))
            try {
              await after.conclude(tx, branch)
              concludedInThisCommit = true
            } catch (error) {
              host.notice(`Not concluding #${branch} after landing: ${String(error)}`)
            }
          if (concludedInThisCommit && starter !== undefined && starter !== branch)
            await after.reserveLanding(tx, branch, id)
          return {
            status: 'running',
            checkpoint: {
              phase: 'deliver',
              id,
              conversationId,
              headline,
              outcome,
              concluded: concludedInThisCommit,
              ...(starter !== undefined && starter !== branch ? { starter } : {}),
            },
          }
        }, context)
      },
      deliver: async (task, runtime, context) => {
        const {
          id,
          conversationId,
          headline,
          outcome,
          concluded: conclusionCommitted,
          starter,
        } = task.state.checkpoint
        const entry = { kind: LanderReportEntry.kind, data: { id, outcome } }
        const content = `${headline}\nDiverged: ${outcome.divergence}\n${conclusionCommitted ? `#${conversationId} is concluded.` : `#${conversationId} still has work under way; it reports when it stops.`}`
        try {
          const to =
            starter === undefined ? undefined : await runtime.conversation(starter, context)
          await runtime.commit(async (tx) => {
            if (to && conclusionCommitted)
              await after.submitLanding(
                tx,
                to,
                { type: 'input', content, entry, whenBusy: 'followUp', requestId: `lander:${id}` },
                conversationId,
                id,
              )
            else if (to)
              await to.submit(tx, {
                type: 'write',
                requestId: `lander:${id}`,
                entry: { ...entry, model: [{ role: 'user', content, timestamp: Date.now() }] },
              })
            else if (conclusionCommitted && starter !== undefined) await after.retireLanding(tx, id)
            return {
              status: 'running',
              checkpoint: conclusionCommitted
                ? { phase: 'release', conversationId }
                : { phase: 'next' },
            }
          }, context)
        } catch (error) {
          if (runtime.signal.aborted || !conclusionCommitted || starter === undefined) throw error
          await runtime.commit(async (tx) => {
            await after.retireLanding(tx, id)
            return {
              status: 'running',
              checkpoint: {
                phase: 'card-failed',
                error: error instanceof Error ? error.message : String(error),
              },
            }
          }, context)
        }
      },
      'card-failed': (task) => {
        throw new Error(task.state.checkpoint.error)
      },
      release: async (task, runtime, context) => {
        await after
          .release(task.state.checkpoint.conversationId, context)
          .catch((error: unknown) => {
            context.abortSignal?.throwIfAborted()
            host.notice(
              `Releasing #${task.state.checkpoint.conversationId} failed: ${String(error)}`,
            )
          })
        await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'next' } }), context)
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const index = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
        if (index.landers[task.input.source] === task.id) delete index.landers[task.input.source]
        for (const item of index.queue)
          if (item.source === task.input.source && item.state !== 'pr') {
            item.state = 'queued'
            delete item.step
          }
        const checkpoint = task.state.checkpoint
        if (
          checkpoint.phase === 'deliver' &&
          checkpoint.concluded &&
          checkpoint.starter !== undefined
        )
          await after.retireLanding(tx, checkpoint.id)
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
  return Lander
}
