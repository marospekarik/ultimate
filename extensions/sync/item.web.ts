import type { SyncState } from './refs.ts'

export function itemOf(
  state: SyncState,
): 'none' | 'noupstream' | 'current' | 'behind' | 'ahead' | 'diverged' {
  if (state.preview || !state.root) return 'none'
  if (!state.branch || !state.upstream) return 'noupstream'
  if (state.ahead && state.behind) return 'diverged'
  if (state.behind) return 'behind'
  if (state.ahead) return 'ahead'
  return 'current'
}

export const warns = (state: SyncState) =>
  Boolean(state.behind && state.pullRefused) || Boolean(state.error)
