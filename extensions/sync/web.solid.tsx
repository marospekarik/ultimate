import { ArrowDown, ArrowUp, Check, LoaderCircle, RefreshCw, TriangleAlert } from '@lucide/solid'
import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  events,
  formatAgo,
  keepLast,
  showSurface,
  switchConversation,
  useAction,
} from '@/sdk/solid'
import { itemOf, warns } from './item.web.ts'
import { CheckAction, MergeAction, PrAction, PullAction, PushAction, StateAction } from './refs.ts'
import type { SyncState } from './refs.ts'

const short = (root: string) => root.replace(/^\/(?:home|Users)\/[^/]+/, '~')
const plural = (count: number) => `${count} ${count === 1 ? 'commit' : 'commits'}`

type Message = { error: boolean; text: string }
type Name = 'pull' | 'push' | 'pr' | 'merge'

const buttonClass = 'h-7 font-sans text-[12px]'
const spinner = () => <LoaderCircle class="size-3 animate-spin" />

function Popup(props: {
  state: SyncState
  busy: string | undefined
  checking: boolean
  message?: Message
  check: () => void
  act: (name: Name) => void
}) {
  const state = () => props.state
  const item = () => itemOf(state())
  const upstream = () => state().upstream ?? ''
  return (
    <>
      <div class="border-b border-border/70 px-3 py-2 text-[11.5px]">
        <div class="section-label">Git sync</div>
        <div class="truncate text-muted-foreground" title={state().root}>
          {short(state().root ?? '')}
        </div>
      </div>
      <div class="space-y-2 px-3 py-2 text-[11.5px] leading-[1.55]" data-sync-body>
        <Show
          when={item() !== 'noupstream'}
          fallback={
            <div>
              {state().branch ? (
                <>
                  {state().branch} has no upstream. Set one with{' '}
                  <span class="text-foreground/85">
                    git branch --set-upstream-to=origin/{state().branch}
                  </span>{' '}
                  (or push it once with <span class="text-foreground/85">git push -u origin</span>
                  ), and this item will show where it stands.
                </>
              ) : (
                'The checkout is on a detached HEAD: check out a branch to sync it.'
              )}
            </div>
          }
        >
          <div>
            {item() === 'current' ? (
              <>
                {state().branch} is <span class="text-success">in sync</span> with {upstream()}
              </>
            ) : (
              <>
                {state().branch} is {state().ahead > 0 && plural(state().ahead) + ' ahead of'}
                {state().ahead > 0 && state().behind > 0 && ' and '}
                {state().behind > 0 && `${plural(state().behind)} behind`} {upstream()}
              </>
            )}
          </div>
          <Show when={state().commits.length > 0}>
            <ul class="space-y-0.5">
              <For each={state().commits}>
                {(commit) => (
                  <li class="flex min-w-0 gap-2">
                    <span class="shrink-0 text-muted-foreground">{commit.sha}</span>
                    <span class="truncate text-foreground/85" title={commit.subject}>
                      {commit.subject}
                    </span>
                  </li>
                )}
              </For>
              <Show when={state().behind > state().commits.length}>
                <li class="text-muted-foreground">
                  … {state().behind - state().commits.length} more
                </li>
              </Show>
            </ul>
          </Show>
          <Show when={state().diverged}>
            <div data-sync-diverged>
              {state().conflicts === true
                ? 'Merging would conflict: @ultimate can merge it on a branch and land it once the checks pass.'
                : state().conflicts === false
                  ? 'Pull merges them; no conflicts expected.'
                  : 'Pull merges them and stops on any conflict.'}
            </div>
          </Show>
          <Show when={state().behind > 0 && state().pullRefused}>
            <div class="flex items-start gap-1.5 text-warning">
              <TriangleAlert class="mt-0.5 size-3 shrink-0" />
              <span>Can't pull: {state().pullRefused}. Nothing was stashed, rebased or reset.</span>
            </div>
          </Show>
          <Show when={state().ahead > 0 && state().pushRefused}>
            <div class="text-muted-foreground" data-sync-push-refused>
              Can't push: {state().pushRefused}.
              {state().protected && state().repo && state().base && state().base !== state().branch
                ? ` Open PR sends it to ${state().base}.`
                : ''}
            </div>
          </Show>
        </Show>
        <Show when={state().error}>
          {(error) => (
            <div class="break-words text-error" title={error()}>
              Last fetch failed: {error().split('\n')[0]}
            </div>
          )}
        </Show>
        <Show when={props.message}>
          {(message) => (
            <div class={cn('break-words', message().error ? 'text-error' : 'text-success')}>
              {message().text}
            </div>
          )}
        </Show>
      </div>
      <div class="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-1.5">
        <span class="text-[10.5px] text-muted-foreground">
          {state().fetchedAt !== undefined
            ? `checked ${formatAgo(state().fetchedAt!, Date.now(), { ago: true })}`
            : 'not fetched yet'}
        </span>
        <div class="flex items-center gap-1">
          <Button
            class={cn(buttonClass, 'text-muted-foreground')}
            data-sync-check
            disabled={props.checking || !!props.busy}
            onClick={props.check}
            size="sm"
            variant="ghost"
          >
            {props.checking ? spinner() : <RefreshCw class="size-3" />}
            {props.checking ? 'Checking…' : 'Check now'}
          </Button>
          <Show when={item() !== 'noupstream' && state().behind > 0}>
            <Button
              class={buttonClass}
              data-sync-pull
              disabled={!!props.busy || (!!state().pullRefused && !state().merge)}
              onClick={() => props.act(state().merge ? 'merge' : 'pull')}
              size="sm"
              title={state().merge ? undefined : state().pullRefused}
              variant="outline"
            >
              {props.busy === 'pull' || props.busy === 'merge'
                ? state().merge
                  ? 'Asking…'
                  : 'Pulling…'
                : state().merge
                  ? 'Sync with @ultimate'
                  : 'Pull'}
            </Button>
          </Show>
          <Show when={item() !== 'noupstream' && state().ahead > 0}>
            <Button
              class={buttonClass}
              data-sync-push
              disabled={!!props.busy || !!state().pushRefused}
              onClick={() => props.act('push')}
              size="sm"
              title={state().pushRefused}
              variant="outline"
            >
              {props.busy === 'push' ? 'Pushing…' : 'Push'}
            </Button>
          </Show>
          <Show when={state().repo && state().ahead > 0}>
            <Button
              class={buttonClass}
              data-sync-pr
              disabled={!!props.busy}
              onClick={() => props.act('pr')}
              size="sm"
              variant="outline"
            >
              {props.busy === 'pr' ? 'Opening…' : 'Open PR'}
            </Button>
          </Show>
        </div>
      </div>
    </>
  )
}

