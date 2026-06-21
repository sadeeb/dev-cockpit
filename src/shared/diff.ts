export interface DiffLine {
  kind: 'same' | 'del' | 'add'
  text: string
}

/**
 * Small line diff for rendering Edit tool calls: trims the common prefix and
 * suffix, shows the changed middle as del/add blocks with one line of context.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const out: DiffLine[] = []
  if (start > 0) out.push({ kind: 'same', text: a[start - 1] })
  for (let i = start; i < endA; i++) out.push({ kind: 'del', text: a[i] })
  for (let i = start; i < endB; i++) out.push({ kind: 'add', text: b[i] })
  if (endA < a.length) out.push({ kind: 'same', text: a[endA] })
  return out
}
