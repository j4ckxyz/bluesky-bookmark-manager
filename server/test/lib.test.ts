import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  didDocumentUrl,
  extractHandle,
  extractPdsEndpoint,
  IdentityError,
  isDid,
  isHandle,
  normaliseServiceUrl,
  providerLabelFor,
} from '../src/atproto/identity.ts'
import { decryptJson, encryptJson, generateToken, hashToken, safeEqual } from '../src/lib/crypto.ts'
import { fetchPublicJson, isPublicAddress, UnsafeRequestError } from '../src/lib/http.ts'
import { allowedEdits, damerauLevenshtein, trigramSimilarity } from '../src/lib/fuzzy.ts'

describe('crypto', () => {
  const key = randomBytes(32)

  it('round-trips a value', () => {
    const value = { did: 'did:plc:x', refreshJwt: 'secret-token', nested: { a: [1, 2, 3] } }
    const restored = decryptJson<typeof value>(key, encryptJson(key, value))
    assert.deepEqual(restored, value)
  })

  it('produces a different ciphertext each time', () => {
    assert.notEqual(encryptJson(key, { a: 1 }), encryptJson(key, { a: 1 }))
  })

  it('refuses to decrypt with the wrong key', () => {
    assert.equal(decryptJson(randomBytes(32), encryptJson(key, { a: 1 })), null)
  })

  it('detects a tampered payload rather than returning garbage', () => {
    const payload = encryptJson(key, { a: 1 })
    const parts = payload.split('.')
    const flipped = Buffer.from(parts[3]!, 'base64url')
    flipped[0] = (flipped[0]! ^ 0xff) & 0xff
    parts[3] = flipped.toString('base64url')
    assert.equal(decryptJson(key, parts.join('.')), null)
  })

  it('rejects a malformed payload', () => {
    assert.equal(decryptJson(key, 'nonsense'), null)
    assert.equal(decryptJson(key, 'v2.a.b.c'), null)
    assert.equal(decryptJson(key, ''), null)
  })

  it('generates URL-safe tokens that do not repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()))
    assert.equal(tokens.size, 200)
    for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]+$/)
  })

  it('hashes tokens deterministically without revealing them', () => {
    const token = generateToken()
    assert.equal(hashToken(token), hashToken(token))
    assert.notEqual(hashToken(token), token)
    assert.match(hashToken(token), /^[0-9a-f]{64}$/)
  })

  it('compares strings without leaking length mismatches as errors', () => {
    assert.equal(safeEqual('abc', 'abc'), true)
    assert.equal(safeEqual('abc', 'abd'), false)
    assert.equal(safeEqual('abc', 'abcd'), false)
  })
})

describe('fuzzy matching', () => {
  it('measures edit distance', () => {
    assert.equal(damerauLevenshtein('atproto', 'atproto'), 0)
    assert.equal(damerauLevenshtein('atproto', 'atprote'), 1)
    assert.equal(damerauLevenshtein('firehose', 'firehse'), 1)
    assert.equal(damerauLevenshtein('', 'abc'), 3)
    assert.equal(damerauLevenshtein('abc', ''), 3)
  })

  it('counts an adjacent transposition as one edit', () => {
    assert.equal(damerauLevenshtein('lexicon', 'lexicno'), 1)
    assert.equal(damerauLevenshtein('form', 'from'), 1)
  })

  it('bails out early beyond the cap rather than computing exactly', () => {
    assert.ok(damerauLevenshtein('a', 'abcdefghij', 4) > 4)
    assert.ok(damerauLevenshtein('kitten', 'zzzzzzzz', 2) > 2)
  })

  it('gives short terms no typo tolerance', () => {
    assert.equal(allowedEdits('at'), 0)
    assert.equal(allowedEdits('cat'), 0)
    assert.equal(allowedEdits('cats'), 1)
    assert.equal(allowedEdits('kitten'), 2)
  })

  it('scores trigram similarity between 0 and 1', () => {
    assert.equal(trigramSimilarity('atproto', 'atproto'), 1)
    assert.ok(trigramSimilarity('atproto', 'atprotos') > 0.5)
    assert.ok(trigramSimilarity('atproto', 'bicycle') < 0.2)
  })
})

