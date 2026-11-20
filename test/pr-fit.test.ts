import { expect, it } from 'vitest'
import type { ClassifyAnswer } from '../extensions/classify/api.ts'
import { basisOf, memoKey, verdictOf } from '../.ultimate/extensions/pr-fit/fit.ts'

const answers = (
  probabilities: { adopt: number; watch: number; skip: number },
  needed: number,
  overlap: number,
  cost: number,
): Record<string, ClassifyAnswer> => ({
  verdict: { type: 'choice', choice: 'adopt', confidence: 0.5, probabilities },
  needed: { type: 'noul', noul: needed },
  overlap: { type: 'noul', noul: overlap },
  cost: { type: 'score', score: cost, confidence: 0.5, probabilities: {}, legend: {} },
})

it('asks again only for a new head or a changed profile', () => {
  const basis = basisOf('profile')
  expect(memoKey(42, 'abc', basis)).toBe(memoKey(42, 'abc', basisOf('profile')))
  expect(memoKey(42, 'def', basis)).not.toBe(memoKey(42, 'abc', basis))
  expect(basisOf('edited profile')).not.toBe(basis)
})

it('adopts only with a clear lead, a strong need, no overlap and a bounded cost', () => {
  expect(verdictOf(answers({ adopt: 0.75, watch: 0.24, skip: 0.01 }, 0.93, 0.12, 1))).toEqual({
    verdict: 'adopt',
    confidence: 0.75,
    reason: 'fits a need here · small to pull in',
  })
  expect(verdictOf(answers({ adopt: 0.73, watch: 0.26, skip: 0.01 }, 0.95, 0.87, 1.4))).toEqual({
    verdict: 'watch',
    confidence: 0.26,
    reason: 'fits a need here · touches a local feature · small to pull in',
  })
  expect(verdictOf(answers({ adopt: 0.7, watch: 0.3, skip: 0 }, 0.9, 0.1, 2.7))?.verdict).toBe(
    'watch',
  )
})

it('skips when skip is likely or the need is weak', () => {
  expect(verdictOf(answers({ adopt: 0.09, watch: 0.18, skip: 0.73 }, 0.24, 0.07, 1.5))).toEqual({
    verdict: 'skip',
    confidence: 0.76,
    reason: 'no clear need here · medium cost to pull in',
  })
  expect(verdictOf(answers({ adopt: 0.1, watch: 0.81, skip: 0.09 }, 0.39, 0.2, 2.9))?.verdict).toBe(
    'skip',
  )
})

it('names the cost of a fractional score, which Jev returns as an expected level', () => {
  expect(verdictOf(answers({ adopt: 0.4, watch: 0.5, skip: 0.1 }, 0.8, 0.1, 1.61))?.reason).toBe(
    'fits a need here · medium cost to pull in',
  )
})

it('gives no verdict when an answer is missing', () => {
  const { cost: _cost, ...partial } = answers({ adopt: 0.7, watch: 0.3, skip: 0 }, 0.9, 0.1, 1)
  expect(verdictOf(partial)).toBeUndefined()
})
