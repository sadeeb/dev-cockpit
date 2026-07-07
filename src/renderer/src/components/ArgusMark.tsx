import type { ReactNode } from 'react'

/**
 * The Argus eye, as an inline mark. Mirrors the app icon; larger sizes get
 * the lashes and the three watched-session dots, small sizes stay legible.
 */
export function ArgusMark({ size = 18 }: { size?: number }): ReactNode {
  const detailed = size >= 36
  return (
    <svg className="argus-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden>
      {detailed && (
        <g stroke="#0d0b09" strokeWidth="6" strokeLinecap="round">
          <line x1="26" y1="24" x2="21" y2="15" />
          <line x1="50" y1="19" x2="50" y2="9" />
          <line x1="74" y1="24" x2="79" y2="15" />
        </g>
      )}
      <path
        d={detailed ? 'M 8 48 Q 50 18 92 48 Q 50 78 8 48 Z' : 'M 5 50 Q 50 14 95 50 Q 50 86 5 50 Z'}
        fill="#ffffff"
        stroke="#0d0b09"
        strokeWidth="7"
        strokeLinejoin="round"
      />
      <circle cx="50" cy={detailed ? 48 : 50} r="16" fill="#0072e3" stroke="#0d0b09" strokeWidth="6" />
      <circle cx="50" cy={detailed ? 48 : 50} r="6.5" fill="#0d0b09" />
      <circle cx="45" cy={detailed ? 43 : 45} r="3" fill="#ffffff" />
      {detailed && (
        <g stroke="#0d0b09" strokeWidth="4">
          <circle cx="35" cy="89" r="6" fill="#ffb200" />
          <circle cx="50" cy="92" r="6" fill="#00aa3c" />
          <circle cx="65" cy="89" r="6" fill="#ff6100" />
        </g>
      )}
    </svg>
  )
}
