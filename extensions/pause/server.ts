import { parseConversationId } from '../../lib/ids.ts'
import type { ConversationId, Cursor, SubmissionId } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { onCommit } from '../../lib/commits.ts'
import { defineDoc, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { rebuiltOnOpen, inProcess, settled } from '../../lib/errors.ts'
import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { rateLimited } from '../../lib/rate-limit.ts'
import { Standing } from '../subagents/api.ts'
import { PauseApi } from './api.ts'
import { lasted } from './lasted.ts'
import { AutoPlayAction, PauseAction, PauseDoc, PlayAction, StateAction } from './refs.ts'
import type {
  AutoPlayed,
  GaveUp,
  HeldNote,
  Hold,
  PauseDocState,
  PauseNote,
  PauseState,
  RateLimit,
  RunningTask,
} from './refs.ts'

const State = defineDoc<PauseDocState>({
  kind: PauseDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ paused: false }),
})
export const docs = [State]

type Host = Pick<
  ExtensionHost,
  | 'harness'
  | 'resource'
  | 'onOpen'
  | 'onClose'
  | 'onRelease'
  | 'implement'
  | 'conversations'
  | 'modelRuntime'
>

const sharedPauseFlag = (host: Pick<ExtensionHost, 'resource'>) =>
  host.resource('pause.flag', () => ({ paused: false, heldSince: undefined as number | undefined }))

const onlyTimedHoldsSince = (doc: PauseDocState) =>
  doc.paused && !doc.manual && !doc.limit && doc.held?.until !== undefined ? doc.since : undefined

function mirrorPauseFlag(host: Pick<ExtensionHost, 'resource'>, doc: PauseDocState) {
  sharedPauseFlag(host).paused = doc.paused
  sharedPauseFlag(host).heldSince = onlyTimedHoldsSince(doc)
}

function holdRetryDuringPublication(host: Host) {
  sharedPauseFlag(host).paused = true
  sharedPauseFlag(host).heldSince = undefined
  host.harness().hold()
}

const read = async (host: Host) =>
  (await host.harness().snapshot(State, ROOT_CONVERSATION_ID, context)) ?? { paused: false }

function serializePause<T>(
  host: Pick<ExtensionHost, 'resource'>,
  work: () => Promise<T>,
): Promise<T> {
  const queue = host.resource('pause.queue', () => ({
    chain: Promise.resolve() as Promise<unknown>,
  }))
  const next = queue.chain.then(work)
  queue.chain = settled(next)
  return next
}

const HELD_WAIT_PHASES: Record<string, string[]> = {
  'ultimate.subagent-reporter': ['deliver', 'retry'],
  'ultimate.automation-scheduler': ['sleep'],
  'ultimate.automation-run': ['deliver'],
  'board.delivery': ['deliver', 'reply'],
  'board.route': ['observe'],
  'board.settle': ['observe'],
  'conversations.summary': ['observe'],
  'lineage.notify': ['wait'],
}
export const passive = (record: { kind: string; state: unknown }) => {
  const phase = (record.state as { checkpoint?: { phase?: string } }).checkpoint?.phase
  return !!phase && (HELD_WAIT_PHASES[record.kind] ?? []).includes(phase)
}

async function activeTasks(host: Host): Promise<RunningTask[]> {
  const harness = host.harness()
  const { tasks } = await harness.inspect(context)
  const titles = new Map(host.conversations().map((c) => [c.id, c.label ?? c.title]))
  const tools = new Map<number, Map<number, string>>()
  const toolName = async (conversationId: ConversationId, task: number) => {
    if (!tools.has(conversationId)) {
      const live = await harness.snapshot(LiveDoc, conversationId, context)
      const slots = [...(live?.tools ?? []), ...(live?.nestedTools ?? [])]
      tools.set(
        conversationId,
        new Map(
          slots.flatMap((slot) => (slot.taskId === undefined ? [] : [[slot.taskId, slot.name]])),
        ),
      )
    }
    return tools.get(conversationId)!.get(task)
  }
  const result: RunningTask[] = []
  for (const { record, state: inspected } of tasks) {
    if (inspected.kind !== 'running' || (record.background && passive(record))) continue
    const what =
      record.kind === 'pi.generation'
        ? 'model response'
        : record.kind === 'pi.tool'
          ? ((await toolName(record.conversationId, record.id)) ?? 'tool call')
          : record.kind
    const title = titles.get(record.conversationId)
    result.push({
      task: record.id,
      conversationId: record.conversationId,
      ...(title ? { title } : {}),
      what,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    })
  }
  return result
}

