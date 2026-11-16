import type { AssistantMessage } from '@earendil-works/pi-ai'
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry'

export const weeklyLimit = (error: string) => /weekly usage limit/i.test(error)

export const rateLimited = (error: string) =>
  /(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|too many requests/i.test(error) &&
  !weeklyLimit(error) &&
  isRetryableAssistantError({ stopReason: 'error', errorMessage: error } as AssistantMessage)