describe('identity helpers', () => {
  it('recognises handles and DIDs', () => {
    assert.equal(isHandle('alice.bsky.social'), true)
    assert.equal(isHandle('alice'), false, 'a handle needs a dot')
    assert.equal(isHandle('-bad.example.com'), false)
    assert.equal(isDid('did:plc:abc123'), true)
    assert.equal(isDid('did:web:example.com'), true)
    assert.equal(isDid('not-a-did'), false)
  })

  it('points did:plc at the directory', () => {
    assert.equal(
      didDocumentUrl('did:plc:abc', 'https://plc.directory'),
      'https://plc.directory/did:plc:abc',
    )
  })

  it('points did:web at the right well-known path', () => {
    assert.equal(didDocumentUrl('did:web:example.com', 'x'), 'https://example.com/.well-known/did.json')
    assert.equal(didDocumentUrl('did:web:example.com:users:alice', 'x'), 'https://example.com/users/alice/did.json')
  })

  it('refuses did:web hosts that are not public domain names', () => {
    for (const did of [
      'did:web:localhost',
      'did:web:127.0.0.1',
      'did:web:169.254.169.254',
      'did:web:%5B%3A%3A1%5D',
      'did:web:user%40internal.example',
      'did:web:example.com%2Fadmin',
      'did:web:example.com:..:secret',
      'did:web:%E0%A4%A',
    ]) {
      assert.equal(didDocumentUrl(did, 'x'), null, did)
    }
    assert.equal(didDocumentUrl('did:web:example.com%3A8443', 'x'), 'https://example.com:8443/.well-known/did.json')
  })

  it('returns null for an unsupported DID method', () => {
    assert.equal(didDocumentUrl('did:key:z6Mk', 'x'), null)
  })

  it('finds the PDS endpoint in a DID document', () => {
    const doc = {
      service: [
        { id: '#atproto_labeler', type: 'AtprotoLabeler', serviceEndpoint: 'https://labeler.test' },
        {
          id: '#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: 'https://pds.example.com/',
        },
      ],
    }
    assert.equal(extractPdsEndpoint(doc), 'https://pds.example.com')
  })

  it('accepts a fully-qualified service id', () => {
    const doc = {
      service: [
        {
          id: 'did:plc:abc#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: 'https://pds.example.com',
        },
      ],
    }
    assert.equal(extractPdsEndpoint(doc), 'https://pds.example.com')
  })

  it('returns null when the document has no PDS', () => {
    assert.equal(extractPdsEndpoint({}), null)
    assert.equal(extractPdsEndpoint({ service: [] }), null)
    assert.equal(
      extractPdsEndpoint({ service: [{ id: '#atproto_pds', type: 'WrongType', serviceEndpoint: 'https://x' }] }),
      null,
    )
    assert.equal(
      extractPdsEndpoint({
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'ftp://x' }],
      }),
      null,
      'only http(s) endpoints are usable',
    )
  })

  it('reads the primary handle from alsoKnownAs', () => {
    assert.equal(extractHandle({ alsoKnownAs: ['at://Alice.Test'] }), 'alice.test')
    assert.equal(extractHandle({}), null)
  })

  it('names known providers and falls back to the host', () => {
    assert.equal(providerLabelFor('https://bsky.social'), 'Bluesky')
    assert.equal(providerLabelFor('https://morel.us-east.host.bsky.network'), 'Bluesky')
    assert.equal(providerLabelFor('https://pds.example.com'), 'pds.example.com')
  })

  it('normalises a hosting provider address', () => {
    assert.equal(normaliseServiceUrl('bsky.social'), 'https://bsky.social')
    assert.equal(normaliseServiceUrl('https://pds.example.com/'), 'https://pds.example.com')
    assert.equal(normaliseServiceUrl('  https://pds.example.com/path  '), 'https://pds.example.com')
    assert.equal(normaliseServiceUrl('http://localhost:3000'), 'http://localhost:3000')
  })

  it('rejects a plaintext remote address and empty input', () => {
    assert.throws(() => normaliseServiceUrl('http://pds.example.com'), IdentityError)
    assert.throws(() => normaliseServiceUrl(''), IdentityError)
    assert.throws(() => normaliseServiceUrl('   '), IdentityError)
  })
})

describe('outbound http', () => {
  it('treats private, loopback and link-local addresses as non-public', () => {
    for (const address of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.20.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      'not-an-ip',
    ]) {
      assert.equal(isPublicAddress(address), false, address)
    }
    for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
      assert.equal(isPublicAddress(address), true, address)
    }
  })

  it('refuses to fetch from a host that resolves to a private address', async () => {
    await assert.rejects(fetchPublicJson('https://localhost/.well-known/did.json'), UnsafeRequestError)
  })

  it('refuses IP literals and plain http', async () => {
    await assert.rejects(fetchPublicJson('https://127.0.0.1/did.json'), UnsafeRequestError)
    await assert.rejects(fetchPublicJson('http://example.com/did.json'), UnsafeRequestError)
  })
})
