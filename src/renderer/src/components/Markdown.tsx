import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { marked } from 'marked'
import { memo, useEffect, useRef } from 'react'

marked.setOptions({ gfm: true, breaks: true })

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

function render(text: string): string {
  const html = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i
  })
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = ref.current
    if (!root) return
    for (const block of root.querySelectorAll('pre code')) {
      const el = block as HTMLElement
      if (el.dataset.hl === '1') continue
      el.dataset.hl = '1'
      try {
        hljs.highlightElement(el)
      } catch {
        /* unknown language - leave as plain text */
      }
    }
  }, [text])

  return <div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: render(text) }} />
})
