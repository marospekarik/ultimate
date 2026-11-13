import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { copyJson } from '@earendil-works/chord/json'
import type { Context } from '@earendil-works/chord/context'
import type { JsonObject, TaskRuntime } from '@earendil-works/pi-durable'
import { withAbortSignal } from '@earendil-works/chord/context'
import { defineEntry, defineTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationDocToken, ConversationId, Tx } from '@earendil-works/pi-durable'
import { git } from '../../lib/git.ts'
import { needsRestart as restartNeeded } from '../../lib/layers.ts'
import { runGroup, sweepPidFiles } from '../../lib/process-group.ts'
import { landingWeight } from '../../lib/token-weight.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { CheckRan, SubmissionFailed, SubmissionLanded } from './api.ts'
import { decidePolls, parsePr, realGh } from './pr.ts'
import type { Gh, PrState } from './pr.ts'
import { setup } from '../../lib/worktree-setup.ts'
import { addCheckout, treePath } from './tree.ts'
import type { Landed, LanderEntry, LanderOutcome, QueueEntry, WorkspaceIndex } from './types.ts'

/** One line of the lander conversation's log; it carries no model message, so no model ever sees it. */
export const LanderLog = defineEntry<LanderEntry>('ultimate.lander')
/** The entry kind of a submission's report: its outcome card, in the submitter and in whoever started it. */
export const LanderReportEntry = 'workspaces.lander-report'
/** Outcomes kept in the index for submit cards; older ones live on in the lander conversation. */
const kept = 50
/** The lander's own detached checkout of `source`, also its conversation's cwd. */
export async function landerPath(home: string, source: string, settings: JsonObject) {
  const configured = await treePath(settings, landerName(source))
  if (configured) return configured
  await mkdir(join(home, 'lander'), { recursive: true })
  return join(await realpath(join(home, 'lander')), landerHash(source))
}
const landerHash = (source: string) =>
  createHash('sha256').update(source).digest('hex').slice(0, 12)
/** The name a configured `isolates.worktree` layout gives the lander's checkout of `source`. */
const landerName = (source: string) => `ult-lander-${landerHash(source)}`
const checkouts = new Map<string, Promise<string>>()
/**
 * The lander's checkout of `source`, created detached at `tip` when it is not a registered worktree yet; an existing one
 * stays as it is. Serialize creation per path so another caller cannot remove a checkout being created.
 */
export async function landerCheckout(
  home: string,
  source: string,
  settings: JsonObject,
  tip = 'HEAD',
) {
  const path = await landerPath(home, source, settings)
  const queued = (checkouts.get(path) ?? Promise.resolve())
    .catch(
      // The previous caller receives its failure; a later call must still be able to recover.
      () => undefined,
    )
    .then(async () => {
      const registered = (await git(source, 'worktree', 'list', '--porcelain'))
        .split('\n\n')
        .some((entry) => entry.split('\n').includes(`worktree ${path}`))
      if (!registered) {
        // The directory is the lander's own; a crash may have left it half created.
        await rm(path, { recursive: true, force: true })
        await git(source, 'worktree', 'prune')
        await addCheckout(settings, source, path, landerName(source), ['--detach', tip])
      }
      return path
    })
  checkouts.set(path, queued)
  try {
    return await queued
  } finally {
    if (checkouts.get(path) === queued) checkouts.delete(path)
  }
}
/**
 * Append a log line about `entry`, a draft of its queue entry, to the lander conversation `id`; a step also joins the
 * entry's `steps`, which the submitter's cards show.
 */
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
type Host = Pick<
  ExtensionHost,
  | 'home'
  | 'ultimateRoot'
  | 'harness'
  | 'projectSettings'
  | 'doc'
  | 'metadata'
  | 'notice'
  | 'emit'
  | 'resource'
