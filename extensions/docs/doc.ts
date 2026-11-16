import { parseFrontmatter } from '@earendil-works/pi-coding-agent'
import type { Doc } from './refs.ts'

function split(text: string) {
  try {
    return parseFrontmatter(text)
  } catch {
    return { frontmatter: {}, body: text }
  }
}

export function parsed(path: string, text: string, size: number, modified: number): Doc {
  const { frontmatter, body } = split(text)
  return { status: 'ok', path, frontmatter, body, size, modified }
}
