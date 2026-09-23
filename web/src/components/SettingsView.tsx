import { Copy, Key, LogOut, Plus, Trash2, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import { fullDate, relativeTime } from '../lib/format.ts'
import type { ThemePreference } from '../lib/hooks.ts'
import type { Account, ApiToken, InstanceInfo } from '../lib/types.ts'
import { ConfirmButton } from './ConfirmButton.tsx'

type Props = {
  account: Account
  instance: InstanceInfo | null
  providerLabel: string | null
  theme: ThemePreference
  onThemeChange: (theme: ThemePreference) => void
  onSignedOut: () => void
}

export function SettingsView({
  account,
  instance,
  providerLabel,
  theme,
  onThemeChange,
  onSignedOut,
}: Props) {
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [newToken, setNewToken] = useState<string | null>(null)
  const [tokenName, setTokenName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    api
      .tokens()
      .then((result) => setTokens(result.tokens))
      .catch(() => setTokens([]))
  }, [])

  const createToken = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const created = await api.createToken(tokenName.trim() || 'API token')
      setNewToken(created.token)
      setTokenName('')
      setTokens((await api.tokens()).tokens)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a token.')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (hint: string): Promise<void> => {
    setBusy(true)
    try {
      await api.revokeToken(hint)
      setTokens((await api.tokens()).tokens)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke that token.')
    } finally {
      setBusy(false)
    }
  }

  const copyToken = async (): Promise<void> => {
    if (!newToken) return
    try {
      await navigator.clipboard.writeText(newToken)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      // Clipboard access can be denied; the token is on screen to copy by hand.
    }
  }

  const origin = typeof window === 'undefined' ? '' : window.location.origin

  return (
    <div className="settings">
      <section className="panel">
        <h2 className="panel__title">Account</h2>
        <div className="setting-row">
          <div>
            <div className="setting-row__label">@{account.handle}</div>
            <div className="setting-row__hint">
              {account.displayName ? `${account.displayName} · ` : ''}
              <span className="code">{account.did}</span>
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-row__label">Hosting provider</div>
            <div className="setting-row__hint">
              {providerLabel ?? 'Unknown'} · <span className="code">{account.pdsUrl}</span>
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-row__label">Syncing</div>
            <div className="setting-row__hint">
              Every {instance?.syncIntervalMinutes ?? 10} minutes. Last run{' '}
              {relativeTime(account.lastSyncAt)}
              {account.backfillCompletedAt
                ? `, first backfill finished ${relativeTime(account.backfillCompletedAt)}.`
                : '. The first backfill has not finished yet.'}
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2 className="panel__title">Appearance</h2>
        <div className="setting-row">
          <div>
            <div className="setting-row__label">Theme</div>
            <div className="setting-row__hint">
              Follows your system by default.
            </div>
          </div>
          <div className="segmented" role="group" aria-label="Theme">
            {(['system', 'light', 'dark'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={`segmented__option${theme === option ? ' segmented__option--active' : ''}`}
                aria-pressed={theme === option}
                onClick={() => onThemeChange(option)}
              >
                {option === 'system' ? 'Auto' : option === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="panel">
        <h2 className="panel__title">
          <Key size={14} /> API access
        </h2>
        <p className="hint" style={{ marginBottom: 14 }}>
          Read your archive from other tools over the same API this page uses. Send the token as{' '}
          <span className="code">Authorization: Bearer …</span>.
        </p>

        <pre className="code-block" style={{ marginBottom: 14 }}>
          {`curl -H "Authorization: Bearer $TOKEN" \\
  "${origin}/api/v1/search?q=atproto&has=link&limit=10"`}
        </pre>

        {newToken && (
          <div
            className="panel"
            style={{ background: 'var(--accent-soft)', borderColor: 'transparent', marginBottom: 14 }}
          >
            <div className="setting-row__label" style={{ marginBottom: 6 }}>
              Copy this now — it is not shown again
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code className="code" style={{ flex: 1, padding: '6px 9px' }}>
                {newToken}
              </code>
              <button type="button" className="button button--small" onClick={copyToken}>
                <Copy size={13} />
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input
            className="input"
            type="text"
            value={tokenName}
            onChange={(event) => setTokenName(event.target.value)}
            placeholder="What is this token for?"
            maxLength={80}
          />
          <button
            type="button"
            className="button button--primary"
            onClick={() => void createToken()}
            disabled={busy}
          >
            <Plus size={14} />
            Create
          </button>
        </div>

        {tokens.length === 0 ? (
          <p className="hint">No tokens yet.</p>
        ) : (
          <div>
            {tokens.map((token) => (
              <div key={token.hint} className="token-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 550 }}>{token.name}</div>
                  <div className="hint">
                    <span className="code">{token.hint}</span> · created{' '}
                    {fullDate(token.createdAt)} ·{' '}
                    {token.lastUsedAt ? `last used ${relativeTime(token.lastUsedAt)}` : 'never used'}
                  </div>
                </div>
                <ConfirmButton
                  className="button--small"
                  confirmLabel="Click to revoke"
                  onConfirm={() => void revoke(token.hint)}
                  disabled={busy}
                  aria-label={`Revoke ${token.name}`}
                >
                  <Trash2 size={13} />
                  Revoke
                </ConfirmButton>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="error-box" role="alert" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </section>

      <section className="panel">
        <h2 className="panel__title">Session</h2>
        <div className="setting-row">
          <div>
            <div className="setting-row__label">Sign out of this browser</div>
            <div className="setting-row__hint">
              Syncing carries on in the background on the server.
            </div>
          </div>
          <button
            type="button"
            className="button button--small"
            onClick={() => void api.logout().then(onSignedOut)}
          >
            <LogOut size={13} />
            Sign out
          </button>
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-row__label">Disconnect from Bluesky</div>
            <div className="setting-row__hint">
              Forgets the stored credentials and stops syncing. Your archive is kept, so signing
              back in resumes rather than starting over.
            </div>
          </div>
          <ConfirmButton
            className="button--small"
            confirmLabel="Click to disconnect"
            onConfirm={() => void api.disconnect().then(onSignedOut)}
          >
            <Unplug size={13} />
            Disconnect
          </ConfirmButton>
        </div>
      </section>
    </div>
  )
}
