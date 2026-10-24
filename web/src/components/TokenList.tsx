import { Trash2 } from 'lucide-react'
import { fullDate, relativeTime } from '../lib/format.ts'
import type { ApiToken } from '../lib/types.ts'
import { ConfirmButton } from './ConfirmButton.tsx'

type Props = {
  tokens: ApiToken[]
  busy: boolean
  onRevoke: (hint: string) => void
}

export function TokenList({ tokens, busy, onRevoke }: Props) {
  if (tokens.length === 0) return <p className="hint">No tokens yet.</p>

  return (
    <div>
      {tokens.map((token) => (
        <div key={token.hint} className="token-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 550, display: 'flex', gap: 6, alignItems: 'center' }}>
              {token.name}
              {token.expired && <span className="badge badge--danger">Expired</span>}
            </div>
            <div className="hint">
              <span className="code">{token.hint}</span> · created {fullDate(token.createdAt)} ·{' '}
              {token.lastUsedAt ? `last used ${relativeTime(token.lastUsedAt)}` : 'never used'}
              {token.expiresAt && !token.expired && ` · expires ${fullDate(token.expiresAt)}`}
            </div>
          </div>
          <ConfirmButton
            className="button--small"
            confirmLabel="Click to revoke"
            onConfirm={() => onRevoke(token.hint)}
            disabled={busy}
            aria-label={`Revoke ${token.name}`}
          >
            <Trash2 size={13} />
            Revoke
          </ConfirmButton>
        </div>
      ))}
    </div>
  )
}
