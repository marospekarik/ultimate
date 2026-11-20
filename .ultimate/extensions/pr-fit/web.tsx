import type { ReactNode } from 'react'
import { cn, defineWebExtension, definePoint, keepLast, provide, useAction } from '@/sdk'
import { FitsAction } from './refs.ts'
import type { Fit } from './refs.ts'

const PrMark = definePoint<{ number: number; place: 'row' | 'detail' }, ReactNode>(
  'pull-requests.mark',
)

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

function useFit(number: number) {
  const fits = useAction(FitsAction, null, { every: 60_000, focus: true, onError: keepLast })
  return fits.data?.[number]
}

function Mark({ number, place }: { number: number; place: 'row' | 'detail' }) {
  const fit = useFit(number)
  if (!fit) return null
  const look = looks[fit.verdict]
  if (place === 'row')
    return fit.verdict === 'skip' ? null : (
      <span
        aria-label={`Fit: ${summary(fit)}`}
        className={cn('size-1.5 shrink-0 rounded-full', look.dot)}
        title={`Fit: ${summary(fit)}`}
      />
    )
  return (
    <p className="mt-1.5 flex min-w-0 items-baseline gap-1.5 font-mono text-[11.5px] text-muted-foreground">
      <span className={cn('relative top-[-1px] size-1.5 shrink-0 rounded-full', look.dot)} />
      <span className="min-w-0">
        <span className={look.text}>fit: {fit.verdict}</span>
        {fit.verdict !== 'ours' && (
          <>
            {' '}
            {Math.round(fit.confidence * 100)}%{fit.reason && ` · ${fit.reason}`}
          </>
        )}
      </span>
    </p>
  )
}

export default defineWebExtension({
  provides: [provide(PrMark, (input) => <Mark number={input.number} place={input.place} />)],
})
