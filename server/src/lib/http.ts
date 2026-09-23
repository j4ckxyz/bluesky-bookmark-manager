import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

/** Upper bound for any single outbound request, so a hung host cannot pin a handler. */
export const OUTBOUND_TIMEOUT_MS = 10_000

/**
 * `fetch` with a hard timeout. Passed to every atproto client so AppView, PLC
 * and PDS calls all give up instead of waiting forever. A caller's own signal
 * still works alongside the timeout.
 */
export const timedFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(OUTBOUND_TIMEOUT_MS)
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  return fetch(input, { ...init, signal })
}

/** Address ranges a public DID document can never legitimately live on. */
const NON_PUBLIC = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv6')
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !NON_PUBLIC.check(address, 'ipv4')
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:10.0.0.1) must be judged as the IPv4 it wraps.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
    if (mapped?.[1]) return isPublicAddress(mapped[1])
    return !NON_PUBLIC.check(address, 'ipv6')
  }
  return false
}

export class UnsafeRequestError extends Error {
  override name = 'UnsafeRequestError'
}

/**
 * Resolves like `dns.lookup`, but refuses to connect if any answer is a
 * private, loopback or otherwise non-public address. Checking at connect time
 * (rather than before the request) also defeats DNS rebinding.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err, '', 0)
    const blocked = addresses.find((entry) => !isPublicAddress(entry.address))
    if (blocked || addresses.length === 0) {
      return callback(
        new UnsafeRequestError(`${hostname} does not resolve to a public address`),
        '',
        0,
      )
    }
    if (options.all) return callback(null, addresses as unknown as string, 0)
    const first = addresses[0]!
    return callback(null, first.address, first.family)
  })
}

/**
 * Fetches JSON from a URL that someone outside the instance chose (a did:web
 * host). Only https to public addresses, no redirects, a timeout and a size cap.
 */
export function fetchPublicJson(url: string, maxBytes = 64 * 1024): Promise<unknown> {
  const target = new URL(url)
  if (target.protocol !== 'https:') {
    return Promise.reject(new UnsafeRequestError('Only https URLs can be fetched'))
  }
  if (isIP(target.hostname.replace(/^\[|\]$/g, '')) !== 0) {
    return Promise.reject(new UnsafeRequestError('IP address hosts are not allowed'))
  }

  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        lookup: publicOnlyLookup,
        timeout: OUTBOUND_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status < 200 || status >= 300) {
          res.resume()
          reject(new HttpStatusError(status))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) {
            req.destroy(new UnsafeRequestError(`Response from ${target.host} is too large`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch {
            reject(new UnsafeRequestError(`Response from ${target.host} is not JSON`))
          }
        })
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new UnsafeRequestError(`${target.host} timed out`)))
    req.on('error', reject)
    req.end()
  })
}

export class HttpStatusError extends Error {
  override name = 'HttpStatusError'
  readonly status: number

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}
