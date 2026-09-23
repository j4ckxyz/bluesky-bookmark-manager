import { Download, Search, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type SearchParams } from '../lib/api.ts'
import { useDismiss } from '../lib/hooks.ts'
import type { SearchFacets, SortOrder, StatusFilter } from '../lib/types.ts'

export type Filters = {
  has: string[]
  is: string[]
  after: string
  before: string
}

export const EMPTY_FILTERS: Filters = { has: [], is: [], after: '', before: '' }

const HAS_OPTIONS = [
  { value: 'link', label: 'Links' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Video' },
  { value: 'alt', label: 'Alt text' },
  { value: 'quote', label: 'Quotes' },
  { value: 'tag', label: 'Hashtags' },
  { value: 'mention', label: 'Mentions' },
  { value: 'labels', label: 'Labels' },
]

const IS_OPTIONS = [
  { value: 'reply', label: 'Replies' },
  { value: 'root', label: 'Top-level' },
  { value: 'verified', label: 'Verified author' },
  { value: 'deleted', label: 'Deleted upstream' },
]

const SORT_OPTIONS: Array<{ value: SortOrder; label: string }> = [
  { value: 'relevance', label: 'Best match' },
  { value: 'saved', label: 'Recently saved' },
  { value: 'oldest-saved', label: 'Saved first' },
  { value: 'posted', label: 'Recently posted' },
  { value: 'oldest-posted', label: 'Oldest posted' },
  { value: 'likes', label: 'Most liked' },
  { value: 'reposts', label: 'Most reposted' },
]

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'active', label: 'Current' },
  { value: 'removed', label: 'Un-bookmarked' },
  { value: 'all', label: 'Everything' },
]

const EXPORT_OPTIONS = [
  { format: 'html', label: 'Bookmarks HTML', hint: 'The standard browsers, Raindrop and Pocket import' },
  { format: 'json', label: 'JSON', hint: 'Every field, including all derived metadata' },
  { format: 'csv', label: 'CSV', hint: 'One row per bookmark, for spreadsheets' },
  { format: 'ndjson', label: 'NDJSON', hint: 'One JSON object per line, for streaming' },
]

type Props = {
  query: string
  onQueryChange: (value: string) => void
  sort: SortOrder
  onSortChange: (value: SortOrder) => void
  status: StatusFilter
  onStatusChange: (value: StatusFilter) => void
  filters: Filters
  onFiltersChange: (filters: Filters) => void
  facets: SearchFacets | undefined
  total: number
  took: number
  loading: boolean
  corrections: Array<{ from: string; to: string[] }>
  exportParams: SearchParams
}

