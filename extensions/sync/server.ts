import { realpath } from 'node:fs/promises'
import { BACKGROUND_CONTEXT as background } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { isolatable } from '../../lib/git.ts'
import { meansNone } from '../../lib/errors.ts'
import { deadline, every } from '../../lib/timers.ts'
import { ConversationsApi } from '../conversations/api.ts'
import { SubagentsApi } from '../subagents/api.ts'
import { WorkspacesApi } from '../workspaces/api.ts'
import { PauseApi } from '../pause/api.ts'
import { fetchIfDue, openPr, pull, push, stateOf } from './sync.ts'
import type { Context } from './sync.ts'
import { cloneLock, gitIn, gitPath, withLock } from '../../lib/clone.ts'
import { CheckAction, MergeAction, PrAction, PullAction, PushAction, StateAction } from './refs.ts'
import type { SyncState } from './refs.ts'

export const TICK = 5 * 60_000

const preview = () => Boolean(process.env.ULTIMATE_INSTANCE_OWNER)

type Shared = {
  ticking: Promise<void> | undefined
  checking: Promise<void> | undefined
  latest: SyncState | undefined
}

const shared = (host: ExtensionHost) =>
  host.resource<Shared>('sync.state', () => ({
    ticking: undefined,
    checking: undefined,
    latest: undefined,
  }))

async function sourceOf(host: ExtensionHost) {
  const top = await gitIn(host.projectRoot)('rev-parse', '--show-toplevel').catch(meansNone)
  return top ? realpath(top) : undefined
}

const previewState: SyncState = {
  ahead: 0,
  behind: 0,
  dirty: false,
  commits: [],
  protected: false,
  preview: true,
}

async function contextOf(host: ExtensionHost, git: ReturnType<typeof gitIn>): Promise<Context> {
  const settings = (await host.projectSettings()) as {
    sync?: { protected?: unknown }
    lander?: { push?: unknown }
  }
  const listed = Array.isArray(settings.sync?.protected)
    ? settings.sync.protected.filter((name): name is string => typeof name === 'string')
    : []
  const isolate = await isolatable(host.projectRoot)
  const target = 'target' in isolate ? isolate.target : undefined
  const landerPushes = typeof settings.lander?.push === 'string'
  const origin = await git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => '')
  const defaultBranch = origin.replace(/^origin\//, '') || undefined
  return {
    protectedBranches: [
      ...listed,
      ...(defaultBranch ? [defaultBranch] : []),
      ...(landerPushes && target ? [target] : []),
    ],
    ...(defaultBranch ? { defaultBranch } : {}),
  }
}

async function refresh(host: ExtensionHost, check: boolean, force = false) {
  const root = await sourceOf(host)
  const store = shared(host)
  if (!root) {
    store.latest = { ahead: 0, behind: 0, dirty: false, commits: [], protected: false }
    return
  }
  const git = gitIn(root)
  const error = check ? await fetchIfDue(git, root, Date.now(), force) : store.latest?.error
  store.latest = {
    ...(await stateOf(git, root, await contextOf(host, git))),
    ...(error ? { error } : {}),
  }
}

async function currentState(host: ExtensionHost): Promise<SyncState> {
  if (preview()) return previewState
  const store = shared(host)
  if (!store.latest) await refresh(host, false)
  return store.latest!
}

async function checkout(host: ExtensionHost) {
  if (preview()) throw new Error('A preview never moves the checkout it runs from')
  const root = await sourceOf(host)
  if (!root) throw new Error('The project is not a Git repository')
  const git = gitIn(root)
  return { root, git, settings: await contextOf(host, git) }
}

const mergeInput = (state: SyncState) =>
  [
    `Sync with @ultimate: ${state.branch} in ${state.root} has diverged from ${state.upstream} (${state.ahead} local ${state.ahead === 1 ? 'commit' : 'commits'}, ${state.behind} new upstream) and merging them would conflict, so Pull refused.`,
    `Start a coordinator branch that merges ${state.upstream} into ${state.branch} in its worktree: git fetch, then a normal git merge ${state.upstream}, never a rebase, reset or force push.`,
    'It resolves the conflicts it can resolve safely, sends the unclear ones back as decisions, runs the checks and the tests covering the conflicts, and lands the merge with workspace submit.',
  ].join('\n')

export default function sync(host: ExtensionHost) {
  host.need(WorkspacesApi)
  host.need(ConversationsApi)
  host.need(SubagentsApi)
  host.want(PauseApi)
  const store = shared(host)
  if (preview()) return defineExtension({ name: 'sync' })
  const tick = () => {
    if (host.want(PauseApi)?.paused()) return
    store.ticking ??= refresh(host, true)
      .catch((error: unknown) => host.notice(`Sync check: ${String(error)}`))
      .finally(() => {
        store.ticking = undefined
      })
  }
  const cancelStart = deadline(30_000, tick)
  const stopTicking = every(TICK, tick)
  host.onClose(async () => {
    cancelStart()
    stopTicking()
    await store.ticking
  })
  return defineExtension({ name: 'sync' })
}

export const userActions = ['pull', 'push', 'pr', 'merge']

export const actions = {
  state: implementAction(StateAction, (_args, { host }) => currentState(host)),
  check: implementAction(CheckAction, async (_args, { host }) => {
    if (preview()) return previewState
    const store = shared(host)
    await store.ticking
    store.checking ??= refresh(host, true, true).finally(() => {
      store.checking = undefined
    })
    await store.checking
    return store.latest!
  }),
  pull: implementAction(PullAction, async (_args, { host }) => {
    const { root, git } = await checkout(host)
    const result = await withLock(await gitPath(git, root, cloneLock), () =>
      pull(git, root, (operation) => host.need(WorkspacesApi).serialize(root, operation)),
    )
    await refresh(host, true)
    return (
      result ?? { ok: false as const, refused: "Another Ultimate holds this repository's lock" }
    )
  }),
  push: implementAction(PushAction, async (_args, { host }) => {
    const { root, git, settings } = await checkout(host)
    const result = await push(git, root, settings)
    await refresh(host, true)
    return result
  }),
  pr: implementAction(PrAction, async (_args, { host }) => {
    const { root, git, settings } = await checkout(host)
    const result = await openPr(git, root, settings)
    await refresh(host, true)
    return result
  }),
  merge: implementAction(MergeAction, async (_args, { host }) => {
    await checkout(host)
    await refresh(host, false)
    const latest = shared(host).latest!
    if (!latest.merge) throw new Error(latest.pullRefused ?? `${latest.branch} has not diverged`)
    const git = gitIn(latest.root!)
    const head = await git('rev-parse', 'HEAD')
    const remote = await git('rev-parse', latest.upstream!)
    const id = await host.need(SubagentsApi).standing('ultimate', background)
    const conversation = (await host.harness().conversation(id, background))!
    await conversation.submit(
      {
        type: 'input',
        content: mergeInput(latest),
        requestId: `sync-merge:${head}..${remote}`,
        whenBusy: 'followUp',
      },
      background,
    )
    return { id }
  }),
}
