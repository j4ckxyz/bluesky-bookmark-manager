import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { exportFilename, streamExport, toCsv, toJson, toNdjson, toNetscapeHtml, type ExportFormat } from '../src/export.ts'
import { extractMetadata, postUrlFromUri } from '../src/metadata.ts'
import type { BookmarkRecord } from '../src/types.ts'
import { bookmarkView } from './fixtures/bookmarks.ts'

function record(options: Parameters<typeof bookmarkView>[0], overrides: Partial<BookmarkRecord> = {}) {
  const meta = extractMetadata(bookmarkView(options))
  assert.ok(meta)
  return {
    ...meta,
    id: 1,
    status: 'active' as const,
    firstSeenAt: '2026-02-01T09:00:00.000Z',
    lastSeenAt: '2026-02-01T09:00:00.000Z',
    removedAt: null,
    postUrl: postUrlFromUri(meta.uri, meta.authorHandle),
    ...overrides,
  }
}

describe('Netscape bookmark export', () => {
  const bookmarks = [
    record({
      uri: 'at://did:plc:alice/app.bsky.feed.post/1',
      text: 'Portability changes the incentives for every operator on the network',
      handle: 'alice.test',
      tags: ['atproto'],
      links: ['https://atproto.com/guides/identity'],
      createdAt: '2026-01-15T10:00:00.000Z',
      bookmarkedAt: '2026-02-01T09:00:00.000Z',
      langs: ['en'],
    }),
    record({
      uri: 'at://did:plc:bob/app.bsky.feed.post/2',
      text: 'A post with an image',
      handle: 'bob.test',
      images: [{ alt: 'A diagram of the relay' }],
    }),
  ]

  const html = toNetscapeHtml(bookmarks, 'owner.test')

  it('starts with the doctype importers look for', () => {
    assert.ok(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>'))
    assert.match(html, /<META HTTP-EQUIV="Content-Type" CONTENT="text\/html; charset=UTF-8">/)
  })

  it('nests entries in a properly closed folder', () => {
    assert.match(html, /<DL><p>/)
    assert.match(html, /<H3>Bluesky bookmarks — @owner\.test<\/H3>/)
    assert.equal((html.match(/<DL><p>/g) ?? []).length, 2)
    assert.equal((html.match(/<\/DL><p>/g) ?? []).length, 2)
  })

  it('links to the post, not the AT-URI', () => {
    assert.match(html, /HREF="https:\/\/bsky\.app\/profile\/alice\.test\/post\/1"/)
    assert.ok(!html.includes('HREF="at://'))
  })

  it('carries the bookmark date as Unix seconds', () => {
    const expected = Math.floor(new Date('2026-02-01T09:00:00.000Z').getTime() / 1000)
    assert.match(html, new RegExp(`ADD_DATE="${expected}"`))
  })

  it('puts derived metadata into TAGS so importers keep it', () => {
    assert.match(html, /TAGS="[^"]*bluesky[^"]*"/)
    assert.match(html, /TAGS="[^"]*atproto[^"]*"/)
    assert.match(html, /TAGS="[^"]*has-link[^"]*"/)
    assert.match(html, /TAGS="[^"]*lang-en[^"]*"/)
    assert.match(html, /TAGS="[^"]*has-image[^"]*"/)
  })

  it('writes the post text as the description', () => {
    assert.match(html, /<DD>Portability changes the incentives/)
    assert.match(html, /Image: A diagram of the relay/)
  })

  it('escapes HTML in post text and titles', () => {
    const escaped = toNetscapeHtml(
      [record({ text: '<script>alert("x")</script> & more', handle: 'evil.test' })],
      'owner.test',
    )
    assert.ok(!escaped.includes('<script>'))
    assert.match(escaped, /&lt;script&gt;/)
    assert.match(escaped, /&amp; more/)
  })

  it('marks un-bookmarked entries rather than dropping them', () => {
    const removed = toNetscapeHtml(
      [record({ text: 'gone' }, { status: 'removed', removedAt: '2026-03-01T00:00:00.000Z' })],
      'owner.test',
    )
    assert.match(removed, /TAGS="[^"]*un-bookmarked[^"]*"/)
  })

  it('describes a deleted post instead of leaving a blank title', () => {
    const deleted = toNetscapeHtml(
      [record({ text: '' }, { itemState: 'not_found', text: '', authorHandle: 'ghost.test' })],
      'owner.test',
    )
    assert.match(deleted, /@ghost\.test — post deleted/)
  })

  it('handles an empty archive', () => {
    const empty = toNetscapeHtml([], 'owner.test')
    assert.ok(empty.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>'))
    assert.equal((empty.match(/<DT><A /g) ?? []).length, 0)
  })
})

describe('JSON and NDJSON export', () => {
  it('wraps bookmarks with export metadata', () => {
    const parsed = JSON.parse(toJson([record({ text: 'one' })], 'owner.test')) as {
      account: string
      count: number
      exportedAt: string
      bookmarks: unknown[]
    }
    assert.equal(parsed.account, 'owner.test')
    assert.equal(parsed.count, 1)
    assert.equal(parsed.bookmarks.length, 1)
    assert.ok(!Number.isNaN(new Date(parsed.exportedAt).getTime()))
  })

  it('writes one complete object per line', () => {
    const lines = toNdjson([record({ text: 'one' }), record({ text: 'two' })]).trim().split('\n')
    assert.equal(lines.length, 2)
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
  })

  it('produces nothing for an empty archive', () => {
    assert.equal(toNdjson([]), '')
  })
})

describe('CSV export', () => {
  it('writes a header and one row per bookmark', () => {
    const csv = toCsv([record({ text: 'one' }), record({ text: 'two' })])
    const lines = csv.trim().split('\r\n')
    assert.equal(lines.length, 3)
    assert.match(lines[0] ?? '', /^uri,url,bookmarked_at,posted_at,author_handle/)
  })

  it('quotes fields containing commas, quotes and newlines', () => {
    const csv = toCsv([record({ text: 'a, b "quoted"\nnew line' })])
    assert.match(csv, /"a, b ""quoted""\nnew line"/)
  })

  it('neutralises cells a spreadsheet would treat as a formula', () => {
    const csv = toCsv([record({ text: '=1+1', handle: 'alice.test' })])
    const dataRow = csv.trim().split('\r\n')[1] ?? ''
    assert.ok(dataRow.includes("'=1+1"), 'a leading = is prefixed with an apostrophe')
  })

  it('flattens list fields into space-separated values', () => {
    const csv = toCsv([
      record({
        tags: ['one', 'two'],
        links: ['https://a.example/x', 'https://b.example/y'],
        langs: ['en', 'cy'],
      }),
    ])
    assert.match(csv, /one two/)
    assert.match(csv, /https:\/\/a\.example\/x https:\/\/b\.example\/y/)
    assert.match(csv, /en cy/)
  })
})

describe('streamed export', () => {
  const all = [1, 2, 3, 4, 5].map((n) =>
    record({ uri: `at://did:plc:a/app.bsky.feed.post/${n}`, text: `post ${n}`, handle: 'a.test' }),
  )
  const stripTimestamp = (text: string) => text.replace(/"exportedAt": "[^"]+"/, '"exportedAt": ""')

  it('produces the same output across page boundaries as in one go', () => {
    for (const format of ['html', 'json', 'csv', 'ndjson'] as ExportFormat[]) {
      const paged = [...streamExport(format, [all.slice(0, 2), [], all.slice(2)], 'a.test', all.length)].join('')
      const whole = [...streamExport(format, [all], 'a.test', all.length)].join('')
      assert.equal(stripTimestamp(paged), stripTimestamp(whole), format)
    }
  })

  it('streams JSON identical to a single stringify, including when empty', () => {
    for (const bookmarks of [all, []]) {
      const streamed = JSON.parse([...streamExport('json', [bookmarks], 'a.test', bookmarks.length)].join(''))
      assert.equal(streamed.count, bookmarks.length)
      assert.deepEqual(streamed.bookmarks, JSON.parse(JSON.stringify(bookmarks)))
      const text = [...streamExport('json', [bookmarks], 'a.test', bookmarks.length)].join('')
      const expected = `${JSON.stringify({ ...JSON.parse(text), bookmarks }, null, 2)}\n`
      assert.equal(text, expected)
    }
  })
})

describe('export filenames', () => {
  it('includes the handle, date and extension', () => {
    const name = exportFilename('html', 'alice.bsky.social')
    assert.match(name, /^bluesky-bookmarks-alice\.bsky\.social-\d{4}-\d{2}-\d{2}\.html$/)
  })

  it('strips characters that would break a filename', () => {
    assert.match(exportFilename('csv', 'a/b\\c:d'), /^bluesky-bookmarks-a_b_c_d-.*\.csv$/)
  })
})
