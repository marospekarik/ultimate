/** Whether a branch still has a landing to come, which will wake its starter: shared by routing and delivery. */
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { WorkspacesApi } from '../workspaces/api.ts'

/** Every task state but `terminal`: queried by status, so finished tasks are never scanned. */
const LIVE = ['pending', 'running', 'waiting', 'sleeping', 'completing'] as const
/** Live tasks of `kind` in `conversationId` (any conversation when undefined). */
export async function live(tx: Tx, kind: string, conversationId?: ConversationId) {
  const found = []
  for (const status of LIVE) {
    let cursor: Parameters<Tx['scanTasks']>[2]
    do {
      const page = await tx.scanTasks(
        { ...(conversationId === undefined ? {} : { conversationId }), kind, status },
        100,
        cursor,
      )
      found.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
  }
  return found
}
/** Whether `id` has a submission the lander has not reported yet: queued, landing, or being reported. */
export async function landing(host: ExtensionHost, tx: Tx, id: ConversationId): Promise<boolean> {
  const queue = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).queue
  if (queue.some((item) => item.conversationId === id)) return true
  // A submission leaves the queue in the commit that moves the lander to reporting it.
  for (const task of await live(tx, 'workspaces.lander')) {
    const checkpoint = (task.state as { checkpoint?: { phase?: string; conversationId?: number } })
      .checkpoint
    if (checkpoint?.phase === 'report' && checkpoint.conversationId === id) return true
  }
  return false
}
