import { lstat, mkdir, readdir, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import type { ExtensionHost } from '../../server/extensions.ts'
import { errnoCode, ignoring, isMissing } from '../../lib/errors.ts'
import { parsed } from './doc.ts'
import { MAX_BYTES, REPORTS } from './limits.ts'
import type { Doc, Report } from './refs.ts'

export const DAY = 24 * 60 * 60 * 1000
export const KEEP_DAYS = 30

export type Homes = Pick<ExtensionHost, 'userHome' | 'home'>

const absent = ignoring(isMissing, (error) => errnoCode(error) === 'ENOTDIR')

export const reportsDir = (host: Homes) =>
  join(host.userHome, '.ultimate', 'reports', basename(host.home))

const reportName = (name: string) =>
  name.toLowerCase().endsWith('.md') && !name.startsWith('.') && !/[/\\]/.test(name)

const realDir = (host: Homes) => realpath(reportsDir(host)).catch(absent)

async function reportFiles(dir: string) {
  const items = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
    absent(error)
    return []
  })
  const files = []
  for (const item of items) {
    if (!item.isFile() || !reportName(item.name)) continue
    const stat = await lstat(join(dir, item.name)).catch(absent)
    if (stat?.isFile()) files.push({ name: item.name, size: stat.size, modified: stat.mtimeMs })
  }
  return files
}

export async function reports(host: Homes): Promise<{ folder: string; reports: Report[] }> {
  const folder = `~${reportsDir(host).slice(host.userHome.length)}/`
  const dir = await realDir(host)
  if (!dir) return { folder, reports: [] }
  const fresh = (await reportFiles(dir)).map((file) => ({
    path: `${REPORTS}${file.name}`,
    size: file.size,
    modified: file.modified,
    archived: false,
    expires: file.modified + KEEP_DAYS * DAY,
  }))
  const kept = (await reportFiles(join(dir, 'archive'))).map((file) => ({
    path: `${REPORTS}archive/${file.name}`,
    size: file.size,
    modified: file.modified,
    archived: true,
  }))
  const newest = (a: Report, b: Report) => b.modified - a.modified
  return { folder, reports: [...fresh.toSorted(newest), ...kept.toSorted(newest)] }
}

export async function reportFile(host: Homes, path: string) {
  const match = /^\.reports\/(archive\/)?([^/]+)$/.exec(path)
  if (!match || !reportName(match[2])) throw new Error(`Not a report: ${path}`)
  const dir = await realDir(host)
  if (!dir) return undefined
  const file = join(dir, match[1] ? 'archive' : '', match[2])
  const stat = await lstat(file).catch(absent)
  if (!stat?.isFile() || !file.startsWith(dir + sep)) return undefined
  if ((await realpath(file).catch(absent)) !== file) return undefined
  return { file, name: match[2], archived: Boolean(match[1]), stat }
}

export async function readReport(host: Homes, requested: string): Promise<Doc> {
  const archived = `${REPORTS}archive/${requested.slice(REPORTS.length)}`
  const moved = requested.startsWith(`${REPORTS}archive/`) ? undefined : archived
  const found =
    (await reportFile(host, requested)) ?? (moved ? await reportFile(host, moved) : undefined)
  const path = found?.archived ? `${REPORTS}archive/${found.name}` : requested
  if (!found) return { status: 'missing', path }
  if (found.stat.size > MAX_BYTES) return { status: 'tooLarge', path, size: found.stat.size }
  return parsed(path, await readFile(found.file, 'utf8'), found.stat.size, found.stat.mtimeMs)
}

export async function keep(host: Homes, path: string) {
  const found = await reportFile(host, path)
  if (!found) throw new Error(`No report ${path}`)
  if (found.archived) return { path }
  const archive = join(reportsDir(host), 'archive')
  await mkdir(archive, { recursive: true })
  const real = await realpath(archive)
  if (real !== join((await realDir(host))!, 'archive'))
    throw new Error('archive/ is not a folder inside the reports folder')
  const target = join(real, found.name)
  if (await lstat(target).catch(absent)) throw new Error(`archive/${found.name} already exists`)
  await rename(found.file, target)
  return { path: `${REPORTS}archive/${found.name}` }
}

export async function sweep(host: Homes, now: number) {
  const dir = await realDir(host)
  const deleted: string[] = []
  if (!dir) return { deleted }
  for (const file of await reportFiles(dir)) {
    if (file.modified >= now - KEEP_DAYS * DAY) continue
    await unlink(join(dir, file.name)).then(() => deleted.push(file.name), ignoring(isMissing))
  }
  return { deleted }
}
