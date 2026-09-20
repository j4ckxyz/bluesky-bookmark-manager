import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './styles/app.css'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

/*
 * The service worker makes the app installable and lets it open offline. It is
 * registered after load so it never competes with the first render, and only
 * over a secure context — browsers treat localhost as secure, but a plain-HTTP
 * LAN address is not, and registering there would throw.
 */
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // An unregistered worker only costs offline support; the app still runs.
    })
  })
}
