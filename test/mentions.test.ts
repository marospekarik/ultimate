import { expect, test } from 'vitest'
import { quoteMentions } from '../lib/mentions.ts'

test('quoteMentions wraps bare handles and leaves code spans and emails alone', () => {
  expect(quoteMentions('Asked @ultimate, then @lander landed it.')).toBe(
    'Asked `@ultimate`, then `@lander` landed it.',
  )
  expect(quoteMentions("Pinged @my-org/reviewers and @ultimate's branch")).toBe(
    "Pinged `@my-org/reviewers` and `@ultimate`'s branch",
  )
  expect(quoteMentions('Kept `@ultimate` and\n```\n@lander\n```\nas code')).toBe(
    'Kept `@ultimate` and\n```\n@lander\n```\nas code',
  )
  expect(quoteMentions('Mail user@example.com')).toBe('Mail user@example.com')
})