function Sync() {
  const { data, refetch } = useAction(StateAction, null, {
    onError: keepLast,
    every: 60_000,
  })
  const [busy, setBusy] = createSignal<string>()
  const [checking, setChecking] = createSignal(false)
  const [message, setMessage] = createSignal<Message>()
  const item = createMemo(() => {
    const state = data()
    return state ? itemOf(state) : 'none'
  })
  const fail = (failure: unknown) => setMessage({ error: true, text: errorMessage(failure) })
  const check = () => {
    setChecking(true)
    setMessage(undefined)
    api
      .action(CheckAction, null)
      .catch(fail)
      .finally(() => void refetch().finally(() => setChecking(false)))
  }
  const act = (name: Name) => {
    setBusy(name)
    setMessage(undefined)
    const outcome = (text: string): Message => ({ error: false, text })
    const run: Promise<Message | undefined> =
      name === 'pull'
        ? api
            .action(PullAction, null)
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
              .action(PushAction, null)
              .then((result) =>
                result.ok
                  ? outcome(`Pushed to ${result.pushed}`)
                  : { error: true, text: result.refused },
              )
          : name === 'pr'
            ? api
                .action(PrAction, null)
                .then((result) =>
                  result.ok
                    ? outcome(`Opened ${result.url}`)
                    : { error: true, text: result.refused },
                )
            : api.action(MergeAction, null).then(({ id }) => {
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
        void refetch()
      })
  }
  const spinning = () => checking() || !!busy()
  return (
    <Show when={item() !== 'none' && data()}>
      {(state) => (
        <Popover>
          <StatusPopoverTrigger
            class={cn(
              'cursor-pointer data-open:bg-transparent hover:data-open:bg-accent',
              item() === 'current' || item() === 'noupstream'
                ? 'text-muted-foreground/70 data-open:text-muted-foreground/70 hover:data-open:text-foreground'
                : warns(state())
                  ? 'text-warning hover:text-warning data-open:text-warning'
                  : 'text-brand hover:text-brand data-open:text-brand',
            )}
            data-sync
            title="Git sync: the project checkout against its upstream"
            type="button"
          >
            <Switch>
              <Match when={item() === 'noupstream'}>
                <span aria-hidden="true">·</span>
                <span class="max-md:hidden">no upstream</span>
              </Match>
              <Match when={item() === 'current'}>
                {spinning() ? spinner() : <Check class="size-3" />}
                <span class="max-md:hidden">in sync</span>
              </Match>
              <Match when={true}>
                {spinning() ? spinner() : warns(state()) ? <TriangleAlert class="size-3" /> : null}
                <Show when={state().ahead > 0}>
                  <span class="flex items-center">
                    <ArrowUp class="size-3" />
                    {state().ahead}
                  </span>
                </Show>
                <Show when={state().behind > 0}>
                  <span class="flex items-center">
                    <ArrowDown class="size-3" />
                    {state().behind}
                  </span>
                </Show>
              </Match>
            </Switch>
          </StatusPopoverTrigger>
          <PopoverContent
            align="end"
            class="w-[26rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
            side="top"
          >
            <Popup
              act={act}
              busy={busy()}
              check={check}
              checking={checking()}
              message={message()}
              state={state()}
            />
          </PopoverContent>
        </Popover>
      )}
    </Show>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Sync, order: -1 }] },
})
