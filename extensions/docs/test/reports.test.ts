import { mkdir, readdir, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { temp } from '../../../test/helpers.ts'
import { DAY, isReport, shownPath } from '../limits.ts'
import { keep, readReport, reports, sweep } from '../reports.ts'

async function project() {
  const root = await temp('docs-reports-')
  const host = {
    userHome: join(root, 'user'),
    home: join(root, 'user/.ultimate/projects/my-app-1a2b'),
  }
  const folder = join(host.userHome, '.ultimate/reports/my-app-1a2b')
  await mkdir(folder, { recursive: true })
  return { host, folder, root }
}

const age = (file: string, ms: number, now: number) =>
  utimes(file, new Date(now - ms), new Date(now - ms))

it('lists reports newest first with the days they have left, then the kept ones', async () => {
  const { host, folder } = await project()
  const now = Date.now()
  await writeFile(join(folder, 'old.md'), '# old')
  await writeFile(join(folder, 'new.md'), '# new')
  await writeFile(join(folder, 'notes.txt'), 'x')
  await writeFile(join(folder, '.hidden.md'), 'x')
  await age(join(folder, 'old.md'), 5 * DAY, now)
  await mkdir(join(folder, 'archive'))
  await writeFile(join(folder, 'archive/kept.md'), '# kept')
  const result = await reports(host)
  expect(result.folder).toBe('~/.ultimate/reports/my-app-1a2b/')
  expect(result.reports.map((report) => report.path)).toEqual([
    '.reports/new.md',
    '.reports/old.md',
    '.reports/archive/kept.md',
  ])
  expect(result.reports[2].expires).toBeUndefined()
})

it('reads a report, and a link written before Keep still opens it from archive/', async () => {
  const { host, folder } = await project()
  await writeFile(join(folder, 'plan.md'), '---\ntitle: Plan\n---\nBody')
  expect(await readReport(host, '.reports/plan.md')).toMatchObject({
    status: 'ok',
    frontmatter: { title: 'Plan' },
    body: 'Body',
  })
  expect(await keep(host, '.reports/plan.md')).toEqual({ path: '.reports/archive/plan.md' })
  expect(await readReport(host, '.reports/plan.md')).toMatchObject({
    status: 'ok',
    path: '.reports/archive/plan.md',
  })
})

it('says missing, with the path, for a report that does not exist', async () => {
  const { host } = await project()
  expect(await readReport(host, '.reports/gone.md')).toEqual({
    status: 'missing',
    path: '.reports/gone.md',
  })
})

it('refuses names outside the folder and symlinks', async () => {
  const { host, folder, root } = await project()
  await writeFile(join(root, 'secret.md'), 'secret')
  await symlink(join(root, 'secret.md'), join(folder, 'link.md'))
  await expect(readReport(host, '.reports/../secret.md')).rejects.toThrow('Not a report')
  await expect(readReport(host, '.reports/.hidden.md')).rejects.toThrow('Not a report')
  expect(await readReport(host, '.reports/link.md')).toMatchObject({ status: 'missing' })
})

it('Keep never overwrites a kept report', async () => {
  const { host, folder } = await project()
  await mkdir(join(folder, 'archive'))
  await writeFile(join(folder, 'archive/a.md'), 'kept')
  await writeFile(join(folder, 'a.md'), 'fresh')
  await expect(keep(host, '.reports/a.md')).rejects.toThrow('already exists')
})

it('sweeps reports last written over 30 days ago, never archive/', async () => {
  const { host, folder } = await project()
  const now = Date.now()
  await mkdir(join(folder, 'archive'))
  await writeFile(join(folder, 'stale.md'), 'x')
  await writeFile(join(folder, 'fresh.md'), 'x')
  await writeFile(join(folder, 'archive/kept.md'), 'x')
  await age(join(folder, 'stale.md'), 31 * DAY, now)
  await age(join(folder, 'fresh.md'), 29 * DAY, now)
  await age(join(folder, 'archive/kept.md'), 90 * DAY, now)
  expect(await sweep(host, now)).toEqual({ deleted: ['stale.md'] })
  expect(await readdir(folder)).toEqual(['archive', 'fresh.md'])
  expect(await sweep(host, now + 2 * DAY)).toEqual({ deleted: ['fresh.md'] })
})

it('sweeps nothing when the reports folder does not exist yet', async () => {
  const root = await temp('docs-reports-')
  expect(await sweep({ userHome: root, home: join(root, 'p-1') }, Date.now())).toEqual({
    deleted: [],
  })
})

it('keeps the path the user asked for when it is not in the list, never the README', () => {
  expect(shownPath('docs/gone.md', ['README.md', 'docs/a.md'])).toBe('docs/gone.md')
  expect(shownPath(null, ['docs/a.md', 'readme.md'])).toBe('readme.md')
  expect(shownPath(null, [])).toBeNull()
  expect(isReport('.reports/x.md')).toBe(true)
})
