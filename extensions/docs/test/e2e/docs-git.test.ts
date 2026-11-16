import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { JsonValue } from '@earendil-works/chord/json'
import type { ActionContext } from '../../../../server/actions.ts'
import { git } from '../../../../lib/git.ts'
import { temp } from '../../../../test/helpers.ts'
import { actions, commentsText } from '../../server.ts'

async function repo() {
  const root = await temp('docs-git-')
  await git(root, 'init', '-q')
  await mkdir(join(root, 'docs/.private'), { recursive: true })
  await mkdir(join(root, '.claude'))
  await writeFile(join(root, 'README.md'), '# Hello')
  await writeFile(join(root, 'docs/a.md'), '# A')
  await writeFile(join(root, 'docs/.private/b.md'), '# B')
  await writeFile(join(root, '.claude/c.md'), '# C')
  await writeFile(join(root, 'untracked.md'), '# U')
  await writeFile(join(root, 'secret.md'), 'secret')
  await symlink(join(root, 'secret.md'), join(root, 'link.md'))
  await git(root, 'add', 'README.md', 'docs', '.claude', 'link.md')
  return { host: { projectRoot: root } }
}

const call = (name: 'list' | 'read', host: unknown, args: JsonValue = null) =>
  actions[name](args, { host } as ActionContext)

it('lists only tracked Markdown without dot segments', async () => {
  const { host } = await repo()
  expect(await call('list', host)).toEqual(['README.md', 'docs/a.md', 'link.md'])
})

it('reads a listed doc, and says missing for anything else', async () => {
  const { host } = await repo()
  expect(await call('read', host, { path: 'docs/a.md' })).toMatchObject({
    status: 'ok',
    body: '# A',
  })
  for (const path of [
    'untracked.md',
    'docs/.private/b.md',
    '.claude/c.md',
    'docs/gone.md',
    'link.md',
  ])
    expect(await call('read', host, { path })).toEqual({ status: 'missing', path })
})

it('lists nothing outside a git repository', async () => {
  const root = await temp('docs-nogit-')
  expect(await call('list', { projectRoot: root })).toEqual([])
})

it('tells the recipient where to read a report', () => {
  const text = commentsText(
    { path: '.reports/x.md', comments: [{ text: 'Why?', heading: 'Setup' }] },
    '/home/u/.ultimate/reports/p/x.md',
  )
  expect(text).toContain('the report `/home/u/.ultimate/reports/p/x.md`')
  expect(text).toContain('Under "Setup"')
})
