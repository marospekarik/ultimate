/**
 * Wraps every bare `@handle` (or `@org/team`) in backticks, so GitHub renders it as code and notifies no one. Code
 * spans and fences stay as they are, and so do email addresses: a handle preceded by a word character is not one.
 *
 * Origin: PR text built from summaries and divergence said "@ultimate" (our agent), which pinged the GitHub user of
 * that name, who asked us to stop (https://github.com/HazAT/ultimate/pull/149#issuecomment-6836114016).
 */
export function quoteMentions(text: string): string {
  return text
    .split(/((`+)[\s\S]*?\2)/)
    .map((part, index) =>
      // split keeps both capture groups: every third part is a code span, the next its backtick run.
      index % 3 === 0
        ? part.replace(/(?<![\w`])@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][\w.-]*)?/g, '`$&`')
        : index % 3 === 1
          ? part
          : '',
    )
    .join('')
}
