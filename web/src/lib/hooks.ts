import { useEffect, useRef, useState } from 'react'
import type { SyncProgress } from './types.ts'

/** Delays a value until it stops changing, for as-you-type requests. */
export function useDebounced<T>(value: T, delayMs = 220): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}

/**
 * Subscribes to the server's sync event stream. Falls back to polling if the
 * stream cannot be established, so progress is never simply stuck.
 */
export function useSyncStatus(enabled: boolean, initial: SyncProgress | null = null) {
  const [status, setStatus] = useState<SyncProgress | null>(initial)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setStatus(null)
      setConnected(false)
      return
    }

    let cancelled = false
    let pollTimer: ReturnType<typeof setInterval> | undefined

    const source = new EventSource('/api/v1/sync/events')

    source.addEventListener('status', (event) => {
      if (cancelled) return
      try {
        setStatus(JSON.parse((event as MessageEvent<string>).data) as SyncProgress)
        setConnected(true)
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    })

    source.onopen = () => {
      if (!cancelled) setConnected(true)
    }

    source.onerror = () => {
      if (cancelled) return
      setConnected(false)
      // EventSource reconnects on its own; poll meanwhile so the UI moves.
      pollTimer ??= setInterval(() => {
        void fetch('/api/v1/sync/status', { credentials: 'same-origin' })
          .then((r) => (r.ok ? r.json() : null))
          .then((body: { status: SyncProgress | null } | null) => {
            if (!cancelled && body) setStatus(body.status)
          })
          .catch(() => undefined)
      }, 8000)
    }

    return () => {
      cancelled = true
      source.close()
      if (pollTimer) clearInterval(pollTimer)
    }
  }, [enabled])

  return { status, connected, setStatus }
}

export type ThemePreference = 'system' | 'light' | 'dark'

const THEME_KEY = 'bookmarks:theme'

/**
 * Follows the operating system by default; a manual choice is remembered and
 * applied via `data-theme` on the document element.
 */
export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY)
      return stored === 'light' || stored === 'dark' ? stored : 'system'
    } catch {
      return 'system'
    }
  })

  useEffect(() => {
    const root = document.documentElement
    if (preference === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', preference)

    try {
      if (preference === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, preference)
    } catch {
      // Private browsing blocks storage; the in-memory choice still applies.
    }
  }, [preference])

  return [preference, setPreference]
}

/** Calls back when a click or Escape lands outside the referenced element. */
export function useDismiss(onDismiss: () => void, active = true) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!active) return

    const onPointerDown = (event: MouseEvent | TouchEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss()
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onDismiss, active])

  return ref
}

/** How often, at most, to ask the server whether a newer build is deployed. */
const VERSION_CHECK_MS = 5 * 60_000

/**
 * True once the server is serving a different build from the one this tab is
 * running. An installed app can stay open for days; this is how it finds out
 * it is talking to a newer back end. The check compares the hashed bundle
 * named in the live index.html with the one this page loaded.
 */
export function useNewVersionAvailable(): boolean {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')
    // Dev server, or no hashed bundle to compare against.
    if (!script) return
    const current = new URL(script.src).pathname

    let lastChecked = 0
    const check = async (): Promise<void> => {
      if (document.visibilityState !== 'visible' || Date.now() - lastChecked < VERSION_CHECK_MS) return
      lastChecked = Date.now()
      try {
        const response = await fetch('/', { cache: 'no-store', headers: { accept: 'text/html' } })
        if (!response.ok) return
        const html = await response.text()
        if (html.includes('/assets/') && !html.includes(current)) setAvailable(true)
      } catch {
        // Offline; try again next time the app comes to the front.
      }
    }

    const timer = window.setInterval(() => void check(), VERSION_CHECK_MS)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  return available
}
