import type { JSX } from '@solidjs/web'
import { definePoint } from '@/sdk/types.ts'

export const AgentMark = definePoint<{ name: string }, JSX.Element>('subagents.mark')
