import { createHash } from 'node:crypto'
import type { JsonValue } from '@earendil-works/chord/json'
import type { ClassifyAnswer, ClassifyQuestion } from '../../../extensions/classify/api.ts'
import type { Fit } from './refs.ts'

/** What Jev sees of a PR: its text, labels, changed files and CI rollup; never its diff. */
export type PrText = {
  number: number
  title: string
  author: string
  labels: string[]
  body: string
  files: string[]
  ci: string
}

const BODY_LIMIT = 6000
const FILE_LIMIT = 60

export const questions = {
  verdict: {
    type: 'choice',
    instructions: {
      question:
        'Judge this pull request to the upstream project against the profile of the one person who runs a fork of it. Is it worth pulling into that fork?',
      read: 'profile describes the setup; pr is the pull request: its title, description, labels, changed files and CI state.',
    },
    criteria: {
      adopt:
        'Pull it into the fork now: it fixes a problem or adds a feature this setup clearly uses or hits, and its integration cost is worth paying before upstream merges it.',
      watch:
        'Useful for this setup but not urgent, or better waited for until upstream merges it, or overlapping a local feature in a way that needs a closer look first.',
      skip: 'Not useful for this setup: it serves tools, providers, platforms or workflows this setup does not use, or the change is too marginal to matter.',
    },
  },
  needed: {
    type: 'noul',
    instructions:
      'Does the pull request solve a problem or add a capability that this setup, as the profile describes it, actually has or uses?',
    criteria: {
      true: 'It touches something the profile says is used daily or is a pain point (phone use, branches, the lander, voice, cost, keep-warm, upstream merges, systemd projects over a tailnet).',
      false:
        'It targets something the profile does not use or mention, or something the profile says is not used.',
    },
  },
  overlap: {
    type: 'noul',
    instructions:
      'Does the pull request change the same area as a local feature the fork already carries (pause, smart-merge updates, messages routing and quiet replies, ChatGPT voice login, the sandbox, Docs, project-rail)?',
  },
  cost: {
    type: 'score',
    instructions:
      'How costly and conflict-prone is pulling this pull request into a fork that carries local changes and merges upstream often?',
    criteria: [
      'Trivial: a few lines or one self-contained file, docs or tests only.',
      'Small: one extension, few files, unlikely to conflict.',
      'Medium: several extensions or shared core files that upstream changes often.',
      'Large: many files across the core (server, shared, web) or a rework of something the fork changed locally.',
    ],
  },
} satisfies Record<string, ClassifyQuestion>

/** The JSON state sent to Jev: the profile and the PR's text, trimmed to bounded sizes. */
export function stateOf(profile: string, pr: PrText): JsonValue {
  const files = pr.files.slice(0, FILE_LIMIT)
  return {
    profile,
    pr: {
      title: pr.title,
      author: pr.author,
      labels: pr.labels,
      description: pr.body.slice(0, BODY_LIMIT),
      changedFiles:
        pr.files.length > FILE_LIMIT
          ? [...files, `…and ${pr.files.length - FILE_LIMIT} more`]
          : files,
      ci: pr.ci,
    },
  }
}

/** What Jev's answers depend on besides the PR: the profile and the questions. A change in either asks again for every PR. */
export const basisOf = (profile: string) =>
  createHash('sha256').update(profile).update(JSON.stringify(questions)).digest('hex').slice(0, 12)

/** A PR is asked about once per head commit and basis. */
export const memoKey = (number: number, head: string, basis: string) => `${number}@${head}@${basis}`

const costs = [
  'trivial to pull in',
  'small to pull in',
  'medium cost to pull in',
  'large cost to pull in',
]

/**
 * Jev leans to adopt and rates most PRs as needed, so adopt takes a clear lead, a strong need, no overlap with a local
 * feature (that needs a closer look first) and a cost below large.
 */
const ADOPT = { lead: 0.6, need: 0.85, overlap: 0.5, cost: 2.5 }
/** Skip once skip is likely or the need is weak. */
const SKIP = { lead: 0.4, need: 0.45 }

/**
 * The verdict from Jev's answers: adopt and skip need the side answers to agree, everything between is watch. Its
 * confidence is Jev's probability for that verdict (for skip, or the weakness of the need); the reason line comes from
 * the need, overlap and cost answers.
 */
export function verdictOf(
  answers: Record<string, ClassifyAnswer>,
): Omit<Extract<Fit, { confidence: number }>, 'head' | 'at'> | undefined {
  const { verdict, needed, overlap, cost } = answers
  if (verdict?.type !== 'choice' || needed?.type !== 'noul' || overlap?.type !== 'noul')
    return undefined
  if (cost?.type !== 'score') return undefined
  const p = (option: string) => verdict.probabilities[option] ?? 0
  const choice =
    p('skip') >= SKIP.lead || needed.noul < SKIP.need
      ? 'skip'
      : p('adopt') >= ADOPT.lead &&
          needed.noul >= ADOPT.need &&
          overlap.noul < ADOPT.overlap &&
          cost.score < ADOPT.cost
        ? 'adopt'
        : 'watch'
  const reason = [
    needed.noul >= SKIP.need ? 'fits a need here' : 'no clear need here',
    overlap.noul >= ADOPT.overlap && 'touches a local feature',
    costs[Math.min(costs.length - 1, Math.max(0, Math.round(cost.score)))],
  ]
    .filter(Boolean)
    .join(' · ')
  const confidence = choice === 'skip' ? Math.max(p('skip'), 1 - needed.noul) : p(choice)
  return { verdict: choice, confidence, reason }
}
