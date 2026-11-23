import type { JSX } from '@solidjs/web'
import { Show } from 'solid-js'
import { cn, defineWebExtension, definePoint, keepLast, provide, useAction } from '@/sdk/solid'
import { FitsAction } from './refs.ts'
import type { Fit } from './refs.ts'

type Place = 'row' | 'detail'

const PrMark = definePoint<{ number: number; place: Place }, JSX.Element>('pull-requests.mark')

const looks: Record<Fit['verdict'], { label: string; dot: string; text: string }> = {
  adopt: { label: 'worth adopting', dot: 'bg-success', text: 'text-success' },
  watch: { label: 'worth watching', dot: 'bg-warning', text: 'text-warning' },
  skip: {
    label: 'not for this setup',
    dot: 'bg-muted-foreground/40',
    text: 'text-muted-foreground',
  },
  ours: { label: 'ours', dot: 'border border-muted-foreground/60', text: 'text-muted-foreground' },
}

const summary = (fit: Fit) =>
  fit.verdict === 'ours'
    ? 'Your own PR: not judged.'
    : `${looks[fit.verdict].label} · ${Math.round(fit.confidence * 100)}%${fit.reason ? ` · ${fit.reason}` : ''}`

const judgement = (fit: Fit) =>
  fit.verdict === 'ours'
    ? ''
    : ` ${Math.round(fit.confidence * 100)}%${fit.reason ? ` · ${fit.reason}` : ''}`

function Mark(props: { number: number; place: Place }) {
  const fits = useAction(FitsAction, null, { every: 60_000, focus: true, onError: keepLast })
  const fit = () => fits.data()?.[props.number]
  return (
    <Show when={fit()}>
      {(known) => (
        <Show
          when={props.place === 'detail'}
          fallback={
            <Show when={known().verdict !== 'skip'}>
              <span
                aria-label={`Fit: ${summary(known())}`}
                class={cn('size-1.5 shrink-0 rounded-full', looks[known().verdict].dot)}
                title={`Fit: ${summary(known())}`}
              />
            </Show>
          }
        >
          <p class="mt-1.5 flex min-w-0 items-baseline gap-1.5 font-mono text-[11.5px] text-muted-foreground">
            <span
              class={cn(
                'relative top-[-1px] size-1.5 shrink-0 rounded-full',
                looks[known().verdict].dot,
              )}
            />
            <span class="min-w-0">
              <span class={looks[known().verdict].text}>fit: {known().verdict}</span>
              {judgement(known())}
            </span>
          </p>
        </Show>
      )}
    </Show>
  )
}

export default defineWebExtension({
  provides: [provide(PrMark, Mark)],
})