async function state(host: Host): Promise<PauseState> {
  const doc = await read(host)
  return {
    paused: doc.paused,
    ...(doc.since === undefined ? {} : { since: doc.since }),
    ...(doc.limit === undefined ? {} : { limit: doc.limit }),
    ...(doc.held === undefined ? {} : { held: doc.held }),
    ...(doc.autoPlay === undefined ? {} : { autoPlay: doc.autoPlay }),
    ...(autoPlayAt(doc) === undefined ? {} : { autoPlayAt: autoPlayAt(doc) }),
    ...(doc.checks === undefined ? {} : { checks: doc.checks }),
    ...(doc.gaveUp === undefined ? {} : { gaveUp: doc.gaveUp }),
    running: await activeTasks(host),
  }
}

type PauseCause = { limit: RateLimit } | { held: Hold }

// Pi upstream: @earendil-works/pi-durable@1.5.2 — patched Harness.hold()/release() keep the scheduler from starting tasks.
async function holdAndRecordPause(host: Host, cause?: PauseCause) {
  const harness = host.harness()
  harness.hold()
  sharedPauseFlag(host).paused = true
  sharedPauseFlag(host).heldSince = undefined
  await harness.commit(async (tx) => {
    const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
    const waitsForPlay = !cause || ('held' in cause && cause.held.until === undefined)
    if (waitsForPlay) doc.manual = true
    if (cause && 'limit' in cause && !doc.limit) doc.limit = cause.limit
    if (cause && 'held' in cause && !doc.held) doc.held = cause.held
    else if (cause && 'held' in cause && (cause.held.until ?? 0) > (doc.held?.until ?? Infinity))
      doc.held!.until = cause.held.until
    if (doc.paused) return
    const runs: NonNullable<PauseDocState['runs']> = {}
    const statusesWithRetryBackoff = ['pending', 'running', 'waiting', 'sleeping'] as const
    for (const status of statusesWithRetryBackoff) {
      let cursor: Cursor | undefined
      do {
        const page = await tx.scanTasks({ kind: 'pi.generation', status }, 100, cursor)
        for (const task of page.items) {
          const run = (await tx.doc(LiveDoc, task.conversationId)).run
          if (run?.taskId === task.id)
            runs[task.conversationId] = { task: task.id, input: run.inputs[0] }
        }
        cursor = page.next
      } while (cursor)
    }
    Object.assign(doc, { paused: true, since: Date.now(), runs })
  }, context)
  const doc = await read(host)
  mirrorPauseFlag(host, doc)
  rearmAutoPlay(host, doc)
}

async function pause(host: Host) {
  await holdAndRecordPause(host)
  return state(host)
}

async function holdForExtension(host: Host, request: Hold) {
  const { source, reason, until } = (request ?? {}) as Partial<Hold>
  if (typeof source !== 'string' || !source.trim() || typeof reason !== 'string' || !reason.trim())
    throw new Error('hold needs { source, reason }: the extension holding the pause, and why')
  if (until !== undefined && !Number.isFinite(until))
    throw new Error('hold until must be a time in ms')
  const flagBeforeHold = { ...sharedPauseFlag(host) }
  try {
    await holdAndRecordPause(host, {
      held: {
        source: source.trim(),
        reason: reason.trim(),
        ...(until === undefined ? {} : { until }),
      },
    })
  } catch (error) {
    Object.assign(sharedPauseFlag(host), flagBeforeHold)
    if (!flagBeforeHold.paused) host.harness().release()
    throw error
  }
  return state(host)
}

const CLOCK_SKEW_GRACE_AFTER_HOLD_END_MS = 2 * 60_000

