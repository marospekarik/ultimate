/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { openChip } from './approval-harness.solid.tsx'

it('offers Update now for a diverged clone without predicted conflicts', async () => {
  const chip = await openChip({
    behind: 2,
    ahead: 3,
    diverged: true,
    conflicts: false,
    merge: true,
    refused: 'main has diverged from origin/main',
  })
  expect(chip.querySelector('[data-update-now]')?.hasAttribute('disabled')).toBe(false)
  expect(chip.querySelector('[data-update-merge]')).toBeNull()
  expect(chip.textContent).toContain('no conflicts expected')
})
