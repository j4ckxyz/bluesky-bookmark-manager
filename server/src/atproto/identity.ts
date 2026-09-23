import { Client } from '@atproto/lex-client'
import { app, com } from '@bsky/sdk/lexicons'
import type { Config } from '../config.ts'
import { fetchPublicJson, HttpStatusError, timedFetch, UnsafeRequestError } from '../lib/http.ts'

export type ResolvedIdentity = {
  did: string
  handle: string
  /** The account's PDS — surfaced to people as their "hosting provider". */
  pdsUrl: string
  /** Friendly label for the PDS host, e.g. "Bluesky". */
  providerLabel: string
  displayName: string | null
  avatar: string | null
}

export type TypeaheadActor = {
  did: string
  handle: string
  displayName: string | null
  avatar: string | null
  verified: boolean
}

/** Hosts we can name nicely. Anything else falls back to its hostname. */
const KNOWN_PROVIDERS: Record<string, string> = {
  'bsky.social': 'Bluesky',
  'bsky.network': 'Bluesky',
  'blacksky.community': 'Blacksky',
}

export function providerLabelFor(pdsUrl: string): string {
  let host: string
  try {
    host = new URL(pdsUrl).hostname.toLowerCase()
  } catch {
    return pdsUrl
  }
  for (const [suffix, label] of Object.entries(KNOWN_PROVIDERS)) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return label
  }
  return host
}

export class IdentityResolver {
  readonly #config: Config
  readonly #appview: Client

  constructor(config: Config) {
    this.#config = config
    this.#appview = new Client({ service: config.appviewUrl, fetch: timedFetch })
  }

  /** Suggests accounts as someone types their handle on the sign-in screen. */
  async typeahead(query: string, limit = 8): Promise<TypeaheadActor[]> {
    const q = query.trim().replace(/^@/, '')
    if (q.length === 0) return []

    const result = await this.#appview.call(app.bsky.actor.searchActorsTypeahead, {
      q,
      limit: Math.min(20, Math.max(1, limit)),
    })

    return result.actors.map((actor) => ({
      did: actor.did,
      handle: actor.handle,
      displayName: actor.displayName ?? null,
      avatar: actor.avatar ?? null,
      verified: actor.verification?.verifiedStatus === 'valid',
    }))
  }

  /**
   * Resolves a handle or DID all the way to a PDS endpoint, so we can log in
   * against the right host without asking anyone to know what a PDS is.
   */
  async resolve(identifier: string): Promise<ResolvedIdentity> {
    const cleaned = identifier.trim().replace(/^@/, '').toLowerCase()
    if (cleaned.length === 0) throw new IdentityError('Enter a handle or DID')

    if (cleaned.startsWith('did:') && !isDid(cleaned)) {
      throw new IdentityError(`"${cleaned}" is not a valid DID`)
    }
    const did = cleaned.startsWith('did:') ? cleaned : await this.#resolveHandle(cleaned)
    const doc = await this.#fetchDidDocument(did)

    const pdsUrl = extractPdsEndpoint(doc)
    if (!pdsUrl) {
      throw new IdentityError(
        `No hosting provider is listed for ${did}. Enter one manually to continue.`,
      )
    }

    const profile = await this.profile(did)

    return {
      did,
      handle: profile?.handle ?? extractHandle(doc) ?? cleaned,
      pdsUrl,
      providerLabel: providerLabelFor(pdsUrl),
      displayName: profile?.displayName ?? null,
      avatar: profile?.avatar ?? null,
    }
  }

  /** Best-effort profile hydration; identity resolution must not depend on it. */
  async profile(
    actor: string,
  ): Promise<{ handle: string; displayName: string | null; avatar: string | null } | null> {
    if (!isAtIdentifier(actor)) return null
    try {
      const profile = await this.#appview.call(app.bsky.actor.getProfile, { actor })
      return {
        handle: profile.handle,
        displayName: profile.displayName ?? null,
        avatar: profile.avatar ?? null,
      }
    } catch {
      return null
    }
  }

  async #resolveHandle(handle: string): Promise<string> {
    if (!isHandle(handle)) {
      throw new IdentityError(`"${handle}" is not a valid handle. Handles look like name.bsky.social.`)
    }
    try {
      const result = await this.#appview.call(com.atproto.identity.resolveHandle, { handle })
      return result.did
    } catch {
      throw new IdentityError(
        `Could not find an account for "${handle}". Check the handle and try again.`,
      )
    }
  }

  async #fetchDidDocument(did: string): Promise<Record<string, unknown>> {
    const url = didDocumentUrl(did, this.#config.plcDirectoryUrl)
    if (!url) throw new IdentityError(`Unsupported DID method: ${did}`)

    let doc: unknown
    if (did.startsWith('did:web:')) {
      // The host is chosen by whoever is signing in, so it gets the locked-down fetch.
      try {
        doc = await fetchPublicJson(url)
      } catch (err) {
        if (err instanceof HttpStatusError) {
          throw new IdentityError(`Could not look up ${did} (${err.status})`)
        }
        if (err instanceof UnsafeRequestError) {
          throw new IdentityError(`Could not look up ${did}: ${err.message}`)
        }
        // DNS failures, refused connections and TLS errors all mean the same
        // thing to someone signing in: that did:web host is not usable.
        throw new IdentityError(`Could not look up ${did}`)
      }
    } else {
      const response = await timedFetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        throw new IdentityError(`Could not look up ${did} (${response.status})`)
      }
      doc = await response.json()
    }
    if (typeof doc !== 'object' || doc === null) {
      throw new IdentityError(`Malformed DID document for ${did}`)
    }
    return doc as Record<string, unknown>
  }
}