function autoPlayAt(doc: PauseDocState): number | undefined {
  if (!doc.paused || doc.manual || doc.since === undefined || (!doc.limit && !doc.held))
    return undefined
  const causeEnds: number[] = []
  if (doc.limit) {
    if (!doc.autoPlay || doc.gaveUp !== undefined) return undefined
    causeEnds.push((doc.checks?.at ?? doc.since) + doc.autoPlay * 60_000)
  }
  if (doc.held) {
    if (doc.held.until === undefined) return undefined
    causeEnds.push(doc.held.until + CLOCK_SKEW_GRACE_AFTER_HOLD_END_MS)
  }
  return Math.max(...causeEnds)
}

const LONGEST_TIMER_DELAY_MS = 2 ** 31 - 1

const outsideSchedulerTimer = (host: Pick<ExtensionHost, 'resource'>) =>
  host.resource('pause.autoplay', () => ({ cancel: undefined as Cancel | undefined }))

function rearmAutoPlay(host: Host, doc: PauseDocState) {
  const slot = outsideSchedulerTimer(host)
  slot.cancel?.()
  slot.cancel = undefined
  const at = autoPlayAt(doc)
  if (at === undefined) return
  slot.cancel = deadline(
    Math.min(LONGEST_TIMER_DELAY_MS, Math.max(0, at - Date.now())),
    () => {
      rebuiltOnOpen(
        'open re-arms auto-play from the persisted pause deadline',
        autoPlay(host)
          .then(async (played) => played || rearmAutoPlay(host, await read(host)))
          .catch((error: unknown) => {
            console.error('pause: playing by itself failed:', error)
          }),
      )
    },
    { unref: true },
  )
}

const GIVE_UP_AFTER_MS = 6 * 60 * 60_000
const CHECK_TIMEOUT_MS = 60_000

async function refusal(host: Host, limit: RateLimit, now: number) {
  const model = host.modelRuntime.getModel(limit.provider, limit.model)
  if (!model) return `${limit.provider}/${limit.model} is not available`
  try {
    const answer = await host.modelRuntime
      .streamSimple(
        model,
        { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: now }] },
        {
          maxTokens: 16,
          cacheRetention: 'none',
          ...(model.reasoning ? { reasoning: 'minimal' } : {}),
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        },
      )
      .result()
    return answer.stopReason === 'error' || answer.stopReason === 'aborted'
      ? answer.errorMessage || answer.stopReason
      : undefined
  } catch (error) {
    return String(error)
  }
}

async function recordRefusedCheck(host: Host, now: number) {
  await host.harness().commit(async (tx) => {
    const current = await tx.doc(State, ROOT_CONVERSATION_ID)
    current.checks = { count: (current.checks?.count ?? 0) + 1, at: now }
    if (now + current.autoPlay! * 60_000 > current.since! + GIVE_UP_AFTER_MS) current.gaveUp = now
  }, context)
  await writeGaveUpOnce(host, await read(host))
}

