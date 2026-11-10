import type { SyncState } from './refs.ts'

/**
 * Which status-line item the state shows: none for a preview or outside Git, `noupstream` for a branch without an
 * upstream (or a detached HEAD), else by how the branch stands: `current`, `behind`, `ahead` or `diverged`.
 */
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

/** Whether the item warns: a pull that would be refused, or a failing fetch. */
export const warns = (state: SyncState) =>
  Boolean(state.behind && state.pullRefused) || Boolean(state.error)
