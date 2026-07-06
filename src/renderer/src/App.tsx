import { CircleAlert, Info } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { store, useApp } from './store'
import { Board } from './components/Board'
import { Modals } from './components/Modals'
import { SessionView } from './components/SessionView'
import { Sidebar } from './components/Sidebar'
import { Welcome } from './components/Welcome'

export default function App(): ReactNode {
  const state = useApp()

  // ⌘K anywhere opens the command palette (toggles if already open)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        store.openModal(store.state.modal?.m === 'palette' ? null : { m: 'palette' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!state.booted) {
    return <div className="boot" />
  }

  const sessionRow =
    state.view.kind === 'session' ? state.sessions.find((s) => s.id === (state.view as { id: string }).id) : null

  return (
    <div className="app">
      <div className="drag-bar" />
      <Sidebar state={state} />
      <main className="main">
        {state.view.kind === 'welcome' || state.sessions.length === 0 ? (
          <Welcome state={state} />
        ) : state.view.kind === 'board' || !sessionRow ? (
          <Board state={state} />
        ) : (
          <SessionView state={state} row={sessionRow} />
        )}
      </main>

      <div className="toasts">
        {state.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.level === 'error' ? <CircleAlert size={14} /> : <Info size={14} />}
            {t.message}
          </div>
        ))}
      </div>

      <Modals state={state} />
    </div>
  )
}