async function writeGaveUpOnce(host: Host, doc: PauseDocState) {
  const harness = host.harness()
  const ultimate = (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
  if (!doc.paused || doc.gaveUp === undefined || ultimate === undefined) return
  const data: GaveUp = {
    limit: doc.limit!,
    since: doc.since!,
    at: doc.gaveUp,
    checks: doc.checks!.count,
  }
  await (
    await harness.conversation(ultimate, context)
  )?.submit(
    {
      type: 'write',
      requestId: `pause.gave-up:${doc.since}`,
      entry: { kind: 'pause.gave-up', data },
    },
    context,
  )
}

export async function autoPlay(host: Host, now = Date.now()) {
  const due = (doc: PauseDocState) => {
    const at = autoPlayAt(doc)
    return at !== undefined && now >= at
  }
  const before = await read(host)
  if (!due(before)) return false
  const refused = before.limit && (await refusal(host, before.limit, now))
  return serializePause(host, async () => {
    const doc = await read(host)
    if (doc.since !== before.since || !doc.limit !== !before.limit || !due(doc)) return false
    if (refused) {
      await recordRefusedCheck(host, now)
      return false
    }
    const data: AutoPlayed = {
      since: doc.since!,
      at: now,
      ...(doc.limit ? { minutes: doc.autoPlay!, checks: doc.checks?.count ?? 0 } : {}),
      ...(doc.held ? { held: doc.held } : {}),
    }
    const why = doc.limit
      ? `after the rate limit paused it, once ${doc.limit.provider} answered again (checked every ${data.minutes} min, the user's setting)`
      : `after ${doc.held!.source} held it (${doc.held!.reason}), once the time it named passed`
    const autoPlayOncePerPause = `pause.autoplay:${data.since}`
    const harness = host.harness()
    const ultimate = (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
    if (ultimate !== undefined)
      await (
        await harness.conversation(ultimate, context)
      )?.submit(
        {
          type: 'write',
          requestId: autoPlayOncePerPause,
          entry: {
            kind: 'pause.autoplay',
            data,
            model: [
              {
                role: 'user',
                content: `Ultimate played by itself ${lasted(now - data.since)} ${why}.`,
                timestamp: now,
              },
            ],
          },
        },
        context,
      )
    await noteRunsThenRelease(host, true)
    return true
  })
}

async function setAutoPlay(host: Host, minutes: unknown) {
  if (
    minutes !== null &&
    (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
  )
    throw new Error('minutes must be a whole number from 1 to 1440, or null to turn it off')
  await host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, ROOT_CONVERSATION_ID)
    if (minutes === null) delete doc.autoPlay
    else doc.autoPlay = minutes
  }, context)
  rearmAutoPlay(host, await read(host))
  return state(host)
}

async function holdRetryOrRelease(host: Host, limit: RateLimit) {
  try {
    await holdAndRecordPause(host, { limit })
  } catch (error) {
    sharedPauseFlag(host).paused = false
    host.harness().release()
    throw error
  }
  await writePauseLimitOnce(host, await read(host))
  await writeHeldRunOnce(host, limit)
}

async function writeHeldRunOnce(host: Host, limit: RateLimit) {
  const harness = host.harness()
  const child = limit.conversationId
  const parent = await harness.commit(
    async (tx) => (await tx.conversation(child))?.owner?.conversationId,
    context,
  )
  const input = (await harness.snapshot(LiveDoc, child, context))?.run?.inputs[0]
  if (parent === undefined || input === undefined) return
  if (!(await harness.snapshot(LiveDoc, parent, context))?.run) return
  const data: HeldNote = { child, provider: limit.provider, model: limit.model, at: limit.at }
  await (
    await harness.conversation(parent, context)
  )?.submit(
    {
      type: 'write',
      requestId: `pause.held:${child}:${input}`,
      entry: { kind: 'pause.held', data },
    },
    context,
  )
}

async function writePauseLimitOnce(host: Host, doc: PauseDocState) {
  const harness = host.harness()
  const ultimate = (await harness.snapshot(Standing, ROOT_CONVERSATION_ID, context))?.ultimate
  if (!doc.paused || !doc.limit || ultimate === undefined) return
  await (
    await harness.conversation(ultimate, context)
  )?.submit(
    {
      type: 'write',
      requestId: `pause.limit:${doc.since}`,
      entry: { kind: 'pause.limit', data: doc.limit },
    },
    context,
  )
}

async function recordedRunOutcome(
  host: Host,
  id: ConversationId,
  recorded: { task: number; input?: number },
) {
  const harness = host.harness()
  const run = (await harness.snapshot(LiveDoc, id, context))?.run
  if (
    run &&
    (run.taskId === recorded.task ||
      (recorded.input !== undefined && run.inputs[0] === recorded.input))
  )
    return 'continued'
  if (recorded.input === undefined) return undefined
  const recordedInputOutcome = await (
    await harness.submission(recorded.input as SubmissionId, context)
  )?.status(context)
  return recordedInputOutcome?.status === 'done' ? 'finished' : undefined
}

