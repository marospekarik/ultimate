/** Pause: whether the user paused this Ultimate, for timers that start work outside the task scheduler. */
import { defineApi } from '../../shared/extension-api.ts'

export type PauseService = {
  /** Whether the host is paused; a timer that starts work (a fetch, a ping, a backup) skips its tick while it is. */
  paused(): boolean
}
/** The pause; `want` it, pause is optional. */
export const PauseApi = defineApi<PauseService>()('pause')