>
/** One check command, with its own total limit in seconds when set, and its own no-output limit. */
type Check = { command: string; timeout?: number; stall?: number }
/** Checks run in order; an array is a group whose commands run concurrently. */
type Settings = {
  checks: (Check | Check[])[]
  push?: string
  /** Pull request mode: push the conversation's branch to `remote` and open a PR against its `base`. */
  pr?: { remote: string; base: string }
}
/** How long the lander waits before asking GitHub again about open pull requests. */
const pollInterval = 5 * 60 * 1000
/** Bounded retries when the target moves while a submission is integrated. */
const attempts = 3
/** Seconds without output and total seconds allowed for one check, unless the check sets its own limits. */
type CheckLimits = { stall: number; total: number }
const checkLimits: CheckLimits = { stall: 2 * 60, total: 10 * 60 }
/**
 * A check's limits: its `timeout` replaces the total and its `stall` the no-output limit; neither exceeds the total.
 * A suite whose cold start is legitimately silent needs its own `stall` — the full e2e suite prints nothing for its
 * first minute or more while vitest collects it cold, which the 2-minute default cut mid-transform in the lander's
 * fresh checkout (#12346), and the kill left the transform cache cold for every retry.
 */
export const limitsFor = (check: Check, limits: CheckLimits): CheckLimits => {
  const total = check.timeout ?? limits.total
  const stall = Math.min(check.stall ?? limits.stall, total)
  return { stall, total }
}
/** Lines naming failed tests (vitest's `FAIL`, `×` and `✗` marks), kept from a check's whole output. */
const failedLine = /^\s*(FAIL|×|✗)\s/
const seconds = (value: number) => (value < 60 ? `${value} s` : `${+(value / 60).toFixed(1)} min`)

/** Where running checks record their process groups, so a host that crashed mid-check stops them on its next open. */
export const checkPids = (home: string) => join(home, 'lander-checks')
/**
 * Stop the checks a previous process left running. Pi resumes a lander task before extensions open, so files of
 * this process name live checks, never leftovers.
 */
export const sweepChecks = async (home: string) => {
  await sweepPidFiles(checkPids(home), (name) => name.startsWith(`${process.pid}-`))
  // Temporary directories of checks whose process stopped; a live check of this process made none yet.
  const names = await readdir(checkTemp(home)).catch((error: NodeJS.ErrnoException) => {
    // No check ever ran in this home.
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const name of names)
    if (!name.startsWith(`${process.pid}-`))
      await rm(join(checkTemp(home), name), { recursive: true, force: true })
}
/**
 * Where checks keep temporary files: on disk under the project home, not in `/tmp`, which is often a small tmpfs
 * that test suites fill (EDQUOT) when interrupted runs leave their directories behind.
 */
export const checkTemp = (home: string) => join(home, 'lander-tmp')

/**
 * Run `command` with bash in its own process group, recorded in `pids` while it runs, with `TMPDIR` set to a fresh
 * directory in `temp` that is removed when it ends. The watchdog and task cancellation both stop the whole group:
 * TERM, then KILL after a short grace.
 */
export async function runLanderCheck(
  path: string,
  command: string,
  context: Context,
  pids: string,
  temp: string,
  limits: CheckLimits = checkLimits,
) {
  // Synchronous, so the watchdog's timers start in the same tick as the call.
  mkdirSync(temp, { recursive: true })
  const tmp = mkdtempSync(join(temp, `${process.pid}-`))
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
  let stallTimer = setTimeout(stalled, limits.stall * 1000)
  const totalTimer = setTimeout(
    () => stop(`Timed out after ${seconds(limits.total)}`),
    limits.total * 1000,
  )
  /** A failure report: what ended the check, the failed tests seen (at most 20), then the output tail. */
  const report = (reason: string, heading: string) => {
    const tests = [...failed].slice(-20)
    return [reason, ...(tests.length ? [heading, ...tests] : []), output].join('\n').trim()
  }
  const onOutput = (text: string) => {
    output = (output + text).slice(-3000)
    const split = (partial + text).split('\n')
    partial = split.pop()!.slice(-1000)
    for (const line of split) {
      const plain = stripVTControlCharacters(line).trim()
      if (failedLine.test(plain)) failed.add(plain.slice(0, 300))
    }
    clearTimeout(stallTimer)
    stallTimer = setTimeout(stalled, limits.stall * 1000)
  }
  try {
    let exitCode: number
    try {
      exitCode = await runGroup('/bin/bash', ['-c', command], {
        cwd: path,
        env: { ...process.env, TMPDIR: tmp },
        pidFile: join(pids, `${process.pid}-${randomUUID()}.pid`),
        signal,
        grace: 2000,
        onOutput,
      })
    } catch (error) {
      context.abortSignal?.throwIfAborted()
      return { failure: `${output}\n${String(error)}`.trim() }
    }
    context.abortSignal?.throwIfAborted()
    if (stopped) return { failure: report(stopped, 'Failed tests so far:'), timedOut: true }
    if (exitCode !== 0) return { failure: report(`exit ${exitCode}`, 'Failed tests:') }
    const last = lines(stripVTControlCharacters(output)).findLast((line) => line.trim())
    return { summary: last?.trim().slice(0, 200) }
  } finally {
    clearTimeout(stallTimer)
    clearTimeout(totalTimer)
    // Best effort: detached processes an e2e test leaves behind (supervisors, preview homes) can still be writing here,
    // the same race #43 fixed in test/sweep-temp.ts. Without retry and catch, rm throws ENOTEMPTY and refuses a landing
    // whose checks passed. sweepChecks removes the leftover at the next start. Can go once no check leaves writers.
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {})
  }
}

