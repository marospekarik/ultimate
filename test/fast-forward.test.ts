import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  fastForwardUpstream,
  fetchOrigin,
  otherTransport,
  Refusal,
  standingUpstream,
} from '../lib/fast-forward.ts'
import { git as runGit } from '../lib/git.ts'
import { temp } from './helpers.ts'

it('swaps a GitHub remote to the other transport and leaves others alone', () => {
  expect(otherTransport('git@github.com:o/r.git')).toBe('https://github.com/o/r.git')
  expect(otherTransport('git@github.com:o/r')).toBe('https://github.com/o/r.git')
  expect(otherTransport('ssh://git@github.com/o/r.git')).toBe('https://github.com/o/r.git')
  expect(otherTransport('https://github.com/o/r.git')).toBe('git@github.com:o/r.git')
  expect(otherTransport('https://github.com/o/r/')).toBe('git@github.com:o/r.git')
  expect(otherTransport('https://user@github.com/o/r')).toBe('git@github.com:o/r.git')
  expect(otherTransport('git@gitlab.com:o/r.git')).toBeUndefined()
  expect(otherTransport('git@github.com-work:owner/r.git')).toBe('https://github.com/owner/r.git')
  expect(otherTransport('/srv/repo.git')).toBeUndefined()
  expect(otherTransport('git@github.com.evil:o/r.git')).toBeUndefined()
})

/** A git that fails the commands `fail` matches and records every call. */
function stub(answers: Record<string, string>, fail: (args: string[]) => boolean) {
  const calls: string[] = []
  const git = async (...args: string[]) => {
    const call = args.join(' ')
    calls.push(call)
    if (fail(args)) throw new Error(`git ${args[0]} failed: denied ${call}`)
    return answers[call] ?? ''
  }
  return { git, calls }
}

it('fetches origin alone when it works', async () => {
  const { git, calls } = stub({}, () => false)
  await fetchOrigin(git)
  expect(calls).toEqual(['fetch --quiet origin'])
})

it('retries over HTTPS into origin refs and sets a missing origin/HEAD from it', async () => {
  const alt = 'https://github.com/o/r.git'
  const { git, calls } = stub(
    {
      'remote get-url origin': 'git@github.com:o/r.git',
      [`ls-remote --symref ${alt} HEAD`]: 'ref: refs/heads/main\tHEAD\nabc\tHEAD',
    },
    (args) =>
      args.join(' ') === 'fetch --quiet origin' ||
      args.join(' ') === 'symbolic-ref --quiet refs/remotes/origin/HEAD',
  )
  await fetchOrigin(git)
  expect(calls).toEqual([
    'fetch --quiet origin',
    'remote get-url origin',
    `fetch --quiet ${alt} +refs/heads/*:refs/remotes/origin/*`,
    'symbolic-ref --quiet refs/remotes/origin/HEAD',
    `ls-remote --symref ${alt} HEAD`,
    'symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main',
  ])
})

it('keeps an existing origin/HEAD after a fallback', async () => {
  const { git, calls } = stub(
    {
      'remote get-url origin': 'https://github.com/o/r.git',
      'symbolic-ref --quiet refs/remotes/origin/HEAD': 'refs/remotes/origin/main',
    },
    (args) => args.join(' ') === 'fetch --quiet origin',
  )
  await fetchOrigin(git)
  expect(calls.at(-2)).toBe(
    'fetch --quiet git@github.com:o/r.git +refs/heads/*:refs/remotes/origin/*',
  )
  expect(calls).not.toContain('ls-remote --symref git@github.com:o/r.git HEAD')
})

it('names both causes when both transports fail', async () => {
  const { git } = stub(
    { 'remote get-url origin': 'git@github.com:o/r.git' },
    (args) => args[0] === 'fetch',
  )
  await expect(fetchOrigin(git)).rejects.toThrow(
    /denied fetch --quiet origin\nRetry over https:\/\/github\.com\/o\/r\.git: .*denied fetch --quiet https/,
  )
})

