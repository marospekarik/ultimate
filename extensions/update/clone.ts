/** The Ultimate clone against origin: what it lacks, what that touches, and fetching it at most hourly. */
import type { Git } from '../../lib/fast-forward.ts'
import { fetchOrigin, standing } from '../../lib/fast-forward.ts'
import { FETCH_EVERY, fetchedAt } from '../../lib/clone.ts'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { corePath, packagePath } from '../../lib/layers.ts'
import { conflictsPredicted } from '../../lib/merge.ts'
import type { Layers, UpdateState } from './refs.ts'

/** Which layers `files` (paths from the repository root) touch. */
export function layersOf(files: string[]): Layers {
  const layers = { core: false, bin: false, lockfile: false, live: false }
  for (const file of files)
    if (corePath(file)) layers.core = true
    else if (file.startsWith('bin/')) layers.bin = true
    else if (packagePath(file)) layers.lockfile = true
    else layers.live = true
  return layers
}

/**
 * Fetch origin when the last fetch is older than `FETCH_EVERY`, or always with `force` (Check now); the error of a
 * failed fetch, else undefined.
 */
export async function fetchIfDue(git: Git, root: string, now: number, force = false) {
  const last = await fetchedAt(git, root)
  if (!force && last !== undefined && now - last < FETCH_EVERY) return undefined
  return fetchOrigin(git).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
}

/**
 * The clone against `origin/<default branch>` as of the last fetch: commits behind, what they touch, whether a
 * diverged branch would conflict with a merge, and refusals.
 */
export async function cloneState(
  git: Git,
  root: string,
): Promise<
  Pick<
    UpdateState,
    | 'branch'
    | 'behind'
    | 'ahead'
    | 'diverged'
    | 'conflicts'
    | 'commits'
    | 'layers'
    | 'refused'
    | 'fetchedAt'
  > & {
    head: string
    remoteHead?: string
  }
> {
  const head = await git('rev-parse', 'HEAD')
  const at = await fetchedAt(git, root)
  const state = await standing(git)
  // Predicted for a diverged clone only: a status poll never runs merge-tree for a plain fast-forward.
  const predicted = state.diverged ? await conflictsPredicted(root, state.remote) : undefined
  const result = {
    head,
    branch: state.branch,
    behind: state.behind,
    ahead: state.ahead,
    commits: [] as UpdateState['commits'],
    ...(state.diverged
      ? { diverged: state.diverged, ...(predicted !== undefined ? { conflicts: predicted } : {}) }
      : {}),
    ...(state.refused ? { refused: state.refused } : {}),
    ...(at !== undefined ? { fetchedAt: at } : {}),
  }
  if (!state.behind) return result
  const range = `HEAD..${state.remote}`
  const log = await git('log', '-5', '--format=%h%x09%s', range)
  const files = await git('diff', '--name-only', 'HEAD', state.remote)
  return {
    ...result,
    remoteHead: await git('rev-parse', state.remote),
    commits: log
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ...subject] = line.split('\t')
        return { sha, subject: subject.join('\t') }
      }),
    layers: layersOf(files.split('\n').filter(Boolean)),
  }
}

/** What the summary model reads: the range's commit messages, never diffs, clipped. */
export const SUMMARY_INPUT_CAP = 12_000

export const SUMMARY_SYSTEM = `You summarize an update to Ultimate, a coding agent app, for its user.
You get the commit messages of the update, newest first. Answer with 2 to 4 lines, one per notable change, most
useful first, each under 90 characters, in plain language about what the user gets ("Review surface: comment on diff
lines and send them to an agent"). Group small fixes into one line. No bullets, numbering, commit hashes or preamble.`

/** The answer's lines, at most 4, without bullets or numbering. */
export function summaryLines(text: string) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4)
}

/**
 * The summary of `range` (`<head>..<remote head>`): the cached one when `file` holds it, else asked once with the
 * commit messages from `log` and cached; undefined when asking fails or answers nothing. Asked at most once per range
 * across every Ultimate on the clone, since `file` lives in the clone's git directory.
 */
export async function summaryFor(
  file: string,
  range: string,
  log: () => Promise<string>,
  ask?: (input: string) => Promise<string | undefined>,
): Promise<string[] | undefined> {
  const cached = await readJson<{ range?: string; lines?: string[] }>(file, {})
  if (cached.range === range) return cached.lines?.length ? cached.lines : undefined
  // Without `ask` only the cache is read: a status poll never waits for a model.
  if (!ask) return undefined
  const text = await ask((await log()).slice(0, SUMMARY_INPUT_CAP)).catch(
    // No summary model, or it failed: the commit list stands in for the summary.
    () => undefined,
  )
  const lines = text === undefined ? [] : summaryLines(text)
  // A failed or empty answer is cached too: the list stands in, and the range is not asked again.
  await writeJson(file, { range, lines })
  return lines.length ? lines : undefined
}
