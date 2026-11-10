import { join } from 'node:path'
import { expect, it } from 'vitest'
import { projectIdentity, projectKey } from '../lib/project-identity.ts'
import { git } from '../lib/git.ts'
import { temp } from './helpers.ts'

it.each([
  ['git@github.com:o/r.git', 'github.com/o/r'],
  ['ssh://git@github.com/o/r', 'github.com/o/r'],
  ['https://user:tok@github.com/o/r.git', 'github.com/o/r'],
  ['https://github.com/O/R/', 'github.com/o/r'],
  ['https://github.com/HazAT/poe2-rust.git/', 'github.com/hazat/poe2-rust'],
  ['git@github.com-work:o/r.git', 'github.com/o/r'],
  ['ssh://git@github.com-work/owner/R.git', 'github.com/owner/r'],
  ['git+ssh://git@github.com/o/my.repo.git\n', 'github.com/o/my.repo'],
])('normalises %s', (remote, key) => {
  expect(projectKey(remote)).toBe(key)
})

it.each([
  'git@gitlab.com:o/r.git',
  'https://github.company.com/o/r',
  'https://notgithub.com/o/r',
  'https://github.com/o',
  'https://github.com/o/r/tree/main',
  'git@github.com.evil:o/r.git',
  '/srv/git/r.git',
  '',
])('has no key for %j', (remote) => {
  expect(projectKey(remote)).toBeUndefined()
})

it('reads the origin and oldest root commit, from a worktree too, and nothing without a GitHub origin', async () => {
  const main = await temp('ultimate-identity-')
  const worktree = join(await temp('ultimate-identity-worktree-'), 'checkout')
  const commit = (message: string) =>
    git(
      main,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit',
      '--allow-empty',
      '-m',
      message,
    )
  await git(main, 'init', '-b', 'main')
  expect(await projectIdentity(main)).toBeUndefined()
  await commit('root')
  const root = (await git(main, 'rev-parse', 'HEAD')).trim()
  await commit('second')
  expect(await projectIdentity(main)).toBeUndefined()
  await git(main, 'remote', 'add', 'origin', 'https://gitlab.com/o/r.git')
  expect(await projectIdentity(main)).toBeUndefined()
  await git(main, 'remote', 'set-url', 'origin', 'git@github.com:HazAT/Ultimate.git')
  await git(main, 'worktree', 'add', worktree, '-b', 'branch')
  for (const checkout of [main, worktree])
    expect(await projectIdentity(checkout)).toEqual({
      key: 'github.com/hazat/ultimate',
      rootCommit: root,
    })
  expect(await projectIdentity(await temp('ultimate-identity-none-'))).toBeUndefined()
})