async function noteRunsThenRelease(host: Host, auto = false) {
  const harness = host.harness()
  const doc = await read(host)
  if (doc.paused && doc.since !== undefined) {
    const until = Date.now()
    const span = `${lasted(until - doc.since)}${
      doc.limit
        ? ` (${doc.limit.provider} rate limited ${doc.limit.model})`
        : doc.held
          ? ` (${doc.held.source}: ${doc.held.reason})`
          : ''
    }`
    for (const [key, recorded] of Object.entries(doc.runs ?? {})) {
      const id = parseConversationId(Number(key))
      const how = await recordedRunOutcome(host, id, recorded)
      if (!how) continue
      const note: PauseNote = {
        since: doc.since,
        until,
        ...(how === 'finished' && { finished: true }),
        ...(auto && { auto: true }),
      }
      const content =
        how === 'finished'
          ? `Paused for ${span} after this run's last answer.`
          : `Paused for ${span}; the run continued after ${auto ? 'Ultimate played by itself' : 'Play'}.`
      const conversation = await harness.conversation(id, context)
      const noteOncePerPause = `pause.note:${note.since}`
      await conversation?.submit(
        {
          type: 'write',
          requestId: noteOncePerPause,
          entry: {
            kind: 'pause.note',
            data: note,
            model: [{ role: 'user', content, timestamp: note.until }],
          },
        },
        context,
      )
    }
  }
  await harness.commit(async (tx) => {
    const current = await tx.doc(State, ROOT_CONVERSATION_ID)
    current.paused = false
    delete current.since
    delete current.runs
    delete current.limit
    delete current.held
    delete current.manual
    delete current.checks
    delete current.gaveUp
  }, context)
  const after = await read(host)
  rearmAutoPlay(host, after)
  mirrorPauseFlag(host, after)
  harness.release()
  return state(host)
}

export default function pauseExtension(host: Host) {
  host.implement(PauseApi, {
    paused: () => sharedPauseFlag(host).paused,
    hold: (request) => serializePause(host, () => holdForExtension(host, request)),
    heldSince: () => sharedPauseFlag(host).heldSince,
  })
  let unsubscribe: (() => void) | undefined
  const close = async () => {
    unsubscribe?.()
    unsubscribe = undefined
    outsideSchedulerTimer(host).cancel?.()
  }
  host.onClose(close)
  host.onRelease(close)
  host.onOpen(async () => {
    unsubscribe?.()
    await serializePause(host, async () => {
      const doc = await read(host)
      mirrorPauseFlag(host, doc)
      if (!doc.paused) return
      host.harness().hold()
      rearmAutoPlay(host, doc)
      await writePauseLimitOnce(host, doc)
      await writeGaveUpOnce(host, doc)
    })
    unsubscribe = onCommit(host.harness(), (publication) => {
      const generationsSleepingBeforeRetry = new Set(
        publication.changes.flatMap((change) =>
          change.type === 'task' &&
          change.value.kind === 'pi.generation' &&
          change.value.state.status === 'sleeping'
            ? [change.value.conversationId]
            : [],
        ),
      )
      for (const change of publication.changes) {
        const message = change.type === 'entry' ? change.value.model?.[0] : undefined
        if (
          change.type !== 'entry' ||
          !generationsSleepingBeforeRetry.has(change.value.conversationId) ||
          message?.role !== 'assistant' ||
          message.stopReason !== 'error' ||
          !rateLimited(message.errorMessage ?? '')
        )
          continue
        const limit: RateLimit = {
          provider: message.provider,
          model: message.model,
          error: message.errorMessage!,
          at: message.timestamp,
          conversationId: change.value.conversationId,
        }
        holdRetryDuringPublication(host)
        inProcess(
          'the rate-limit hold controls generation retries in this process',
          serializePause(host, () => holdRetryOrRelease(host, limit)).catch((error: unknown) => {
            console.error('pause: pausing for a rate limit failed:', error)
          }),
        )
      }
    })
  })
  return { name: 'pause' }
}

export const actions = {
  state: implementAction(StateAction, (_args, { host }) => state(host)),
  pause: implementAction(PauseAction, (_args, { host }) => serializePause(host, () => pause(host))),
  play: implementAction(PlayAction, (_args, { host }) =>
    serializePause(host, () => noteRunsThenRelease(host)),
  ),
  autoPlay: implementAction(AutoPlayAction, (args, { host }) =>
    serializePause(host, () => setAutoPlay(host, (args as { minutes?: unknown } | null)?.minutes)),
  ),
}
export const userActions = ['pause', 'play', 'autoPlay']