export class IdentityError extends Error {
  override name = 'IdentityError'
}

/** Lexicon params are branded strings; these guards do the runtime narrowing. */
export function isHandle(value: string): value is `${string}.${string}` {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)
}

export function isDid(value: string): value is `did:${string}:${string}` {
  return /^did:[a-z]+:[a-zA-Z0-9._:%-]+$/.test(value)
}

export function isAtIdentifier(value: string): value is `${string}.${string}` | `did:${string}:${string}` {
  return isDid(value) || isHandle(value)
}

const DID_WEB_HOST = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?(:\d{1,5})?$/
const DID_WEB_PATH_SEGMENT = /^[a-zA-Z0-9._-]+$/

/** Where a DID document lives, per DID method. */
export function didDocumentUrl(did: string, plcDirectoryUrl: string): string | null {
  if (did.startsWith('did:plc:')) {
    return `${plcDirectoryUrl.replace(/\/$/, '')}/${did}`
  }
  if (did.startsWith('did:web:')) {
    const rest = did.slice('did:web:'.length)
    const [host, ...path] = rest.split(':')
    if (!host) return null
    let decodedHost: string
    let segments: string[]
    try {
      decodedHost = decodeURIComponent(host).toLowerCase()
      segments = path.map(decodeURIComponent)
    } catch {
      return null
    }
    // A domain name with an optional port. IP literals, userinfo and bare
    // names like "localhost" are rejected before anything is fetched.
    if (!DID_WEB_HOST.test(decodedHost)) return null
    if (segments.some((segment) => !DID_WEB_PATH_SEGMENT.test(segment) || /^\.+$/.test(segment))) {
      return null
    }
    return segments.length > 0
      ? `https://${decodedHost}/${segments.join('/')}/did.json`
      : `https://${decodedHost}/.well-known/did.json`
  }
  return null
}

/** Pulls the `#atproto_pds` service endpoint out of a DID document. */
export function extractPdsEndpoint(doc: Record<string, unknown>): string | null {
  const services = doc['service']
  if (!Array.isArray(services)) return null
  for (const service of services) {
    if (typeof service !== 'object' || service === null) continue
    const entry = service as Record<string, unknown>
    const id = typeof entry['id'] === 'string' ? entry['id'] : ''
    const type = typeof entry['type'] === 'string' ? entry['type'] : ''
    if (id !== '#atproto_pds' && !id.endsWith('#atproto_pds')) continue
    if (type !== 'AtprotoPersonalDataServer') continue
    const endpoint = entry['serviceEndpoint']
    if (typeof endpoint === 'string' && /^https?:\/\//.test(endpoint)) {
      return endpoint.replace(/\/$/, '')
    }
  }
  return null
}

/** Pulls the primary handle out of a DID document's `alsoKnownAs`. */
export function extractHandle(doc: Record<string, unknown>): string | null {
  const aka = doc['alsoKnownAs']
  if (!Array.isArray(aka)) return null
  for (const entry of aka) {
    if (typeof entry === 'string' && entry.startsWith('at://')) {
      return entry.slice('at://'.length).toLowerCase()
    }
  }
  return null
}

/** Accepts `example.com`, `https://example.com` or a full URL. */
export function normaliseServiceUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) throw new IdentityError('Enter a hosting provider address')
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new IdentityError('The hosting provider address must use https')
    }
    return url.origin
  } catch (err) {
    if (err instanceof IdentityError) throw err
    throw new IdentityError(`"${value}" is not a valid hosting provider address`)
  }
}
