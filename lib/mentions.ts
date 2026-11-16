export function quoteMentions(text: string): string {
  return text
    .split(/((`+)[\s\S]*?\2)/)
    .map((part, index) =>
      index % 3 === 0
        ? part.replace(/(?<![\w`])@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][\w.-]*)?/g, '`$&`')
        : index % 3 === 1
          ? part
          : '',
    )
    .join('')
}
