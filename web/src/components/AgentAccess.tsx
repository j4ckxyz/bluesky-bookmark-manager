import { Bot, Check, Copy, Download, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import type { ApiToken } from '../lib/types.ts'
import { TokenList } from './TokenList.tsx'

/** Must match TOKEN_PLACEHOLDER in server/src/agent/skill.ts. */
const TOKEN_PLACEHOLDER = '<YOUR_AGENT_TOKEN>'

const EXPIRY_OPTIONS: Array<{ label: string; days: number | null }> = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
  { label: 'Never', days: null },
]

type Props = {
  tokens: ApiToken[]
  busy: boolean
  onCreated: () => Promise<void>
  onRevoke: (hint: string) => void
}

/**
 * Creates read-only agent tokens and hands over a SKILL.md with the token
 * and this server's address already filled in, ready to paste into an agent.
 */
export function AgentAccess({ tokens, busy, onCreated, onRevoke }: Props) {
  const [name, setName] = useState('')
  const [expiryDays, setExpiryDays] = useState<number | null>(90)
  const [creating, setCreating] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [template, setTemplate] = useState<string | null>(null)
  const [copied, setCopied] = useState<'skill' | 'token' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const origin = typeof window === 'undefined' ? '' : window.location.origin

  useEffect(() => {
    api
      .agentSkill(origin)
      .then(setTemplate)
      .catch(() => setTemplate(null))
  }, [origin])

  const skill = template && token ? template.replaceAll(TOKEN_PLACEHOLDER, token) : template

  const create = async (): Promise<void> => {
    setCreating(true)
    setError(null)
    try {
      const created = await api.createToken(name.trim() || 'AI agent', {
        scope: 'agent',
        expiresInDays: expiryDays,
      })
      setToken(created.token)
      setName('')
      await onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a token.')
    } finally {
      setCreating(false)
    }
  }

  const copy = async (what: 'skill' | 'token'): Promise<void> => {
    const text = what === 'skill' ? skill : token
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(null), 1800)
    } catch {
      setError('Your browser blocked clipboard access. Use Download, or select the text below.')
    }
  }

  const download = (): void => {
    if (!skill) return
    const url = URL.createObjectURL(new Blob([skill], { type: 'text/markdown' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'SKILL.md'
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="panel">
      <h2 className="panel__title">
        <Bot size={14} /> Agent access
      </h2>
      <p className="hint" style={{ marginBottom: 14 }}>
        Let an AI agent search and read your bookmarks. Agent tokens are read-only and can only
        reach <span className="code">/api/agent/v1</span>: they can search, filter and read this
        archive, but cannot sync, change settings, create tokens or see anyone else&rsquo;s
        bookmarks. Revoke one at any time.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <input
          className="input"
          style={{ flex: '1 1 200px' }}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Which agent is this for?"
          maxLength={80}
          aria-label="Agent token name"
        />
        <select
          className="select"
          value={expiryDays ?? 'never'}
          onChange={(event) =>
            setExpiryDays(event.target.value === 'never' ? null : Number(event.target.value))
          }
          aria-label="Token expiry"
        >
          {EXPIRY_OPTIONS.map((option) => (
            <option key={option.label} value={option.days ?? 'never'}>
              Expires: {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button button--primary"
          onClick={() => void create()}
          disabled={creating || busy}
        >
          <Plus size={14} />
          Create agent token
        </button>
      </div>

      {token && (
        <div
          className="panel"
          style={{ background: 'var(--accent-soft)', borderColor: 'transparent', marginBottom: 14 }}
        >
          <div className="setting-row__label" style={{ marginBottom: 6 }}>
            Copy the skill now — the token inside it is not shown again
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <code className="code" style={{ flex: 1, padding: '6px 9px' }}>
              {token}
            </code>
            <button type="button" className="button button--small" onClick={() => void copy('token')}>
              {copied === 'token' ? <Check size={13} /> : <Copy size={13} />}
              {copied === 'token' ? 'Copied' : 'Copy token'}
            </button>
          </div>
          <p className="hint">
            The skill below already contains this token and this server&rsquo;s address. Paste it
            into your agent, or save it as{' '}
            <span className="code">~/.claude/skills/bluesky-bookmarks/SKILL.md</span> for Claude
            Code.
          </p>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className={`button${token ? ' button--primary' : ''}`}
          onClick={() => void copy('skill')}
          disabled={!skill}
        >
          {copied === 'skill' ? <Check size={14} /> : <Copy size={14} />}
          {copied === 'skill' ? 'Copied' : token ? 'Copy skill with token' : 'Copy skill'}
        </button>
        <button type="button" className="button" onClick={download} disabled={!skill}>
          <Download size={14} />
          Download SKILL.md
        </button>
      </div>
      {!token && (
        <p className="hint" style={{ marginBottom: 10 }}>
          Create a token first and the skill is copied with it filled in. Copied now, it carries a
          placeholder for you to replace.
        </p>
      )}

      {skill && (
        <details className="skill-preview">
          <summary>Preview the skill</summary>
          <pre className="code-block">{skill}</pre>
        </details>
      )}

      <TokenList tokens={tokens} busy={busy} onRevoke={onRevoke} />

      {error && (
        <div className="error-box" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </section>
  )
}