/** A check from settings: a command, or `{ command, timeout, stall }` with positive seconds. */
const parseCheck = (value: unknown): Check | undefined => {
  if (typeof value === 'string') return { command: value }
  if (!value || typeof value !== 'object') return undefined
  const { command, timeout, stall } = value as {
    command?: unknown
    timeout?: unknown
    stall?: unknown
  }
  if (typeof command !== 'string') return undefined
  const fields = [timeout, stall]
  if (!fields.every((field) => field === undefined || (typeof field === 'number' && field > 0)))
    return undefined
  return {
    command,
    ...(typeof timeout === 'number' ? { timeout } : {}),
    ...(typeof stall === 'number' ? { stall } : {}),
  }
}
export const landerSettings = async (host: Pick<Host, 'projectSettings'>): Promise<Settings> => {
  const lander = (await host.projectSettings()).lander as
    | { checks?: unknown; push?: unknown; pr?: unknown }
    | undefined
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
      'lander.checks must be an array of checks or check groups; a check is a command or { "command", "timeout", "stall" } with timeout and stall in seconds',
    )
  if (lander?.push !== undefined && typeof lander.push !== 'string')
    throw new Error('lander.push must be a remote name')
  const pr = parsePr(lander?.pr)
  if (pr && lander?.push)
    throw new Error(
      'lander.pr and lander.push cannot both be set: pr pushes the branch and opens a pull request, push moves the target',
    )
  return {
    checks: checks as Settings['checks'],
    // A preview never pushes; its git hooks refuse it too (extensions/instance).
    ...(lander?.push && !process.env.ULTIMATE_PREVIEW_BRANCH ? { push: lander.push } : {}),
    ...(pr && !process.env.ULTIMATE_PREVIEW_BRANCH ? { pr } : {}),
  }
}
export const contains = (cwd: string, ancestor: string, descendant: string) =>
  git(cwd, 'merge-base', '--is-ancestor', ancestor, descendant).then(
    () => true,
    () => false,
  )
const lines = (text: string) => text.split('\n').filter(Boolean)
const failure = (error: unknown) => {
  const output = error as Error & { stdout?: string; stderr?: string }
  return `${output.stdout ?? ''}${output.stderr ?? ''}${output.stdout || output.stderr ? '' : output.message}`
    .trim()
    .slice(-3000)
}
/** Run a network git command in `cwd`; longer than git()'s local timeout. */
const remote = (cwd: string, signal: AbortSignal, ...args: string[]) =>
  git({ cwd, signal, timeout: 300000 }, ...args)