export function SearchPanel(props: Props) {
  const {
    query,
    onQueryChange,
    sort,
    onSortChange,
    status,
    onStatusChange,
    filters,
    onFiltersChange,
    facets,
    total,
    took,
    loading,
    corrections,
    exportParams,
  } = props

  const [showFilters, setShowFilters] = useState(false)
  const [showExport, setShowExport] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const exportRef = useDismiss(() => setShowExport(false), showExport)
  const exportButtonRef = useRef<HTMLButtonElement>(null)
  const exportWasOpen = useRef(false)

  // Menu-button pattern: focus moves into the menu when it opens and back to
  // the button when it closes, so keyboard users are never stranded.
  useEffect(() => {
    if (showExport) {
      exportRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    } else if (exportWasOpen.current && exportRef.current?.contains(document.activeElement)) {
      exportButtonRef.current?.focus()
    }
    exportWasOpen.current = showExport
  }, [showExport, exportRef])

  const onExportMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
      return
    }
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus()
  }

  // "/" focuses search, the way every search-first tool behaves.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
      if (event.key === '/' && !typing) {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const toggle = (key: 'has' | 'is', value: string): void => {
    const current = filters[key]
    onFiltersChange({
      ...filters,
      [key]: current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value],
    })
  }

  const activeCount =
    filters.has.length + filters.is.length + (filters.after ? 1 : 0) + (filters.before ? 1 : 0)

  const appendToQuery = (fragment: string): void => {
    onQueryChange(query.includes(fragment) ? query : `${query} ${fragment}`.trim())
  }

  return (
    <section aria-label="Search">
      <div className="searchbar">
        <Search size={17} className="searchbar__icon" aria-hidden="true" />
        <input
          ref={inputRef}
          className="searchbar__input"
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder='Search your bookmarks — try "exact phrase", from:@handle, has:link'
          aria-label="Search your bookmarks"
          autoComplete="off"
          spellCheck={false}
        />
        {query ? (
          <button
            type="button"
            className="button button--ghost button--icon"
            onClick={() => onQueryChange('')}
            aria-label="Clear search"
          >
            <X size={15} />
          </button>
        ) : (
          <kbd className="searchbar__hint">/</kbd>
        )}
      </div>

      <div className="toolbar">
        <span className="toolbar__count" aria-live="polite">
          {loading
            ? 'Searching…'
            : `${total.toLocaleString('en-GB')} ${total === 1 ? 'bookmark' : 'bookmarks'}`}
          {!loading && took > 0 && (
            <span style={{ color: 'var(--text-faint)' }}> · {took.toFixed(1)}ms</span>
          )}
        </span>

        <button
          type="button"
          className={`button button--small${showFilters || activeCount > 0 ? ' button--primary' : ''}`}
          onClick={() => setShowFilters((open) => !open)}
          aria-expanded={showFilters}
        >
          <SlidersHorizontal size={13} />
          Filters
          {activeCount > 0 && ` (${activeCount})`}
        </button>

        <select
          className="select"
          value={status}
          onChange={(event) => onStatusChange(event.target.value as StatusFilter)}
          aria-label="Which bookmarks to include"
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          className="select"
          value={sort}
          onChange={(event) => onSortChange(event.target.value as SortOrder)}
          aria-label="Sort order"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <div className="dropdown" ref={exportRef}>
          <button
            ref={exportButtonRef}
            type="button"
            className="button button--small"
            onClick={() => setShowExport((open) => !open)}
            aria-expanded={showExport}
            aria-haspopup="menu"
          >
            <Download size={13} />
            Export
          </button>
          {showExport && (
            <div className="dropdown__menu" role="menu" aria-label="Export" onKeyDown={onExportMenuKeyDown}>
              <p className="hint" style={{ padding: '6px 9px 8px' }}>
                Exports whatever your current search matches.
              </p>
              {EXPORT_OPTIONS.map((option) => (
                <a
                  key={option.format}
                  className="dropdown__item"
                  role="menuitem"
                  href={api.exportUrl(option.format, exportParams)}
                  onClick={() => setShowExport(false)}
                  download
                >
                  <span>
                    <strong style={{ fontWeight: 550 }}>{option.label}</strong>
                    <span className="dropdown__item-hint">{option.hint}</span>
                  </span>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      {corrections.length > 0 && (
        <p className="hint" style={{ marginTop: 10 }}>
          Also searched for{' '}
          {corrections.map((correction, index) => (
            <span key={correction.from}>
              {index > 0 && ', '}
              <em>{correction.to.join(', ')}</em> instead of <em>{correction.from}</em>
            </span>
          ))}
          .
        </p>
      )}

      {showFilters && (
        <div className="filters">
          <fieldset className="filters__group" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="filters__legend">Contains</legend>
            <div className="filters__chips">
              {HAS_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`chip${filters.has.includes(option.value) ? ' chip--active' : ''}`}
                  aria-pressed={filters.has.includes(option.value)}
                  onClick={() => toggle('has', option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="filters__group" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="filters__legend">Kind</legend>
            <div className="filters__chips">
              {IS_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`chip${filters.is.includes(option.value) ? ' chip--active' : ''}`}
                  aria-pressed={filters.is.includes(option.value)}
                  onClick={() => toggle('is', option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="filters__group">
            <div className="filters__legend">Posted between</div>
            <div className="filters__dates">
              <input
                type="date"
                value={filters.after}
                onChange={(event) => onFiltersChange({ ...filters, after: event.target.value })}
                aria-label="Posted on or after"
              />
              <span className="hint">to</span>
              <input
                type="date"
                value={filters.before}
                onChange={(event) => onFiltersChange({ ...filters, before: event.target.value })}
                aria-label="Posted on or before"
              />
            </div>
            {activeCount > 0 && (
              <button
                type="button"
                className="button button--small button--ghost"
                style={{ marginTop: 10 }}
                onClick={() => onFiltersChange(EMPTY_FILTERS)}
              >
                <X size={13} /> Clear filters
              </button>
            )}
          </div>

          {facets && facets.authors.length > 1 && (
            <div className="filters__group">
              <div className="filters__legend">Top accounts</div>
              <div className="filters__chips">
                {facets.authors.slice(0, 8).map((author) => (
                  <button
                    key={author.value}
                    type="button"
                    className="chip"
                    onClick={() => appendToQuery(`from:@${author.value}`)}
                  >
                    @{author.value} <span style={{ color: 'var(--text-faint)' }}>{author.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {facets && facets.domains.length > 0 && (
            <div className="filters__group">
              <div className="filters__legend">Top domains</div>
              <div className="filters__chips">
                {facets.domains.slice(0, 8).map((domain) => (
                  <button
                    key={domain.value}
                    type="button"
                    className="chip"
                    onClick={() => appendToQuery(`domain:${domain.value}`)}
                  >
                    {domain.value} <span style={{ color: 'var(--text-faint)' }}>{domain.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {facets && facets.tags.length > 0 && (
            <div className="filters__group">
              <div className="filters__legend">Top hashtags</div>
              <div className="filters__chips">
                {facets.tags.slice(0, 8).map((tag) => (
                  <button
                    key={tag.value}
                    type="button"
                    className="chip"
                    onClick={() => appendToQuery(`#${tag.value}`)}
                  >
                    #{tag.value} <span style={{ color: 'var(--text-faint)' }}>{tag.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
