import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const VERSION = 'v1'

/**
 * Encrypts a JSON-serialisable value with AES-256-GCM.
 * Output format: `v1.<iv>.<authTag>.<ciphertext>`, all base64url.
 */
export function encryptJson(key: Buffer, value: unknown): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, b64(iv), b64(tag), b64(ciphertext)].join('.')
}

/** Reverses {@link encryptJson}. Returns null if the payload is unreadable. */
export function decryptJson<T>(key: Buffer, payload: string): T | null {
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) return null
  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string]
  try {
    const decipher = createDecipheriv(ALGORITHM, key, unb64(ivPart))
    decipher.setAuthTag(unb64(tagPart))
    const plaintext = Buffer.concat([decipher.update(unb64(dataPart)), decipher.final()])
    return JSON.parse(plaintext.toString('utf8')) as T
  } catch {
    return null
  }
}

/** A URL-safe random token, used for browser sessions and API keys. */
export function generateToken(bytes = 32): string {
  return b64(randomBytes(bytes))
}

/** Tokens are only ever persisted as a hash, so a database leak is not a key leak. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function b64(buf: Buffer): string {
  return buf.toString('base64url')
}

function unb64(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}
