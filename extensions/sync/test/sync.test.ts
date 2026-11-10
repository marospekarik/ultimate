import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { git as runGit } from '../../../lib/git.ts'
import { gitIn, openPr, pull, push, stateOf } from '../sync.ts'
import type { Context, Run } from '../sync.ts'
import { temp } from '../../../test/helpers.ts'

const none: Context = { protectedBranches: [], targets: [] }
const direct = <T>(operation: () => Promise<T>) => operation()

/** A bare origin and two clones of it: `mine` (the checkout under test, on `main`) and `other` (a collaborator). */
async function repos() {
  const dir = await temp('ultimate-sync-')
  const origin = join(dir, 'origin.git')
  await runGit(dir, 'init', '--bare', '-b', 'main', origin)
  const clone = async (name: string) => {
    const path = join(dir, name)
    await runGit(dir, 'clone', '-q', origin, path)
    await runGit(path, 'config', 'user.email', 't@example.com')
    await runGit(path, 'config', 'user.name', 'T')
    return path
  }
  const other = await clone('other')
  await commit(other, 'a.txt', 'one\n', 'first')
  await runGit(other, 'push', '-q', 'origin', 'main')
  const mine = await clone('mine')
  await runGit(mine, 'remote', 'set-head', 'origin', '-a')
  return { origin, mine, other, git: gitIn(mine) }
}

async function commit(path: string, file: string, text: string, message: string) {
  await writeFile(join(path, file), text)
  await runGit(path, 'add', file)
  await runGit(path, 'commit', '-q', '-m', message)
}

const fetch = (path: string) => runGit(path, 'fetch', '-q', 'origin')

it('computes the state: in sync, behind, ahead, diverged, dirty, protected', async () => {
  const { mine, other, git } = await repos()
  expect(await stateOf(git, mine, none)).toMatchObject({ ahead: 0, behind: 0, dirty: false })
  await commit(other, 'a.txt', 'two\n', 'upstream change')
  await runGit(other, 'push', '-q', 'origin', 'main')
  await fetch(mine)
  const behind = await stateOf(git, mine, none)
  expect(behind).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 0, behind: 1 })
  expect(behind.commits[0].subject).toBe('upstream change')
  await runGit(mine, 'reset', '-q', '--hard', 'origin/main')
  await commit(mine, 'b.txt', 'b\n', 'mine')
  expect(await stateOf(git, mine, none)).toMatchObject({ ahead: 1, behind: 0 })
  await commit(other, 'c.txt', 'c\n', 'more upstream')
  await runGit(other, 'push', '-q', 'origin', 'main')
  await fetch(mine)
  expect(await stateOf(git, mine, none)).toMatchObject({
    ahead: 1,
    behind: 1,
    diverged: true,
    conflicts: false,
  })
  await writeFile(join(mine, 'a.txt'), 'dirty\n')
  const dirty = await stateOf(git, mine, { protectedBranches: ['main'], targets: [] })
  expect(dirty).toMatchObject({ dirty: true, protected: true })
  expect(dirty.pullRefused).toContain('uncommitted')
  expect(dirty.pushRefused).toContain('protected')
})

it('has no upstream state for a branch without one', async () => {
  const { mine, git } = await repos()
  await runGit(mine, 'checkout', '-q', '-b', 'topic')
  const state = await stateOf(git, mine, none)
  expect(state).toMatchObject({ branch: 'topic', ahead: 0, behind: 0 })
  expect(state.upstream).toBeUndefined()
})

it('pulls: refuses dirty, fast-forwards, merges a diverged branch with a restore ref', async () => {
  const { mine, other, git } = await repos()
  await commit(other, 'a.txt', 'two\n', 'upstream change')
  await runGit(other, 'push', '-q', 'origin', 'main')
  await writeFile(join(mine, 'a.txt'), 'dirty\n')
  expect(await pull(git, mine, direct)).toMatchObject({ ok: false })
  expect(await runGit(mine, 'status', '--porcelain', '-uno')).toContain('a.txt')
  await runGit(mine, 'checkout', '-q', 'a.txt')
  const forwarded = await pull(git, mine, direct)
  expect(forwarded).toMatchObject({ ok: true, commits: 1 })
  expect(await runGit(mine, 'rev-parse', 'HEAD')).toBe(await runGit(other, 'rev-parse', 'HEAD'))

  await commit(mine, 'b.txt', 'b\n', 'mine')
  await commit(other, 'c.txt', 'c\n', 'theirs')
  await runGit(other, 'push', '-q', 'origin', 'main')
  const merged = await pull(git, mine, direct)
  expect(merged).toMatchObject({ ok: true, merged: true })
  const restore = (merged as { restore: string }).restore
  expect(restore).toContain('refs/ultimate-update/pre-')
  expect(await runGit(mine, 'rev-parse', restore)).toBeTruthy()
  expect(await runGit(mine, 'rev-list', '--parents', '-1', 'HEAD')).toMatch(/ \w+ \w+/)
})

