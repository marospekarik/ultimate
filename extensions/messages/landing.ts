import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { WorkspacesApi } from '../workspaces/api.ts'

const NONTERMINAL_TASK_STATUSES = [
  'pending',
  'running',
  'waiting',
  'sleeping',
  'completing',
] as const

export async function scanNonterminalTasks(tx: Tx, kind: string, conversationId?: ConversationId) {
  const found = []
  for (const status of NONTERMINAL_TASK_STATUSES) {
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

export async function hasLandingToCome(
  host: ExtensionHost,
  tx: Tx,
  id: ConversationId,
): Promise<boolean> {
  const queue = (await tx.doc(host.need(WorkspacesApi).doc, ROOT_CONVERSATION_ID)).queue
  if (queue.some((item) => item.conversationId === id)) return true
  for (const task of await scanNonterminalTasks(tx, 'workspaces.lander')) {
    const checkpoint = (
      task.state as { checkpoint?: { phase?: string; conversationId?: ConversationId } }
    ).checkpoint
    const landingReportStillPending =
      checkpoint?.phase === 'report' && checkpoint.conversationId === id
    if (landingReportStillPending) return true
  }
  return false
}
