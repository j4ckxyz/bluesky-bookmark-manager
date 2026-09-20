import { BadgeCheck, User } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import { useDebounced } from '../lib/hooks.ts'
import type { TypeaheadActor } from '../lib/types.ts'

type Props = {
  value: string
  onChange: (value: string) => void
  onPick: (actor: TypeaheadActor) => void
  disabled?: boolean
  id?: string
}

/**
 * Handle field with suggestions from the public directory, so people can
 * click their own account instead of typing it exactly.
 */
export function HandleTypeahead({ value, onChange, onPick, disabled, id }: Props) {
  const [actors, setActors] = useState<TypeaheadActor[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const query = useDebounced(value.trim().replace(/^@/, ''), 200)

  useEffect(() => {
    if (query.length < 2) {
      setActors([])
      return
    }

    const controller = new AbortController()
    let cancelled = false

    api
      .typeahead(query, controller.signal)
      .then((result) => {
        if (cancelled) return
        setActors(result.actors)
        setActiveIndex(-1)
      })
      .catch(() => {
        // The directory being unreachable must not block typing a handle.
        if (!cancelled) setActors([])
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [query])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  const suggestions = open && actors.length > 0 ? actors : []

  const choose = (actor: TypeaheadActor): void => {
    onChange(actor.handle)
    onPick(actor)
    setOpen(false)
    setActors([])
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (suggestions.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1))
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault()
      const actor = suggestions[activeIndex]
      if (actor) choose(actor)
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="typeahead" ref={containerRef}>
      <input
        id={id}
        className="input"
        type="text"
        value={value}
        placeholder="you.bsky.social"
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={disabled}
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(event) => {
          onChange(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {suggestions.length > 0 && (
        <ul className="typeahead__menu" id={listId} role="listbox">
          {suggestions.map((actor, index) => (
            <li key={actor.did} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={`typeahead__option${index === activeIndex ? ' typeahead__option--active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(actor)}
              >
                {actor.avatar ? (
                  <img className="typeahead__avatar" src={actor.avatar} alt="" loading="lazy" />
                ) : (
                  <span className="typeahead__avatar typeahead__option--active" aria-hidden="true">
                    <User size={15} />
                  </span>
                )}
                <span className="typeahead__text">
                  <span className="typeahead__name">
                    {actor.displayName || actor.handle}
                    {actor.verified && (
                      <BadgeCheck
                        size={13}
                        className="bookmark__verified"
                        aria-label="Verified"
                        style={{ display: 'inline', verticalAlign: '-2px', marginLeft: 3 }}
                      />
                    )}
                  </span>
                  <span className="typeahead__handle">@{actor.handle}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
