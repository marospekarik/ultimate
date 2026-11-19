const MINUTE_MS = 60_000
export const TTL = 60 * MINUTE_MS
export const LEAD = 55 * MINUTE_MS
export const PRECOLD = 50 * MINUTE_MS
export const PRECOLD_TOKENS = 150_000
export const IDLE_STOP = 8 * 60 * MINUTE_MS

export type Activity = {
  now: number
  lastRequest?: number
  inputAt?: number
  failedAfter?: number
  heldSince?: number
}

export const failing = (failedAt: number | undefined, lastRequest: number | undefined) =>
  failedAt !== undefined && (lastRequest === undefined || failedAt >= lastRequest)

export function due({ now, lastRequest, inputAt, failedAfter, heldSince }: Activity) {
  if (lastRequest === undefined || inputAt === undefined) return false
  if (failing(failedAfter, lastRequest)) return false
  const cacheAgeMs = now - lastRequest
  const cacheStillWarmAndNearExpiry = cacheAgeMs >= LEAD && cacheAgeMs < TTL
  const absenceUntilTimedHoldMs = Math.min(now, heldSince ?? now) - inputAt
  return cacheStillWarmAndNearExpiry && absenceUntilTimedHoldMs < IDLE_STOP
}

export type PrecoldActivity = Activity & {
  on: boolean
  paused: boolean
  tokens?: number
  compactedAt?: number
}

export function precoldAt({ on, paused, tokens, compactedAt, ...activity }: PrecoldActivity) {
  const { lastRequest } = activity
  if (lastRequest === undefined || paused || compactedAt === lastRequest) return undefined
  if ((tokens ?? 0) <= PRECOLD_TOKENS) return undefined
  const pingComing = on && due({ ...activity, now: lastRequest + LEAD })
  return pingComing ? undefined : lastRequest + PRECOLD
}

export const precoldDue = (activity: PrecoldActivity) => {
  const at = precoldAt(activity)
  return at !== undefined && activity.now >= at && activity.now < activity.lastRequest! + TTL
}
