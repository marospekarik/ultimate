import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, cn, defineWebExtension, events, formatAgo, useAction, useUltimate } from '@/sdk'
import { itemOf, warns } from './item.ts'
import { CheckAction, MergeAction, PrAction, PullAction, PushAction, StateAction } from './refs.ts'
import type { SyncState } from './refs.ts'

const statusButton =
  '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent'

const short = (root: string) => root.replace(/^\/(?:home|Users)\/[^/]+/, '~')
const plural = (count: number) => `${count} ${count === 1 ? 'commit' : 'commits'}`

type Message = { error: boolean; text: string }

const buttonClass = 'h-7 font-sans text-[12px]'

function Popup({
  state,
  busy,
  checking,
  message,
  check,
  act,
}: {
  state: SyncState
  busy: string | undefined
  checking: boolean
  message?: Message
  check: () => void
  act: (name: 'pull' | 'push' | 'pr' | 'merge') => void
}) {
  const item = itemOf(state)
  const upstream = state.upstream ?? ''
  return (
    <>
      <div className="border-b border-border/70 px-3 py-2 text-[11.5px]">
        <div className="section-label">Git sync</div>
        <div className="truncate text-muted-foreground" title={state.root}>
          {short(state.root ?? '')}
        </div>
      </div>
      <div className="space-y-2 px-3 py-2 text-[11.5px] leading-[1.55]" data-sync-body>
        {item === 'noupstream' ? (
          <div>
            {state.branch ? (
              <>
                {state.branch} has no upstream. Set one with{' '}
                <span className="text-foreground/85">
                  git branch --set-upstream-to=origin/{state.branch}
                </span>{' '}
                (or push it once with <span className="text-foreground/85">git push -u origin</span>
                ), and this item will show where it stands.
              </>
            ) : (
              'The checkout is on a detached HEAD: check out a branch to sync it.'
            )}
          </div>
        ) : (
          <>
            <div>
              {item === 'current' ? (
                <>
                  {state.branch} is <span className="text-success">in sync</span> with {upstream}
                </>
              ) : (
                <>
                  {state.branch} is {state.ahead > 0 && plural(state.ahead) + ' ahead of'}
                  {state.ahead > 0 && state.behind > 0 && ' and '}
                  {state.behind > 0 && `${plural(state.behind)} behind`} {upstream}
                </>
              )}
            </div>
            {state.commits.length > 0 && (
              <ul className="space-y-0.5">
                {state.commits.map((commit) => (
                  <li className="flex min-w-0 gap-2" key={commit.sha}>
                    <span className="shrink-0 text-muted-foreground">{commit.sha}</span>
                    <span className="truncate text-foreground/85" title={commit.subject}>
                      {commit.subject}
                    </span>
                  </li>
                ))}
                {state.behind > state.commits.length && (
                  <li className="text-muted-foreground">
                    … {state.behind - state.commits.length} more
                  </li>
                )}
              </ul>
            )}
            {state.diverged && (
              <div data-sync-diverged>
                {state.conflicts === true
                  ? 'Merging would conflict: @ultimate can merge it on a branch and land it once the checks pass.'
                  : state.conflicts === false
                    ? 'Pull merges them; no conflicts expected.'
                    : 'Pull merges them and stops on any conflict.'}
              </div>
            )}
            {state.behind > 0 && state.pullRefused && (
              <div className="flex items-start gap-1.5 text-warning">
                <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
                <span>Can't pull: {state.pullRefused}. Nothing was stashed, rebased or reset.</span>
              </div>
            )}
            {state.ahead > 0 && state.pushRefused && (
              <div className="text-muted-foreground" data-sync-push-refused>
                Can't push: {state.pushRefused}.
                {state.protected && state.repo && state.base && state.base !== state.branch
                  ? ` Open PR sends it to ${state.base}.`
                  : ''}
              </div>
            )}
          </>
        )}
        {state.error && (
          <div className="break-words text-error" title={state.error}>
            Last fetch failed: {state.error.split('\n')[0]}
          </div>
        )}
        {message && (
          <div className={cn('break-words', message.error ? 'text-error' : 'text-success')}>
            {message.text}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-1.5">
        <span className="text-[10.5px] text-muted-foreground">
          {state.fetchedAt !== undefined
            ? `checked ${formatAgo(state.fetchedAt, Date.now(), { ago: true })}`
            : 'not fetched yet'}
        </span>
        <div className="flex items-center gap-1">
          <Button
            className={cn(buttonClass, 'text-muted-foreground')}
            data-sync-check
            disabled={checking || !!busy}
            onClick={check}
            size="sm"
            variant="ghost"
          >
            {checking ? (
              <LoaderCircleIcon className="size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3" />
            )}
            {checking ? 'Checking…' : 'Check now'}
          </Button>
          {item !== 'noupstream' && state.behind > 0 && (
            <Button
              className={buttonClass}
              data-sync-pull
              disabled={!!busy || (!!state.pullRefused && !state.merge)}
              onClick={() => act(state.merge ? 'merge' : 'pull')}
              size="sm"
              title={state.merge ? undefined : state.pullRefused}
              variant="outline"
            >
              {busy === 'pull' || busy === 'merge'
                ? state.merge
                  ? 'Asking…'
                  : 'Pulling…'
                : state.merge
                  ? 'Sync with @ultimate'
                  : 'Pull'}
            </Button>
          )}
          {item !== 'noupstream' && state.ahead > 0 && (
            <Button
              className={buttonClass}
              data-sync-push
              disabled={!!busy || !!state.pushRefused}
              onClick={() => act('push')}
              size="sm"
              title={state.pushRefused}
              variant="outline"
            >
              {busy === 'push' ? 'Pushing…' : 'Push'}
            </Button>
          )}
          {state.repo && state.ahead > 0 && (
            <Button
              className={buttonClass}
              data-sync-pr
              disabled={!!busy}
              onClick={() => act('pr')}
              size="sm"
              variant="outline"
            >
              {busy === 'pr' ? 'Opening…' : 'Open PR'}
            </Button>
          )}
        </div>
      </div>
    </>
  )
}

/** The status-line item: quiet while in sync, `↓N` / `↑N` otherwise. */
function Sync() {
  const { data: state, refetch } = useAction(
    StateAction,
    null,
    // A failed poll keeps the last state; the next one tries again.
    { onError: () => {}, every: 60_000 },
  )
  const [busy, setBusy] = useState<string>()
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<Message>()
  const { showSurface, switchConversation } = useUltimate()
  if (!state) return null
  const item = itemOf(state)
  if (item === 'none') return null
  const fail = (failure: unknown) =>
    setMessage({ error: true, text: failure instanceof Error ? failure.message : String(failure) })
  const check = () => {
    setChecking(true)
    setMessage(undefined)
    api
      .action(CheckAction)
      .catch(fail)
      // The check leaves its answer as the server's state.
      .finally(() => void refetch().finally(() => setChecking(false)))
  }
  const act = (name: 'pull' | 'push' | 'pr' | 'merge') => {
    setBusy(name)
    setMessage(undefined)
    const outcome = (text: string): Message => ({ error: false, text })
    const run: Promise<Message | undefined> =
      name === 'pull'
        ? api
            .action(PullAction)
            .then((result) =>
              !result.ok
                ? { error: true, text: result.refused }
                : outcome(
                    result.commits === 0
                      ? 'Already up to date'
                      : `${result.merged ? 'Merged' : 'Pulled'} ${plural(result.commits)} · ${result.from}..${result.to}${result.restore ? ` · undo: git reset --hard ${result.restore}` : ''}`,
                  ),
            )
        : name === 'push'
          ? api
              .action(PushAction)
              .then((result) =>
                result.ok
                  ? outcome(`Pushed to ${result.pushed}`)
                  : { error: true, text: result.refused },
              )
          : name === 'pr'
            ? api
                .action(PrAction)
                .then((result) =>
                  result.ok
                    ? outcome(`Opened ${result.url}`)
                    : { error: true, text: result.refused },
                )
            : api.action(MergeAction).then(({ id }) => {
                events.emit('ultimate:sent', { conversationId: id })
                showSurface('agent')
                switchConversation(id)
                return undefined
              })
    run
      .then(setMessage)
      .catch(fail)
      .finally(() => {
        setBusy(undefined)
        // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
        void refetch()
      })
  }
  const spinning = checking || !!busy
  const label =
    item === 'noupstream' ? (
      <>
        <span aria-hidden>·</span>
        <span className="max-md:hidden">no upstream</span>
      </>
    ) : item === 'current' ? (
      <>
        {spinning ? (
          <LoaderCircleIcon className="size-3 animate-spin" />
        ) : (
          <CheckIcon className="size-3" />
        )}
        <span className="max-md:hidden">in sync</span>
      </>
    ) : (
      <>
        {spinning ? (
          <LoaderCircleIcon className="size-3 animate-spin" />
        ) : warns(state) ? (
          <TriangleAlertIcon className="size-3" />
        ) : null}
        {state.ahead > 0 && (
          <span className="flex items-center">
            <ArrowUpIcon className="size-3" />
            {state.ahead}
          </span>
        )}
        {state.behind > 0 && (
          <span className="flex items-center">
            <ArrowDownIcon className="size-3" />
            {state.behind}
          </span>
        )}
      </>
    )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(
            statusButton,
            item === 'current' || item === 'noupstream'
              ? 'text-muted-foreground/70 hover:text-foreground'
              : warns(state)
                ? 'text-warning'
                : 'text-brand',
          )}
          data-sync
          title="Git sync: the project checkout against its upstream"
          type="button"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[26rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
        side="top"
      >
        <Popup
          act={act}
          busy={busy}
          check={check}
          checking={checking}
          message={message}
          state={state}
        />
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Sync, order: -1 }] },
})
