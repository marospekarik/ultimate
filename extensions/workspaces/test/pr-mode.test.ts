import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { landerSettings } from '../lander.ts'
import { parsePr } from '../pr.ts'

const emptyHome = join(tmpdir(), 'no-user-home')
const settings = (lander: unknown) =>
  landerSettings({
    userHome: emptyHome,
    projectRoot: '/project',
    projectSettings: async () => ({ lander }) as never,
  })

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

it('lets the lander settings the user file holds for this project win over the project file, key by key', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'lander-user-'))
  try {
    await mkdir(join(userHome, '.ultimate'))
    await writeFile(
      join(userHome, '.ultimate/settings.json'),
      JSON.stringify({ landers: { '/project': { push: 'fork' }, '/other': { push: 'nowhere' } } }),
    )
    expect(
      await landerSettings({
        userHome,
        projectRoot: '/project',
        projectSettings: async () => ({ lander: { checks: ['pnpm check'], push: 'origin' } }),
      }),
    ).toEqual({ checks: [{ command: 'pnpm check' }], push: 'fork' })
  } finally {
    await rm(userHome, { recursive: true })
  }
})
