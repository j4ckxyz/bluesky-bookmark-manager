import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { AccountStore, type StoredSession } from '../src/db/accounts.ts'
import { openDatabase } from '../src/db/index.ts'

const session = (did: string): StoredSession => ({
  did,
  handle: `${did.slice(8)}.test`,
  accessJwt: 'access',
  refreshJwt: 'refresh-secret',
  service: 'https://pds.test',
})

const account = (did: string) => ({
  did,
  handle: `${did.slice(8)}.test`,
  displayName: null,
  avatar: null,
  pdsUrl: 'https://pds.test',
  session: session(did),
})

describe('account store', () => {
  it('makes only the first account the owner, and keeps it on re-login', () => {
    const accounts = new AccountStore(openDatabase(':memory:'), randomBytes(32))
    assert.equal(accounts.upsert(account('did:plc:first')).isOwner, true)
    assert.equal(accounts.upsert(account('did:plc:second')).isOwner, false)
    assert.equal(accounts.upsert(account('did:plc:first')).isOwner, true)
  })

  it('stores the PDS session encrypted and reads it back', () => {
    const db = openDatabase(':memory:')
    const accounts = new AccountStore(db, randomBytes(32))
    accounts.upsert(account('did:plc:first'))

    const raw = db.prepare('SELECT session_blob FROM accounts').get() as { session_blob: string }
    assert.doesNotMatch(raw.session_blob, /refresh-secret/)
    assert.equal(accounts.loadSession('did:plc:first')?.refreshJwt, 'refresh-secret')

    accounts.clearSession('did:plc:first')
    assert.equal(accounts.loadSession('did:plc:first'), null)
  })

  it('stops honouring an API token once it is revoked', () => {
    const accounts = new AccountStore(openDatabase(':memory:'), randomBytes(32))
    accounts.upsert(account('did:plc:first'))
    const { token, hint } = accounts.createApiToken('did:plc:first', 'script')

    assert.equal(accounts.resolveApiToken(token)?.did, 'did:plc:first')
    assert.equal(accounts.revokeApiToken('did:plc:first', hint), true)
    assert.equal(accounts.resolveApiToken(token), null)
  })
})
