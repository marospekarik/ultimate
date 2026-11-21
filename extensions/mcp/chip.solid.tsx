/** @jsxImportSource @solidjs/web */
import { LoaderCircle, Pin, Plug, RefreshCw } from '@lucide/solid'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { Toggle } from '@/components/ui/toggle.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import { Switch } from '@/components/ui/switch.solid.tsx'
import {
  ROOT,
  api,
  cn,
  errorMessage,
  events,
  keepLast,
  useAction,
  useEvent,
  useNow,
  writingAs,
} from '@/sdk/solid'
import { ChooseAction, ReconnectAction, StatusAction } from './refs.ts'
import type { McpServerStatus } from './refs.ts'

const settling = (servers: McpServerStatus[] | undefined) => {
  if (servers?.some((server) => server.state === 'connecting')) return 2_000
  const retryAt = Math.min(...(servers ?? []).map((server) => server.retryAt ?? Infinity))
  return Math.min(60_000, Math.max(2_000, retryAt - Date.now() + 500))
}

function useServers() {
  const { data: servers, refetch } = useAction(StatusAction, null, {
    conversation: ROOT,
    onError: keepLast,
    every: settling,
  })
  const refresh = () => void refetch()
  return { servers, refresh }
}

const tone = {
  connected: 'bg-success',
  connecting: 'bg-muted-foreground/50',
  failed: 'bg-error',
  off: 'border border-muted-foreground/60',
}

function Row(props: { server: McpServerStatus; refresh: () => void }) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const now = useNow(1_000, () => props.server.retryAt !== undefined)
  const retry = () => Math.max(0, Math.ceil((props.server.retryAt! - now()) / 1000))
  const connecting = () => busy() || props.server.state === 'connecting'
  const off = () => props.server.state === 'off'
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await work()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
      props.refresh()
    }
  }
  const reconnect = () => {
    const name = props.server.name
    return run(() => api.action(ReconnectAction, { name }, { conversationId: ROOT }))
  }
  const choose = (change: { enabled: boolean } | { only: boolean }) => {
    const name = props.server.name
    void run(() => api.action(ChooseAction, { name, ...change }, { conversationId: ROOT }))
  }
  useEvent('secrets:changed', (data) => {
    if (
      props.server.missing &&
      (data as { name?: unknown } | undefined)?.name === props.server.missing
    )
      void writingAs('app', reconnect)
  })
  return (
    <li class="px-2 py-1.5" data-mcp-server={props.server.name} data-state={props.server.state}>
      <div class="flex items-center gap-2 text-[12px]">
        <span class={cn('size-1.5 shrink-0 rounded-full', tone[props.server.state])} />
        <span
          class={cn('min-w-0 truncate', off() ? 'text-muted-foreground' : 'text-foreground/90')}
        >
          {props.server.name}
        </span>
        <span class="shrink-0 text-[10.5px] text-muted-foreground/70">
          {props.server.transport}
          {props.server.source === 'project' && ' · project'}
        </span>
        <span class="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {props.server.state === 'connected'
            ? `${props.server.tools} ${props.server.tools === 1 ? 'tool' : 'tools'}`
            : props.server.state}
        </span>
        <Show when={!off()}>
          <Toggle
            aria-label={`Only in this project: ${props.server.name}`}
            pressed={props.server.only ?? false}
            class="rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground data-pressed:bg-transparent data-pressed:text-foreground data-pressed:hover:bg-accent"
            disabled={busy()}
            onPressedChange={(only) => choose({ only })}
            size={null}
            title={
              props.server.only
                ? 'Pinned to its projects: click to run everywhere'
                : 'Only in this project'
            }
            variant={null}
          >
            <Pin class="size-3 in-data-pressed:fill-current" />
          </Toggle>
          <Button
            aria-label={`Reconnect ${props.server.name}`}
            class="rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            disabled={connecting()}
            onClick={reconnect}
            size={null}
            title="Reconnect"
            variant={null}
          >
            <Show when={connecting()} fallback={<RefreshCw class="size-3" />}>
              <LoaderCircle class="size-3 animate-spin" />
            </Show>
          </Button>
        </Show>
        <Switch
          aria-label={`${props.server.name} in this project`}
          checked={!off()}
          disabled={busy()}
          onCheckedChange={(enabled) => choose({ enabled })}
        />
      </div>
      <Show when={error() ?? props.server.error}>
        <p class="mt-0.5 line-clamp-3 pl-3.5 text-[11px] leading-snug break-words text-error/85">
          {error() ?? props.server.error}
          <Show when={props.server.retryAt !== undefined && !error()}>
            <span class="text-muted-foreground/70"> · retry in {retry()}s</span>
          </Show>
        </p>
      </Show>
      <Show when={props.server.missing}>
        {(missing) => (
          <Button
            class="mt-1 ml-3.5 rounded-sm border border-border px-1.5 py-0.5 text-[11px] font-normal text-foreground/90 transition-colors hover:bg-accent"
            onClick={() => events.emit('secrets:open', { name: missing() })}
            size={null}
            variant={null}
          >
            Add {missing()}
          </Button>
        )}
      </Show>
    </li>
  )
}

function Servers(props: { servers?: McpServerStatus[]; refresh: () => void }) {
  return (
    <ul class="flex flex-col font-mono">
      <For each={props.servers} keyed={(server) => server.name}>
        {(server) => <Row refresh={props.refresh} server={server()} />}
      </For>
    </ul>
  )
}

export function Chip() {
  const { servers, refresh } = useServers()
  const connected = createMemo(
    () => servers()?.filter((server) => server.state === 'connected').length ?? 0,
  )
  const failed = createMemo(() => servers()?.some((server) => server.state === 'failed'))
  const total = () => servers()?.filter((server) => server.state !== 'off').length ?? 0
  return (
    <Show when={servers()?.length}>
      <Popover>
        <StatusPopoverTrigger
          aria-label="MCP servers"
          class={cn(failed() && 'text-error')}
          data-mcp={
            failed()
              ? 'failed'
              : !total()
                ? 'off'
                : connected() === total()
                  ? 'connected'
                  : 'connecting'
          }
        >
          <Plug class="size-3" />
          {total() ? `mcp ${connected()}/${total()}` : 'mcp off'}
        </StatusPopoverTrigger>
        <PopoverContent align="end" class="w-80 max-w-[calc(100vw-1rem)] p-1" side="top">
          <Servers refresh={refresh} servers={servers()} />
          <p class="border-t border-border/70 px-2 pt-1.5 pb-1 font-mono text-[11px] text-muted-foreground/70">
            mcpServers in ~/.ultimate/settings.json or the project's .ultimate/settings.json
          </p>
        </PopoverContent>
      </Popover>
    </Show>
  )
}

export function Details(props: { name: string }) {
  return (
    <Show when={props.name === 'mcp'}>
      <ServerDetails />
    </Show>
  )
}

function ServerDetails() {
  const { servers, refresh } = useServers()
  return (
    <Show
      when={servers()?.length}
      fallback={<p class="text-muted-foreground/70">no servers: add mcpServers to settings.json</p>}
    >
      <Servers refresh={refresh} servers={servers()} />
    </Show>
  )
}
