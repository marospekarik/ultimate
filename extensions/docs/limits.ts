export const limits = { comments: 50, text: 4000, quote: 1000, note: 4000 }

export const REPORTS = '.reports/'

export const ARCHIVE = `${REPORTS}archive/`

export const DAY = 24 * 60 * 60 * 1000

export const KEEP_DAYS = 30

export const MAX_BYTES = 1024 * 1024

export const isReport = (path: string) => path.startsWith(REPORTS)

export const shownPath = (selected: string | null, paths: readonly string[]) =>
  selected ?? paths.find((path) => path.toLowerCase() === 'readme.md') ?? paths[0] ?? null
