/** @jsxImportSource @solidjs/web */
import { expect, it } from 'vitest'
import { openChip } from './approval-harness.solid.tsx'

it('offers only Update with @ultimate when conflicts are predicted', async () => {
  const chip = await openChip({
    behind: 2,
    ahead: 3,
    diverged: true,
    conflicts: true,
    merge: true,
    refused: 'main has diverged from origin/main',
  })
  expect(chip.querySelector('[data-update-merge]')).not.toBeNull()
  expect(chip.querySelector('[data-update-now]')).toBeNull()
  expect(chip.textContent).toContain('would conflict: @ultimate can merge')
})
