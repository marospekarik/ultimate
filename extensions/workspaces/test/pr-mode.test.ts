import { expect, it } from 'vitest'
import { landerSettings } from '../lander.ts'
import { decidePolls, parsePr } from '../pr.ts'

const settings = (lander: unknown) =>
  landerSettings({ projectSettings: async () => ({ lander }) as never })

it('reads lander.pr next to checks', async () => {
  expect(
    await settings({ checks: ['pnpm check'], pr: { remote: 'origin', base: 'main' } }),
  ).toEqual({
    checks: [{ command: 'pnpm check' }],
    pr: { remote: 'origin', base: 'main' },
  })
  expect((await settings({})).pr).toBeUndefined()
})

it('refuses lander.pr together with lander.push, and a malformed pr', async () => {
  await expect(
    settings({ push: 'origin', pr: { remote: 'origin', base: 'main' } }),
  ).rejects.toThrow('lander.pr and lander.push cannot both be set')
  await expect(settings({ pr: 'origin' })).rejects.toThrow('lander.pr must be')
  expect(() => parsePr({ remote: 'origin' })).toThrow('lander.pr must be')
})

it('decides which open pull requests merged, closed or keep waiting', () => {
  const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  expect(decidePolls(entries, { a: 'MERGED', b: 'CLOSED', c: 'OPEN' })).toEqual({
    merged: ['a'],
    closed: ['b'],
    // d has no known state (its lookup failed): it waits.
    waiting: ['c', 'd'],
  })
})
