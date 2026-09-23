import {
  BarChart3,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Search as SearchIcon,
  Settings as SettingsIcon,
  SearchX,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookmarkCard } from './components/BookmarkCard.tsx'
import { EMPTY_FILTERS, SearchPanel, type Filters } from './components/SearchPanel.tsx'
import { SettingsView } from './components/SettingsView.tsx'
import { SignIn } from './components/SignIn.tsx'
import { StatsView } from './components/StatsView.tsx'
import { SyncBanner } from './components/SyncBanner.tsx'
import { api, type SearchParams } from './lib/api.ts'
import { useDebounced, useNewVersionAvailable, useSyncStatus, useTheme } from './lib/hooks.ts'
import type {
  Account,
  InstanceInfo,
  SearchResponse,
  SortOrder,
  StatusFilter,
} from './lib/types.ts'

type Tab = 'search' | 'stats' | 'settings'
const PAGE_SIZE = 25

export default function App() {
  const [account, setAccount] = useState<Account | null>(null)
  const [providerLabel, setProviderLabel] = useState<string | null>(null)
  const [instance, setInstance] = useState<InstanceInfo | null>(null)
  const [booting, setBooting] = useState(true)
  const [tab, setTab] = useState<Tab>('search')
  const [theme, setTheme] = useTheme()

  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortOrder | null>(null)
  const [status, setStatus] = useState<StatusFilter>('active')
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [page, setPage] = useState(0)

  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  /** Bumped to re-run the current search without touching its inputs. */
  const [refreshKey, setRefreshKey] = useState(0)

  const debouncedQuery = useDebounced(query, 220)
  const newVersion = useNewVersionAvailable()
  const { status: syncStatus, setStatus: setSyncStatus } = useSyncStatus(account !== null)
  const previousSyncRef = useRef<string | null>(null)

  const loadSession = useCallback(async (): Promise<void> => {
    try {
      const [session, info] = await Promise.all([api.session(), api.instance()])
      setAccount(session.account)
      setProviderLabel(session.providerLabel ?? null)
      setInstance(info)
      if (session.sync) setSyncStatus(session.sync)
    } catch {
      setAccount(null)
    } finally {
      setBooting(false)
    }
  }, [setSyncStatus])

  useEffect(() => {
    void loadSession()
  }, [loadSession])

  const searchParams = useMemo<SearchParams>(
    () => ({
      q: debouncedQuery,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      status,
      facets: true,
      ...(sort ? { sort } : {}),
      ...(filters.has.length > 0 ? { has: filters.has } : {}),
      ...(filters.is.length > 0 ? { is: filters.is } : {}),
      ...(filters.after ? { after: filters.after } : {}),
      ...(filters.before ? { before: filters.before } : {}),
    }),
    [debouncedQuery, page, sort, status, filters],
  )

  // Any change to the query or filters starts again from the first page.
  useEffect(() => {
    setPage(0)
  }, [debouncedQuery, status, sort, filters])

  useEffect(() => {
    if (!account || tab !== 'search') return

    const controller = new AbortController()
    setSearching(true)
    setSearchError(null)

    api
      .search(searchParams, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setResponse(result)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setSearchError(err instanceof Error ? err.message : 'Search failed.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false)
      })

    return () => controller.abort()
  }, [account, tab, searchParams, refreshKey])

  // Refresh results the moment a sync finishes, so new bookmarks just appear.
  useEffect(() => {
    if (!syncStatus) return
    const key = `${syncStatus.id}:${syncStatus.status}`
    const finished = syncStatus.status !== 'running' && !syncStatus.active
    if (finished && previousSyncRef.current !== key) {
      previousSyncRef.current = key
      setSyncBusy(false)
      if (syncStatus.created + syncStatus.removed + syncStatus.restored > 0) {
        // Re-run the search in place: the current results stay on screen
        // until the fresh page arrives, rather than flashing an empty state.
        setRefreshKey((key) => key + 1)
      }
    }
  }, [syncStatus])

  const applyFilterFragment = useCallback((fragment: string): void => {
    setTab('search')
    setQuery((current) => (current.includes(fragment) ? current : `${current} ${fragment}`.trim()))
  }, [])

  const startSync = async (): Promise<void> => {
    setSyncBusy(true)
    try {
      const result = await api.startSync()
      if (result.status) setSyncStatus(result.status)
    } catch {
      setSyncBusy(false)
    }
  }

  const cancelSync = async (): Promise<void> => {
    try {
      const result = await api.cancelSync()
      if (result.status) setSyncStatus(result.status)
    } finally {
      setSyncBusy(false)
    }
  }

  if (booting) {
    return (
      <div className="signin">
        <Loader2 size={22} className="spin" aria-label="Loading" />
      </div>
    )
  }

  if (!account) {
    return <SignIn instance={instance} onSignedIn={() => void loadSession()} />
  }

  const total = response?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const backfilling = syncStatus?.active === true && syncStatus.mode === 'backfill'

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__inner">
          <div className="brand">
            <span className="brand__mark" aria-hidden="true">
              <Bookmark size={15} strokeWidth={2.4} />
            </span>
            Bookmarks
          </div>

          <div className="topbar__spacer" />

          <nav className="topbar__nav" aria-label="Sections">
            <button
              className={`topbar__tab${tab === 'search' ? ' topbar__tab--active' : ''}`}
              onClick={() => setTab('search')}
              aria-current={tab === 'search'}
            >
              <SearchIcon size={14} />
              Search
            </button>
            <button
              className={`topbar__tab${tab === 'stats' ? ' topbar__tab--active' : ''}`}
              onClick={() => setTab('stats')}
              aria-current={tab === 'stats'}
            >
              <BarChart3 size={14} />
              Stats
            </button>
            <button
              className={`topbar__tab${tab === 'settings' ? ' topbar__tab--active' : ''}`}
              onClick={() => setTab('settings')}
              aria-current={tab === 'settings'}
            >
              <SettingsIcon size={14} />
              Settings
            </button>
          </nav>
        </div>
      </header>

      <main className="main">
        {newVersion && (
          <div className="update-notice" role="status">
            <span>A new version of the app is available.</span>
            <button type="button" className="button button--small" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        )}

        {tab !== 'settings' && (
          <SyncBanner
            status={syncStatus}
            intervalMinutes={instance?.syncIntervalMinutes ?? 10}
            onRefresh={() => void startSync()}
            onCancel={() => void cancelSync()}
            busy={syncBusy}
          />
        )}

        {tab === 'search' && (
          <>
            <SearchPanel
              query={query}
              onQueryChange={setQuery}
              sort={sort ?? response?.sort ?? 'saved'}
              onSortChange={setSort}
              status={status}
              onStatusChange={setStatus}
              filters={filters}
              onFiltersChange={setFilters}
              facets={response?.facets}
              total={total}
              took={response?.took ?? 0}
              loading={searching && response === null}
              corrections={response?.corrections ?? []}
              exportParams={searchParams}
            />

            {searchError && (
              <div className="error-box" role="alert" style={{ marginTop: 16 }}>
                {searchError}
              </div>
            )}

            <div className="results">
              {searching && response === null ? (
                Array.from({ length: 4 }, (_, index) => <div key={index} className="skeleton" />)
              ) : response && response.results.length > 0 ? (
                response.results.map((bookmark) => (
                  <BookmarkCard
                    key={bookmark.id}
                    bookmark={bookmark}
                    terms={response.terms}
                    onFilter={applyFilterFragment}
                  />
                ))
              ) : backfilling ? (
                <div className="empty">
                  <Loader2 size={26} className="spin empty__icon" />
                  <p className="empty__title">Fetching your bookmarks</p>
                  <p>Results appear here as they arrive.</p>
                </div>
              ) : (
                <div className="empty">
                  <SearchX size={26} className="empty__icon" />
                  <p className="empty__title">
                    {query || filters.has.length + filters.is.length > 0
                      ? 'Nothing matched'
                      : 'No bookmarks yet'}
                  </p>
                  <p>
                    {query || filters.has.length + filters.is.length > 0
                      ? 'Try fewer words, or drop a filter. Unquoted words tolerate typos; quoted ones do not.'
                      : 'Bookmark a few posts on Bluesky, then sync.'}
                  </p>
                </div>
              )}
            </div>

            {totalPages > 1 && (
              <nav className="pagination" aria-label="Pagination">
                <button
                  className="button button--small"
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                  disabled={page === 0}
                >
                  <ChevronLeft size={14} />
                  Previous
                </button>
                <span>
                  Page {page + 1} of {totalPages.toLocaleString('en-GB')}
                </span>
                <button
                  className="button button--small"
                  onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}
                  disabled={page >= totalPages - 1}
                >
                  Next
                  <ChevronRight size={14} />
                </button>
              </nav>
            )}
          </>
        )}

        {tab === 'stats' && <StatsView onFilter={applyFilterFragment} />}

        {tab === 'settings' && (
          <SettingsView
            account={account}
            instance={instance}
            providerLabel={providerLabel}
            theme={theme}
            onThemeChange={setTheme}
            onSignedOut={() => {
              setAccount(null)
              setResponse(null)
            }}
          />
        )}
      </main>
    </div>
  )
}
