/** PR fit: how worth adopting each open upstream PR is for this fork, judged by Jev. Browser-safe. */
import { actionRef } from '../../../shared/extension-api.ts'

/**
 * One PR's verdict for this setup: `adopt` (pull it in now), `watch` (useful later or once upstream merges it), `skip`
 * (not useful here), or `ours` (the fork owner's own PR, not judged). `confidence` is Jev's for the verdict, `reason` one
 * line built from its answers, `head` the commit judged.
 */
export type Fit =
  | {
      verdict: 'adopt' | 'watch' | 'skip'
      confidence: number
      reason: string
      head: string
      at: string
    }
  | { verdict: 'ours'; head: string; at: string }

/** No arguments → the verdicts known so far by PR number; empty while classify is off. Judges new heads in the background. */
export const FitsAction = actionRef<null, Record<string, Fit>>('pr-fit', 'fits')
