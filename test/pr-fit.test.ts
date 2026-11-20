import { expect, it } from 'vitest'
import type { ClassifyAnswer } from '../extensions/classify/api.ts'
import { basisOf, memoKey, verdictOf } from '../.ultimate/extensions/pr-fit/fit.ts'

const choice = (verdict: string, confidence = 0.8): ClassifyAnswer => ({
  type: 'choice',
  choice: verdict,
  confidence,
  probabilities: { [verdict]: confidence },
})
const noul = (value: number): ClassifyAnswer => ({ type: 'noul', noul: value })
const score = (value: number): ClassifyAnswer => ({
  type: 'score',
  score: value,
  confidence: 0.9,
  probabilities: {},
  legend: {},
})

it('keys a verdict by PR, head and basis, and a changed profile changes the basis', () => {
  expect(memoKey(42, 'abc', basisOf('one'))).toBe(memoKey(42, 'abc', basisOf('one')))
  expect(memoKey(42, 'abc', basisOf('one'))).not.toBe(memoKey(42, 'def', basisOf('one')))
  expect(basisOf('one')).not.toBe(basisOf('two'))
})

it('maps the answers to a verdict with a reason line', () => {
  expect(
    verdictOf(
      { verdict: choice('adopt', 0.9), needed: noul(0.8), overlap: noul(0.7), cost: score(1) },
      'abc',
      'now',
    ),
  ).toEqual({
    verdict: 'adopt',
    confidence: 0.9,
    reason: 'fits a need here · touches a local feature · small to pull in',
    head: 'abc',
    at: 'now',
  })
  expect(verdictOf({ verdict: choice('skip'), needed: noul(0.1) }, 'abc', 'now')).toMatchObject({
    verdict: 'skip',
    reason: 'no clear need here',
  })
})

it('holds an adopt back to watch without a clear need or at a large cost', () => {
  expect(verdictOf({ verdict: choice('adopt'), needed: noul(0.3) }, 'h', 'now')?.verdict).toBe(
    'watch',
  )
  expect(
    verdictOf({ verdict: choice('adopt'), needed: noul(0.9), cost: score(3) }, 'h', 'now')?.verdict,
  ).toBe('watch')
})

it('gives no verdict for a missing or unknown choice', () => {
  expect(verdictOf({ needed: noul(0.9) }, 'h', 'now')).toBeUndefined()
  expect(verdictOf({ verdict: choice('maybe') }, 'h', 'now')).toBeUndefined()
})