type Runtime = TaskRuntime<{ source: string }, State, null, object>
type Prepared = {
  base: string
  integrated: string
  flaky: string[]
}
const landedOutcome = (landed: Landed): LanderOutcome => ({
  outcome: 'landed',
  sha: landed.sha,
  base: landed.base,
  commits: landed.commits,
  paths: landed.paths,
  flaky: landed.flaky,
  ...(landed.weight ? { weight: landed.weight } : {}),
})
type State =
  | { phase: 'next' }
  /** A rejected push integrates again once. */
  | { phase: 'land'; id: string; attempt: number; pushRetried?: boolean }
  /** `pr` mode: ask GitHub about the open pull requests of this source; sleep when none ended. */
  | { phase: 'poll' }
  | {
      phase: 'report'
      id: string
      conversationId: number
      text: string
      outcome: WorkspaceIndex['results'][string]
    }
  /** The landing's decision, made once: tell `starter` (waking it only when the branch `concluded`), then release it. */
  | {
      phase: 'deliver'
      id: string
      conversationId: number
      text: string
      outcome: WorkspaceIndex['results'][string]
      concluded: boolean
      starter?: number
    }
  /** A landed branch concluded in the report's last commit: free its checkout. */
  | { phase: 'release'; conversationId: number }

export function createLander(
  host: Host,
  Workspaces: ConversationDocToken<WorkspaceIndex>,
  /** Serializes source checkout writes with synchronous landing. */
  serial: <T>(source: string, operation: () => Promise<T>) => Promise<T>,
  /** What a landing needs from the rest of Ultimate: who started a branch, whether it has work under way, conclude, release. */
  after: {
    starter: (id: ConversationId, context: Context) => Promise<number | undefined>
    working: (tx: Tx, id: ConversationId) => Promise<boolean>
    conclude: (tx: Tx, id: ConversationId) => Promise<void>
    release: (id: ConversationId, context: Context) => Promise<unknown>
  },
  limits: CheckLimits = checkLimits,
) {
  async function checkout(source: string, tip: string) {
    const path = await landerCheckout(host.home, source, await host.projectSettings(), tip)
    // Every attempt starts from a clean checkout at the target tip; ignored files such as installs stay.
    await git(path, 'reset', '--hard', '-q')
    await git(path, 'checkout', '-q', '--detach', '--force', tip)
    await git(path, 'clean', '-fdq')
    return path
  }

  /** Record the outcome of `entry`, log it and report it to the submitter, in one commit. */
  function finisher(runtime: Runtime, context: Context, entry: QueueEntry) {
    const id = entry.id
    const finish = (text: string, outcome: LanderOutcome) =>
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
        for (const old of Object.keys(draft.results).slice(0, -kept)) delete draft.results[old]
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
            title:
              subject.title ??
              (await tx.doc(host.metadata, entry.conversationId as ConversationId)).title ??
              '',
            ...(subject.summary ? { summary: subject.summary } : {}),
            ...(subject.feature ? { feature: subject.feature } : {}),
            commits: commits.slice(0, 10),
            commitCount: commits.length,
            paths: (outcome.paths ?? []).slice(0, 8),
            ...(outcome.pushed ? { pushed: outcome.pushed } : {}),
          })
        }
        return {
          status: 'running',
          checkpoint: {
            phase: 'report',
            id,
            conversationId: entry.conversationId,
            outcome: draft.results[id],
            text: `[lander] Submission ${id} (#${entry.conversationId}, ${entry.tip.slice(0, 7)}) ${text}\nLog: lander conversation #${runtime.conversationId}.`,
          },
        }
      }, context)
    return finish
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
          // Open pull requests wait in the queue; they are polled once nothing else needs landing.
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
        /** What this submission's fast-forward landed, if it happened yet. */
        const recorded = async () =>
          (await runtime.snapshot(Workspaces, ROOT_CONVERSATION_ID, context))!.queue.find(
            (item) => item.id === id,
          )?.landed
        /**
         * Log a step; a check's `output` tail goes to the lander log only, not the submission's steps. A run check's
         * step also emits `workspaces.check`, with `ran` its duration and whether a watchdog stopped it. A step that
         * starts a check names its command in `runs`.
         */
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
        const finish = finisher(runtime, context, entry)
        const summary = (landed: Landed, sha: string, how = '') =>
          [
            landed.commits.length
              ? `landed${how} as ${sha.slice(0, 7)} on ${entry.target}.`
              : `had nothing new to land on ${entry.target}.`,
            ...(landed.commits.length ? [`Commits:\n${landed.commits.join('\n')}`] : []),
            ...landed.flaky.map((command) => `Flaky: ${command}`),
          ].join('\n')
        /**
         * Report `reason`, with `output` (conflicting paths, a check's output tail) and what to do next.
         * Once the submission landed locally, a later failure only means its push failed.
         */
        const fail = async (reason: string, output?: string, hint?: string) => {
          const landed = await recorded()
          const detail = [output ? `${reason}:\n${output}` : reason, ...(hint ? [hint] : [])].join(
            '\n',
          )
          const facts = {
            reason: landed ? `Push failed: ${reason}` : reason,
            ...(output ? { output } : {}),
            ...(hint ? { hint } : {}),
          }
          return landed
            ? finish(`${summary(landed, landed.sha, ' locally')}\nPush failed: ${detail}`, {
                ...landedOutcome(landed),
                ...facts,
              })
            : finish(`was not landed: ${detail}`, { outcome: 'failed', ...facts })
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
        const checkContext = withAbortSignal(signal, context)
        /** Push `sha` when configured; on a rejection retry the integration once, then report it. */
        const push = async (settings: Settings, sha: string) => {
          if (!settings.push) return { text: 'Not pushed.' }
          await step(`pushing to ${settings.push}`)
          try {
            // Push the checked commit, not whatever the branch points to by now.
            await remote(source, signal, 'push', '-q', settings.push, `${sha}:refs/heads/${target}`)
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
        /** Push what landed and report it: commits, flaky checks, push, restart hint. */
        const landedReport = async (settings: Settings, landed: Landed, sha: string) => {
          const pushed = await push(settings, sha)
          if (pushed.retry) return pushed.retry
          const needsRestart =
            (await realpath(source)) === (await realpath(host.ultimateRoot)) &&
            restartNeeded(landed.paths)
          return finish(
            [summary(landed, sha), pushed.text, ...(needsRestart ? ['Needs restart.'] : [])].join(
              '\n',
            ),
            {
              ...landedOutcome(landed),
              ...(pushed.remote ? { pushed: pushed.remote } : {}),
              ...(needsRestart ? { needsRestart } : {}),
            },
          )
        }
        /**
         * Push the conversation's own branch and open (or reuse) its pull request; the entry stays queued in state
         * `pr` until the poll sees the PR merge or close.
         */
        const openPullRequest = async (pr: NonNullable<Settings['pr']>, sha: string) => {
          const gh = host.resource<Gh>('workspaces.gh', () => realGh)
          const branch = index.items[String(entry.conversationId)].branch
          // The poll fast-forwards the local target from the PR's base; a base of another branch would move it
          // somewhere unrelated, so the submission refuses instead of landing a lie.
          if (pr.base !== entry.target)
            return fail(
              `lander.pr.base (${pr.base}) is not the branch this project lands into (${entry.target})`,
              undefined,
              `Set lander.pr.base to "${entry.target}" or retarget the project, then submit again.`,
            )
          // Before pushing anything: a missing or logged-out gh would leave a pushed branch without its PR.
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
            // Only a resubmit with rewritten history is rejected: this branch belongs to this conversation alone, so it
            // may be replaced, and only where it still is what we saw.
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
                  title,
                  '--body',
                  [subject.summary, `Diverged from the request: ${entry.divergence}`]
                    .filter(Boolean)
                    .join('\n\n'),
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
            // A resubmit of the same branch updated the pull request the older entry waited on.
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
          // An earlier lander task fast-forwarded this submission and then ended (a reload or fault before its push):
          // nothing to merge or check again, push exactly what landed and report that landing.
          if (
            entry.landed &&
            attempt === 1 &&
            !pushRetried &&
            (await contains(source, entry.landed.sha, `refs/heads/${target}`))
          )
            return await landedReport(settings, entry.landed, entry.landed.sha)
          // A crash after the checks keeps the integrated commit: go straight to fast-forwarding it.
          let prepared = await runtime.memo<Prepared>(`prepared:${id}:${attempt}`, context)
          if (!prepared) {
            // A crash after the merges resumes on the same merged commit instead of merging again.
            let merged = await runtime.memo<{ base: string; sha: string }>(
              `merged:${id}:${attempt}`,
              context,
            )
            const path = await checkout(
              source,
              merged?.sha ?? (await git(source, 'rev-parse', `refs/heads/${target}`)),
            )
            if (!merged) {
              await step('preparing')
              // The target tip the integration started from: what a fast-forward expects to find.
              const localTip = await git(path, 'rev-parse', 'HEAD')
              /** Merge `commit` into the checkout; true when it conflicted and the submission failed. */
              const merge = async (
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
                  // The next attempt starts from a reset, cleaned checkout, so a failed abort cannot leak into it.
                  await git(path, 'merge', '--abort').catch(() => undefined)
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
                      await merge(
                        fetched,
                        `Merge ${settings.push}/${target}`,
                        `${settings.push}/${target} conflicts with local ${target} in`,
                        `Reconcile ${settings.push}/${target} with local ${target}, then submit again.`,
                      )
                    )
                      return
                  }
                }
              }
              if (settings.pr) {
                // The PR merges into the remote base: prove the submission against that, not local main.
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
                await merge(
                  entry.tip,
                  // The trailer labels the landing in first-parent catch-up rows (lineage/catchup.ts).
                  `Merge ${entry.tip.slice(0, 7)} from #${entry.conversationId} into ${target}\n\nUltimate-Conversation: ${entry.conversationId}`,
                  `it conflicts with ${target} in`,
                  `Merge ${target} into your workspace, resolve, verify and submit again.`,
                )
              )
                return
              merged = await runtime.memo(
                `merged:${id}:${attempt}`,
                { base: localTip, sha: await git(path, 'rev-parse', 'HEAD') },
                context,
              )
            }
            const { base } = merged
            // Setup prepares the merged revision, for example installs its lockfile.
            await step('setting up')
            await setup(source, path, await host.projectSettings(), signal)
            const flaky: string[] = []
            for (const [position, group] of settings.checks.entries()) {
              const members = Array.isArray(group) ? group : [group]
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
              /** One command: its first run, then one rerun when that failed; its output tail if it failed twice. */
              const settle = async (command: string, member: number) => {
                // Outcomes are durable (memos are first-writer-wins, so the rerun has its own key): a resume
                // neither reruns a passed check nor grants another rerun, and keeps the flaky note.
                const key = `check:${id}:${attempt}:${Array.isArray(group) ? `${position}.${member}` : position}`
                let first = await runtime.memo<'passed' | 'failed'>(key, context)
                if (!first) {
                  await step(`checking: ${command}`, { runs: command })
                  const began = performance.now()
                  const ran = await run(command, member)
                  const result = ran.failure === undefined ? 'passed' : 'failed'
                  // Logged before the memo: a crash in between reruns the check and logs it again, as it ran.
                  // A failure keeps its output tail, so a check that passes on its rerun can still be diagnosed.
                  await step(`checked: ${command}`, {
                    result: { command, result, ...(ran.summary ? { summary: ran.summary } : {}) },
                    output: ran.failure,
                    ran: { ms: performance.now() - began, timedOut: ran.timedOut },
                  })
                  first = await runtime.memo(key, result, context)
                }
                if (first === 'passed') return {}
                // The rerun's outcome is durable either way: a resume while the group's other commands still run
                // neither grants a third run nor loses the failure.
                let rerun = await runtime.memo<{ failure?: string }>(`${key}:rerun`, context)
                if (!rerun) {
                  await step(`rerunning: ${command}`, { runs: command })
                  const began = performance.now()
                  const ran = await run(command, member)
                  const timing = { ms: performance.now() - began, timedOut: ran.timedOut }
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
                    `${key}:rerun`,
                    ran.failure === undefined ? {} : { failure: ran.failure },
                    context,
                  )
                }
                return rerun.failure === undefined ? { flaky: true } : { failure: rerun.failure }
              }
              // Every command settles before a failure hands over, so none still runs in the checkout.
              const settled = await Promise.allSettled(commands.map(settle))
              const results = settled.map((outcome) => {
                if (outcome.status === 'rejected') throw outcome.reason
                return outcome.value
              })
              const failed = results.findIndex((result) => result.failure !== undefined)
              if (failed !== -1)
                return await fail(
                  `check failed twice: ${commands[failed]}`,
                  results[failed].failure,
                  'Fix it at its cause (a flaky test too: fix or delete it), verify and submit again.',
                )
              flaky.push(...commands.filter((_command, member) => results[member].flaky))
            }
            // Only the commit every check ran on lands: nothing may have moved or touched the checkout meanwhile.
            if (
              (await git(path, 'rev-parse', 'HEAD')) !== merged.sha ||
              (await git(path, 'status', '--porcelain'))
            )
              return await fail(
                'the integration checkout changed during checks',
                `${await git(path, 'log', '--oneline', '-3')}\n${await git(path, 'status', '--short')}`.trim(),
                'Submit again.',
              )
            prepared = await runtime.memo<Prepared>(
              `prepared:${id}:${attempt}`,
              { base, integrated: merged.sha, flaky },
              context,
            )
          }
          const { base, integrated, flaky } = prepared
          if (settings.pr) return await openPullRequest(settings.pr, integrated)
          await step('fast-forwarding')
          let refused: string | undefined
          const moved = await serial(source, async () => {
            const current = await git(source, 'rev-parse', `refs/heads/${target}`)
            // A replay after the fast-forward finds exactly the integrated commit; anything else moved.
            if (current === integrated) return false
            if (current !== base) return true
            try {
              // Fast-forward the checkout that has the target checked out, so its files follow the branch.
              const worktree = (await git(source, 'worktree', 'list', '--porcelain'))
                .split('\n\n')
                .map((record) => record.split('\n'))
                .find((record) => record.includes(`branch refs/heads/${target}`))?.[0]
                .slice('worktree '.length)
              if (worktree) await git(worktree, 'merge', '-q', '--ff-only', integrated)
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
            if (attempt < attempts) return retry()
            return fail(`${target} kept moving during ${attempts} attempts.`)
          }
          // The first fast-forward decides what the submission landed, durably on its queue entry with the target's
          // new tip, so any later lander task reports that landing; a push retry integrates again from there.
          const weight = await landingWeight(source, base, integrated)
          const candidate: Landed = {
            sha: integrated,
            base,
            commits: lines(await git(source, 'log', '--oneline', `${base}..${integrated}`)),
            paths: lines(await git(source, 'diff', '--name-only', base, integrated)),
            flaky,
            // Left out, not undefined: documents refuse undefined values.
            ...(weight ? { weight } : {}),
          }
          let landed = candidate
          await runtime.commit(async (tx) => {
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            const saved = draft.queue.find((item) => item.id === id)!
            saved.landed ??= candidate
            // A copy: the draft is gone once the commit settles.
            landed = copyJson(saved.landed) as Landed
            draft.items[String(entry.conversationId)].landed = integrated
          }, context)
          return await landedReport(settings, landed, integrated)
        } catch (error) {
          if (signal.aborted) throw error
          return fail('it failed', failure(error))
        }
      },
      /**
       * Ask GitHub about each open pull request of this source. One that ended is finished like a landing (the
       * report phase follows and returns to `next`); with none ended, sleep and ask again.
       */
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
            // The setting vanished while pull requests wait: nothing can be polled or completed, so say so loudly
            // and keep waiting; restoring it resumes the polls with the next sleep.
            const draft = await tx.doc(Workspaces, ROOT_CONVERSATION_ID)
            for (const item of draft.queue.filter(
              (entry) => entry.source === source && entry.state === 'pr',
            ))
              await log(tx, runtime.conversationId, item, {
                output: 'lander.pr is no longer set; its pull requests are not being polled',
              })
            host.notice('lander.pr is no longer set; open pull requests are not being polled')
            // Sleep, not `next`: the queue holds only these entries, and next would return here at once.
            return {
              status: 'sleeping',
              until: runtime.now() + pollInterval,
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
            // A failed lookup waits for the next poll; the PR stays open in the queue meanwhile.
            host.notice(`Polling PR #${item.pr!.number} failed: ${String(error)}`)
          }
        const decided = decidePolls(open, states)
        const ended = decided.merged[0] ?? decided.closed[0]
        if (ended === undefined)
          return runtime.sleepUntil(runtime.now() + pollInterval, { phase: 'next' }, context)
        const entry = open.find((item) => item.id === ended)!
        const finish = finisher(runtime, context, entry)
        const pr = entry.pr!
        if (decided.closed[0] === ended)
          return finish(`was not landed: PR #${pr.number} was closed without merging`, {
            outcome: 'failed',
            pr,
            reason: `PR #${pr.number} was closed without merging`,
            hint: 'Rework the branch and submit again to open a new pull request.',
          })
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
          // A transient network failure must not fault the lander and stop polling: try again after the sleep.
          host.notice(
            `Fetching ${name}/${branch} for merged PR #${pr.number} failed: ${String(error)}`,
          )
          return runtime.sleepUntil(runtime.now() + pollInterval, { phase: 'next' }, context)
        }
        const fetched = await git(source, 'rev-parse', `refs/remotes/${name}/${branch}`)
        // Decided once: after the fast-forward the local target no longer shows where it started.
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
                  // No common ancestor: the target's own tip is the best "from" there is.
                  () => '',
                )) || (await git(source, 'rev-parse', `refs/heads/${target}`)),
            },
            context,
          ))
        let hint: string | undefined
        await serial(source, async () => {
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
        return finish(
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
            // Left out, not undefined: documents refuse undefined values.
            ...(weight ? { weight } : {}),
            pr,
            ...(hint ? { hint } : {}),
            ...(needsRestart ? { needsRestart } : {}),
          },
        )
      },
      /**
       * A failure wakes the submitter, which fixes it and submits again. A landing is the end of the branch's work: the
       * submitter gets the card as a note, the branch is concluded unless work is still under way, and whoever started
       * it wakes with the same card. Each write has its request id, so a resume never sends one twice.
       */
      report: async (task, runtime, context) => {
        const { id, conversationId, text, outcome } = task.state.checkpoint
        const branch = conversationId as ConversationId
        const entry = { kind: LanderReportEntry, data: { id, outcome } }
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
        // Decided once, with the conversation's state, in the commit that leaves this phase: input admitted after it
        // resumes the branch, and a replay delivers what was decided. While this phase lasts, the branch's own report
        // waits as a note (messages counts this phase as under way); once decided, a branch left open reports when it stops.
        await runtime.commit(async (tx) => {
          let concluded = false
          if (!(await after.working(tx, branch)))
            try {
              await after.conclude(tx, branch)
              concluded = true
            } catch (error) {
              // Roots and standing agents refuse before any write; they stay open by design.
              host.notice(`Not concluding #${branch} after landing: ${String(error)}`)
            }
          return {
            status: 'running',
            checkpoint: {
              phase: 'deliver',
              id,
              conversationId,
              text,
              outcome,
              concluded,
              ...(starter !== undefined && starter !== branch ? { starter } : {}),
            },
          }
        }, context)
      },
      // The starter wakes once when the branch's work ends: here when the landing concluded it, else with the branch's
      // own report when it stops, so the card goes as a note.
      deliver: async (task, runtime, context) => {
        const { id, conversationId, text, outcome, concluded, starter } = task.state.checkpoint
        const entry = { kind: LanderReportEntry, data: { id, outcome } }
        const content = `${text}\nDiverged: ${outcome.divergence}\n${concluded ? `#${conversationId} is concluded.` : `#${conversationId} still has work under way; it reports when it stops.`}`
        if (starter !== undefined)
          await (
            await host.harness().conversation(starter as ConversationId, context)
          )?.submit(
            concluded
              ? { type: 'input', content, entry, whenBusy: 'followUp', requestId: `lander:${id}` }
              : {
                  type: 'write',
                  requestId: `lander:${id}`,
                  entry: {
                    ...entry,
                    model: [{ role: 'user', content, timestamp: Date.now() }],
                  },
                },
            context,
          )
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: concluded ? { phase: 'release', conversationId } : { phase: 'next' },
          }),
          context,
        )
      },
      // At least once, like the Conclude action's release: it frees only what a concluded, idle branch holds.
      release: async (task, runtime, context) => {
        await after
          .release(task.state.checkpoint.conversationId as ConversationId, context)
          .catch((error: unknown) => {
            context.abortSignal?.throwIfAborted()
            // The landing stands; the next open's reconciliation frees the checkout instead.
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
        return { status: 'terminal', outcome: { status: 'aborted' } }
      }, context),
  })
  return Lander
}
