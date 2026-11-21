import type { ReactNode } from 'react'
import { definePoint } from '@/sdk/types.ts'

/**
 * A quiet mark another extension shows at the end of an agent definition's row in the Agents panel (`name` is the
 * definition's name), in the row's right column before its move menu. Provide it as `island(C)`.
 */
export const AgentMark = definePoint<{ name: string }, ReactNode>('subagents.mark')