it('rethrows the first failure for a remote off GitHub', async () => {
  const { git, calls } = stub(
    { 'remote get-url origin': '/srv/repo.git' },
    (args) => args[0] === 'fetch',
  )
  await expect(fetchOrigin(git)).rejects.toThrow('denied fetch --quiet origin')
  expect(calls).toEqual(['fetch --quiet origin', 'remote get-url origin'])
})

/** A repository in `origin`'s directory whose clone (with an upstream) `clone` returns, committed and clean. */
async function repo() {
  const origin = await temp('ultimate-fast-forward-')
  const path = await temp('ultimate-fast-forward-clone-')
  const author = ['-c', 'user.name=T', '-c', 'user.email=t@example.com']
  const init = () =>
    runGit(origin, ...author, 'commit', '--allow-empty', '-m', Math.random().toString())
  await runGit(origin, 'init', '-q', '--initial-branch=main', '.').catch(() =>
    runGit(origin, 'init', '-q', '.'),
  )
  await init()
  await runGit(origin, 'branch', '-m', 'main').catch(() => undefined)
  await runGit(path, 'clone', '-q', origin, '.')
  return { origin, path, author, init }
}

it('stands against the branch upstream: current, behind, diverged, dirty, none', async () => {
  const { path, author, init } = await repo()
  expect(await standingUpstream((...args) => runGit(path, ...args))).toEqual({
    branch: 'main',
    remote: 'origin/main',
    ahead: 0,
    behind: 0,
  })
  await init()
  await runGit(path, 'fetch', '-q')
  expect(await standingUpstream((...args) => runGit(path, ...args))).toMatchObject({
    branch: 'main',
    remote: 'origin/main',
    ahead: 0,
    behind: 1,
  })
  await runGit(path, ...author, 'commit', '--allow-empty', '-m', 'own')
  expect(await standingUpstream((...args) => runGit(path, ...args))).toMatchObject({
    ahead: 1,
    behind: 1,
    diverged: true,
    refused: 'main has diverged from origin/main',
  })
  await runGit(path, 'checkout', '-q', '-b', 'feature')
  expect((await standingUpstream((...args) => runGit(path, ...args))).refused).toMatch(
    /feature has no upstream/,
  )
  await runGit(path, 'checkout', '-q', 'main')
  await writeFile(join(path, 'dirty.txt'), 'staged\n')
  await runGit(path, 'add', 'dirty.txt')
  expect((await standingUpstream((...args) => runGit(path, ...args))).refused).toBe(
    'The checkout has uncommitted changes',
  )
})

it('fast-forwards the current branch to its upstream, and refuses what standingUpstream refuses', async () => {
  const { origin, path } = await repo()
  await runGit(
    origin,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'remote work',
  )
  const moved = await fastForwardUpstream((...args) => runGit(path, ...args))
  // `behind` is what moved; `after` is where the branch landed.
  expect(moved).toMatchObject({ branch: 'main', remote: 'origin/main', ahead: 0, behind: 1 })
  expect(moved.after).not.toBe(moved.before)
  expect(moved.lockfile).toBe(false)
  await runGit(
    origin,
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'more remote work',
  )
  await expect(
    fastForwardUpstream(
      (...args) => runGit(path, ...args),
      () => Promise.resolve('the lander is landing'),
    ),
  ).rejects.toBeInstanceOf(Refusal)
})

it('refuses a detached checkout and a branch without an upstream before fetching', async () => {
  const { path } = await repo()
  await runGit(path, 'checkout', '-q', '--detach')
  await expect(fastForwardUpstream((...args) => runGit(path, ...args))).rejects.toThrow(
    'The checkout is on a detached HEAD',
  )
  await runGit(path, 'checkout', '-q', '-b', 'lonely')
  await expect(fastForwardUpstream((...args) => runGit(path, ...args))).rejects.toThrow(
    /lonely has no upstream/,
  )
})
