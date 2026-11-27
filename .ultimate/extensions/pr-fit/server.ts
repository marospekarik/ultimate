import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineExtension } from '@earendil-works/pi-durable'
import { ClassifyApi } from '../../../extensions/classify/api.ts'
import type { ClassifyAnswer } from '../../../extensions/classify/api.ts'
import { implementAction } from '../../../lib/actions.ts'
import { inProcess } from '../../../lib/errors.shared.ts'
import { exec } from '../../../lib/exec.ts'
import { readJson, writeTextAtomically } from '../../../lib/json-file.ts'
import type { ActionContext } from '../../../server/actions.ts'
import { basisOf, memoKey, questions, stateOf, verdictOf } from './fit.ts'
import type { PrText } from './fit.ts'
import { FitsAction } from './refs.ts'
import type { Fit } from './refs.ts'

export default defineExtension({ name: 'pr-fit' })

const REPO = 'HazAT/ultimate'
/** How long a read of the open PRs is reused before the next `fits` call reads them again. */
const LIST_EVERY = 5 * 60_000

/**
 * Jev's answers per open PR, not the verdicts: the mapping in `verdictOf` can change without asking again. `answers` is
 * absent on the user's own PRs.
 */
type Judged = { key: string; head: string; at: string; answers?: Record<string, ClassifyAnswer> }
type Stored = { judged: Record<string, Judged> }
/** The background round of this process; `failed` is the last error logged, so a repeating one (a paused classify) logs once. */
type Round = { running?: Promise<void>; finishedAt: number; failed?: string }

type RawPr = {
  number: number
  title: string
  author: { login: string }
  headRefOid: string
  labels: { name: string }[]
  body: string
  files: { path: string }[]
  statusCheckRollup: { conclusion?: string; state?: string; status?: string }[] | null
}

const ci = (checks: RawPr['statusCheckRollup']) => {
  const states = (checks ?? []).map(
    (check) => check.conclusion || check.state || check.status || '',
  )
  if (states.length === 0) return 'none'
  if (
    states.some((state) =>
      [
        'FAILURE',
        'ERROR',
        'CANCELLED',
        'TIMED_OUT',
        'ACTION_REQUIRED',
        'STARTUP_FAILURE',
        'STALE',
      ].includes(state),
    )
  )
    return 'failing'
  if (states.every((state) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state))) return 'passing'
  return 'running'
}

const memoFile = (ctx: ActionContext) => join(ctx.host.home, 'pr-fit.json')

async function judge(ctx: ActionContext) {
  const classify = ctx.host.want(ClassifyApi)
  if (!classify) return
  const gh = async (args: string[]) =>
    (
      await exec('gh', args, {
        cwd: ctx.host.projectRoot,
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout.trim()
  const [viewer, raw, profile] = await Promise.all([
    gh(['api', 'user', '--jq', '.login']),
    gh([
      'pr',
      'list',
      '-R',
      REPO,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title,author,headRefOid,labels,body,files,statusCheckRollup',
    ]).then((out) => JSON.parse(out) as RawPr[]),
    readFile(join(import.meta.dirname, 'profile.md'), 'utf8'),
  ])
  const basis = basisOf(profile)
  const stored = await readJson<Stored>(memoFile(ctx), { judged: {} })
  const open = new Set(raw.map((pr) => String(pr.number)))
  const judged = Object.fromEntries(
    Object.entries(stored.judged).filter(([number]) => open.has(number)),
  )
  const save = () => writeTextAtomically(memoFile(ctx), `${JSON.stringify({ judged }, null, 2)}\n`)
  for (const pr of raw) {
    const key = memoKey(pr.number, pr.headRefOid, basis)
    if (judged[pr.number]?.key === key) continue
    const at = new Date().toISOString()
    if (pr.author.login === viewer) {
      judged[pr.number] = { key, head: pr.headRefOid, at }
      continue
    }
    const text: PrText = {
      number: pr.number,
      title: pr.title,
      author: pr.author.login,
      labels: pr.labels.map((label) => label.name),
      body: pr.body,
      files: pr.files.map((file) => file.path),
      ci: ci(pr.statusCheckRollup),
    }
    const result = await classify.ask(
      { state: stateOf(profile, text), questions },
      AbortSignal.timeout(30_000),
    )
    judged[pr.number] = { key, head: pr.headRefOid, at, answers: result.answers }
    await save()
  }
  await save()
}

export const actions = {
  fits: implementAction(FitsAction, async (_args, ctx) => {
    if (!ctx.host.want(ClassifyApi)) return {}
    const round = ctx.host.resource<Round>('pr-fit.round', () => ({ finishedAt: 0 }))
    if (!round.running && Date.now() - round.finishedAt > LIST_EVERY) {
      round.running = judge(ctx)
        .then(
          () => {
            round.failed = undefined
          },
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            if (message !== round.failed) console.warn(`pr-fit: ${message}`)
            round.failed = message
          },
        )
        .finally(() => {
          round.running = undefined
          round.finishedAt = Date.now()
        })
      inProcess('a verdict not yet saved is asked again by the next fits call', round.running)
    }
    const { judged } = await readJson<Stored>(memoFile(ctx), { judged: {} })
    const fits: Record<string, Fit> = {}
    for (const [number, { head, at, answers }] of Object.entries(judged)) {
      const fit = answers ? verdictOf(answers) : { verdict: 'ours' as const }
      if (fit) fits[number] = { ...fit, head, at }
    }
    return fits
  }),
}

export const pollActions = ['fits']
