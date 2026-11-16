import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ActionContext } from '../../server/actions.ts'
import { implementAction } from '../../lib/actions.ts'
import { errnoCode, ignoring, isMissing } from '../../lib/errors.ts'
import { runGit } from '../../lib/git.ts'
import { parseConversationId } from '../../lib/ids.ts'
import { every } from '../../lib/timers.ts'
import { parsed } from './doc.ts'
import { limits, MAX_BYTES, REPORTS } from './limits.ts'
import {
  DocCommentsEntry,
  KeepAction,
  ListAction,
  ReadAction,
  ReportsAction,
  SendAction,
  SweepAction,
} from './refs.ts'
import type { Doc, DocComment, DocComments } from './refs.ts'
import { DAY, keep, readReport, reportFile, reports, sweep } from './reports.ts'

export default function docs(host: ExtensionHost) {
  const run = () =>
    sweep(host, Date.now()).catch((error: unknown) =>
      host.notice(`Docs: report sweep failed: ${String(error)}`),
    )
  let stopSweeping: (() => void) | undefined
  host.onOpen(async () => {
    await run()
    stopSweeping?.()
    stopSweeping = every(DAY, run)
  })
  host.onClose(async () => stopSweeping?.())
  return defineExtension({ name: 'docs' })
}

const showable = (path: string) =>
  path.toLowerCase().endsWith('.md') &&
  path.split('/').every((part) => part && !part.startsWith('.'))

async function list(host: Pick<ExtensionHost, 'projectRoot'>): Promise<string[]> {
  const { stdout } = await runGit(host.projectRoot, [
    '-c',
    'core.quotePath=false',
    'ls-files',
    '-z',
    '--',
    '*.md',
    '*.MD',
  ]).catch((error: unknown) => {
    if (error instanceof Error && /not a git repository/i.test(error.message))
      return { stdout: '', stderr: '' }
    throw error
  })
  return [...new Set(stdout.split('\0').filter(showable))].toSorted()
}

async function read(host: Pick<ExtensionHost, 'projectRoot'>, path: string): Promise<Doc> {
  if (!(await list(host)).includes(path)) return { status: 'missing', path }
  const root = await realpath(host.projectRoot)
  const file = join(root, path)
  const stat = await lstat(file).catch(
    ignoring(isMissing, (error) => errnoCode(error) === 'ENOTDIR'),
  )
  if (!stat?.isFile()) return { status: 'missing', path }
  if ((await realpath(file)) !== file || !file.startsWith(root + sep))
    return { status: 'missing', path }
  if (stat.size > MAX_BYTES) return { status: 'tooLarge', path, size: stat.size }
  return parsed(path, await readFile(file, 'utf8'), stat.size, stat.mtimeMs)
}

const clip = (text: unknown, max: number, what: string) => {
  if (typeof text !== 'string') throw new Error(`${what} must be text`)
  if (text.length > max) throw new Error(`${what} is over ${max} characters`)
  return text
}

export function checkComments(args: unknown): DocComments & { conversation: number } {
  const input = (args ?? {}) as Record<string, unknown>
  const conversation = input.conversation
  if (typeof conversation !== 'number' || !Number.isSafeInteger(conversation) || conversation < 1)
    throw new Error('conversation must be a conversation id')
  const path = clip(input.path, 1000, 'path')
  if (!Array.isArray(input.comments) || input.comments.length === 0)
    throw new Error('Expected at least one comment')
  if (input.comments.length > limits.comments)
    throw new Error(`At most ${limits.comments} comments`)
  const comments = input.comments.map((raw): DocComment => {
    const item = (raw ?? {}) as Record<string, unknown>
    const text = clip(item.text, limits.text, 'A comment').trim()
    if (!text) throw new Error('A comment is empty')
    const quote =
      item.quote === undefined ? undefined : clip(item.quote, limits.quote, 'A quote').trim()
    const heading =
      item.heading === undefined ? undefined : clip(item.heading, 300, 'A heading').trim()
    return { text, ...(quote && { quote }), ...(heading && { heading }) }
  })
  const note =
    input.note === undefined ? undefined : clip(input.note, limits.note, 'The note').trim()
  return { conversation, path, comments, ...(note && { note }) }
}

const fence = (text: string) =>
  '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)))

export function commentsText({ path, comments, note }: DocComments, file = path) {
  const parts = [
    `Comments on ${path.startsWith(REPORTS) ? 'the report ' : ''}\`${file}\` (${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}). Read the doc before answering.`,
  ]
  if (note) parts.push(note)
  comments.forEach((comment, index) => {
    const lines = [`${index + 1}. ${comment.heading ? `Under "${comment.heading}"` : 'On the doc'}`]
    if (comment.quote)
      lines.push(`${fence(comment.quote)}markdown`, comment.quote, fence(comment.quote))
    lines.push(comment.text)
    parts.push(lines.join('\n'))
  })
  return parts.join('\n\n')
}

const pathOf = (args: unknown) => {
  const path = (args as { path?: unknown } | null)?.path
  if (typeof path !== 'string') throw new Error('Expected { path }')
  return path
}

export const userActions = ['send', 'keep']

export const actions = {
  list: implementAction(ListAction, (_args, { host }: ActionContext) => list(host)),
  reports: implementAction(ReportsAction, (_args, { host }: ActionContext) => reports(host)),
  read: implementAction(ReadAction, (args, { host }: ActionContext) => {
    const path = pathOf(args)
    return path.startsWith(REPORTS) ? readReport(host, path) : read(host, path)
  }),
  keep: implementAction(KeepAction, (args, { host }: ActionContext) => keep(host, pathOf(args))),
  sweep: implementAction(SweepAction, (_args, { host }: ActionContext) => sweep(host, Date.now())),
  send: implementAction(SendAction, async (args, { host }: ActionContext) => {
    const { conversation: id, ...review } = checkComments(args)
    let file = review.path
    if (review.path.startsWith(REPORTS)) {
      const found = await reportFile(host, review.path)
      if (!found) throw new Error(`No report ${review.path}`)
      file = found.file
    } else if (!(await list(host)).includes(review.path))
      throw new Error(`Not a doc the viewer shows: ${review.path}`)
    if (!host.conversations().some((item) => item.id === id))
      throw new Error(`No conversation #${id}`)
    const conversation = await host.harness().conversation(parseConversationId(id), context)
    if (!conversation) throw new Error(`No conversation #${id}`)
    await conversation.submit(
      {
        type: 'input',
        content: commentsText(review, file),
        entry: { kind: DocCommentsEntry.kind, data: review },
        whenBusy: 'steer',
      },
      context,
    )
    return { conversation: id }
  }),
}
