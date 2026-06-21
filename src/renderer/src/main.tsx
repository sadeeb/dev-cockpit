import React from 'react'
import { createRoot } from 'react-dom/client'
import 'highlight.js/styles/github-dark.css'
import './styles.css'
import App from './App'
import { store } from './store'

void store.boot()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
