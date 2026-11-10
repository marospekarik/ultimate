import { expect, it } from 'vitest'
import { itemOf, warns } from '../../item.ts'
import type { SyncState } from '../../refs.ts'

const state = (extra: Partial<SyncState> = {}): SyncState => ({
  root: '/repo',
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  dirty: false,
  commits: [],
  protected: false,
  ...extra,
})

it('picks the item by how the branch stands', () => {
  expect(itemOf(state())).toBe('current')
  expect(itemOf(state({ behind: 2 }))).toBe('behind')
  expect(itemOf(state({ ahead: 2 }))).toBe('ahead')
  expect(itemOf(state({ ahead: 1, behind: 1 }))).toBe('diverged')
  expect(itemOf(state({ upstream: undefined }))).toBe('noupstream')
  expect(itemOf(state({ preview: true }))).toBe('none')
  expect(itemOf(state({ root: undefined }))).toBe('none')
})

it('warns only when a pull would be refused or a fetch failed', () => {
  expect(warns(state({ behind: 1 }))).toBe(false)
  expect(warns(state({ behind: 1, pullRefused: 'dirty' }))).toBe(true)
  expect(warns(state({ error: 'fetch failed' }))).toBe(true)
})