it('refuses a predicted conflict and leaves the branch untouched', async () => {
  const { mine, other, git } = await repos()
  await commit(mine, 'a.txt', 'mine\n', 'mine')
  await commit(other, 'a.txt', 'theirs\n', 'theirs')
  await runGit(other, 'push', '-q', 'origin', 'main')
  const before = await runGit(mine, 'rev-parse', 'HEAD')
  const result = await pull(git, mine, direct)
  expect(result).toMatchObject({ ok: false })
  expect(await runGit(mine, 'rev-parse', 'HEAD')).toBe(before)
  expect(await runGit(mine, 'for-each-ref', 'refs/ultimate-update')).toBe('')
  const state = await stateOf(git, mine, none)
  expect(state).toMatchObject({ conflicts: true, merge: true })
})

it('pushes without force and refuses protected, dirty and diverged branches', async () => {
  const { mine, other, origin, git } = await repos()
  await commit(mine, 'b.txt', 'b\n', 'mine')
  expect(await push(git, mine, { protectedBranches: ['main'], targets: [] })).toMatchObject({
    ok: false,
    refused: expect.stringContaining('protected'),
  })
  await writeFile(join(mine, 'a.txt'), 'dirty\n')
  expect(await push(git, mine, none)).toMatchObject({ ok: false })
  await runGit(mine, 'checkout', '-q', 'a.txt')
  expect(await push(git, mine, none)).toEqual({ ok: true, pushed: 'origin/main' })
  expect(await runGit(origin, 'rev-parse', 'main')).toBe(await runGit(mine, 'rev-parse', 'HEAD'))
  await commit(mine, 'd.txt', 'd\n', 'again')
  await commit(other, 'c.txt', 'c\n', 'theirs')
  await runGit(other, 'pull', '-q', '--no-rebase', 'origin', 'main')
  await runGit(other, 'push', '-q', 'origin', 'main')
  await fetch(mine)
  expect(await push(git, mine, none)).toMatchObject({
    ok: false,
    refused: expect.stringContaining('diverged'),
  })
})

it('opens a PR with gh against the base, from the latest commit subject', async () => {
  const { mine, origin, git } = await repos()
  await runGit(mine, 'remote', 'set-url', 'origin', 'git@github.com-work:owner/repo.git')
  await runGit(mine, 'remote', 'set-url', '--push', 'origin', origin)
  await runGit(mine, 'checkout', '-q', '-b', 'topic')
  await commit(mine, 'b.txt', 'b\n', 'Add the b file')
  const calls: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  const run: Run = async (file, args, options) => {
    calls.push({ file, args, env: options.env })
    return { stdout: 'https://github.com/owner/repo/pull/7\n' }
  }
  const context = { protectedBranches: ['main'], targets: ['main'] }
  expect(await openPr(git, mine, context, run)).toEqual({
    ok: true,
    url: 'https://github.com/owner/repo/pull/7',
  })
  expect(calls[0].file).toBe('gh')
  expect(calls[0].args).toEqual([
    'pr',
    'create',
    '--repo',
    'owner/repo',
    '--base',
    'main',
    '--head',
    'topic',
    '--title',
    'Add the b file',
    '--body',
    '',
  ])
  expect(calls[0].env.GIT_TERMINAL_PROMPT).toBe('0')
  expect(await runGit(origin, 'rev-parse', 'topic')).toBe(await runGit(mine, 'rev-parse', 'HEAD'))
  // The base branch itself has no PR to open.
  await runGit(mine, 'checkout', '-q', 'main')
  expect(await openPr(git, mine, context, run)).toMatchObject({ ok: false })
  expect(calls).toHaveLength(1)
})
