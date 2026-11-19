/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { openChip } from './approval-harness.solid.tsx'

it('shows a merged update with its undo, and the fix ask when its check failed', async () => {
  const chip = await openChip({
    behind: 0,
    commits: [],
    updated: {
      ok: true,
      from: 'a1b2c3d',
      to: 'e4f5a6b',
      commits: 2,
      layers: { core: false, bin: false, lockfile: false, live: true },
      install: 'skipped',
      merged: true,
      restore: 'refs/ultimate-update/pre-a1b2c3d',
      check: 'failed',
      checkError: 'vp check: a type error',
      fixable: true,
    },
  })
  expect(chip.textContent).toContain('Merged a1b2c3d..e4f5a6b')
  expect(chip.textContent).toContain('pnpm check failed')
  expect(chip.textContent).toContain('vp check: a type error')
  expect(chip.querySelector('[data-update-fix]')).not.toBeNull()
  expect(chip.textContent).toContain('Undo: git reset --hard refs/ultimate-update/pre-a1b2c3d')
})
