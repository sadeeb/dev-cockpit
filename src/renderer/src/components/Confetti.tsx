import { useEffect, useMemo, useState, type ReactNode } from 'react'

/** A one-shot confetti burst — the cockpit celebrates a finished plan. */

const COLORS = ['#0072e3', '#ffb200', '#ff6100', '#00aa3c', '#ab54f7', '#ea3737']

export function ConfettiBurst(): ReactNode {
  const [gone, setGone] = useState(false)
  const pieces = useMemo(
    () =>
      Array.from({ length: 90 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.35,
        dur: 1.2 + Math.random() * 1.0,
        color: COLORS[i % COLORS.length],
        w: 6 + Math.random() * 6,
        h: 4 + Math.random() * 4,
        spin: Math.round(Math.random() * 900 - 450)
      })),
    []
  )

  useEffect(() => {
    const t = setTimeout(() => setGone(true), 2800)
    return () => clearTimeout(t)
  }, [])

  if (gone) return null
  return (
    <div className="confetti" aria-hidden>
      {pieces.map((p, i) => (
        <span
          key={i}
          style={{
            left: `${p.left}%`,
            background: p.color,
            width: p.w,
            height: p.h,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
            ['--spin' as never]: `${p.spin}deg`
          }}
        />
      ))}
    </div>
  )
}
