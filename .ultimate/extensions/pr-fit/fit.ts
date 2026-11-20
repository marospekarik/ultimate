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

/** What a verdict depends on besides the PR: the profile and the questions. A change in either judges every PR again. */
export const basisOf = (profile: string) =>
  createHash('sha256').update(profile).update(JSON.stringify(questions)).digest('hex').slice(0, 12)

/** A PR is judged once per head commit and basis. */
export const memoKey = (number: number, head: string, basis: string) => `${number}@${head}@${basis}`

const reasons = {
  needed: ['fits a need here', 'no clear need here'],
  overlap: ['touches a local feature', undefined],
} as const
const costs = [
  'trivial to pull in',
  'small to pull in',
  'medium integration cost',
  'large integration cost',
]

/**
 * The verdict from Jev's answers. An `adopt` with no clear need or a large cost is held back to `watch`; the reason line
 * is built from the yes/no and score answers.
 */
export function verdictOf(
  answers: Record<string, ClassifyAnswer>,
  head: string,
  at: string,
): Fit | undefined {
  const { verdict, needed, overlap, cost } = answers
  if (verdict?.type !== 'choice' || !(verdict.choice in questions.verdict.criteria))
    return undefined
  const need = needed?.type === 'noul' ? needed.noul : undefined
  const touches = overlap?.type === 'noul' ? overlap.noul : undefined
  const level = cost?.type === 'score' ? cost.score : undefined
  let choice = verdict.choice as 'adopt' | 'watch' | 'skip'
  if (
    choice === 'adopt' &&
    ((need !== undefined && need < 0.5) || (level !== undefined && level >= 3))
  )
    choice = 'watch'
  const reason = [
    need === undefined ? undefined : need >= 0.5 ? reasons.needed[0] : reasons.needed[1],
    touches !== undefined && touches >= 0.5 ? reasons.overlap[0] : undefined,
    level === undefined ? undefined : costs[level],
  ]
    .filter(Boolean)
    .join(' · ')
  return { verdict: choice, confidence: verdict.confidence, reason, head, at }
}
