import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  didFromUri,
  domainOf,
  extractMetadata,
  postUrlFromUri,
  rkeyFromUri,
} from '../src/metadata.ts'
import { blockedBookmark, bookmarkView, notFoundBookmark } from './fixtures/bookmarks.ts'

const extract = (options: Parameters<typeof bookmarkView>[0]) => {
  const meta = extractMetadata(bookmarkView(options))
  assert.ok(meta, 'expected metadata')
  return meta
}

describe('AT-URI helpers', () => {
  const uri = 'at://did:plc:abc123/app.bsky.feed.post/3kabc'

  it('pulls the DID and record key out of a URI', () => {
    assert.equal(didFromUri(uri), 'did:plc:abc123')
    assert.equal(rkeyFromUri(uri), '3kabc')
  })

  it('builds a bsky.app permalink, preferring the handle', () => {
    assert.equal(postUrlFromUri(uri, 'alice.test'), 'https://bsky.app/profile/alice.test/post/3kabc')
    assert.equal(postUrlFromUri(uri), 'https://bsky.app/profile/did:plc:abc123/post/3kabc')
  })

  it('returns null for something that is not a post URI', () => {
    assert.equal(postUrlFromUri('at://did:plc:abc123'), null)
    assert.equal(rkeyFromUri('nonsense'), null)
  })

  it('normalises domains', () => {
    assert.equal(domainOf('https://www.Example.com/a/b?c=1'), 'example.com')
    assert.equal(domainOf('http://news.bbc.co.uk'), 'news.bbc.co.uk')
    assert.equal(domainOf('not a url'), '')
  })
})

describe('metadata extraction', () => {
  it('reads the basics off a post view', () => {
    const meta = extract({
      uri: 'at://did:plc:alice/app.bsky.feed.post/1',
      text: 'Hello there, world',
      handle: 'alice.test',
      displayName: 'Alice',
      did: 'did:plc:alice',
      createdAt: '2026-01-02T03:04:05.000Z',
      bookmarkedAt: '2026-02-03T04:05:06.000Z',
      likeCount: 7,
      repostCount: 3,
    })

    assert.equal(meta.uri, 'at://did:plc:alice/app.bsky.feed.post/1')
    assert.equal(meta.rkey, '1')
    assert.equal(meta.itemState, 'ok')
    assert.equal(meta.authorHandle, 'alice.test')
    assert.equal(meta.authorDisplayName, 'Alice')
    assert.equal(meta.text, 'Hello there, world')
    assert.equal(meta.createdAt, '2026-01-02T03:04:05.000Z')
    assert.equal(meta.bookmarkedAt, '2026-02-03T04:05:06.000Z')
    assert.equal(meta.likeCount, 7)
    assert.equal(meta.repostCount, 3)
    assert.equal(meta.wordCount, 3)
    assert.equal(meta.charCount, 18)
  })

  it('detects verification and trusted verifier status', () => {
    assert.equal(extract({ verified: true }).authorVerified, true)
    assert.equal(extract({ verified: false }).authorVerified, false)
    assert.equal(extract({}).authorVerified, false, 'no verification block means unverified')
    assert.equal(extract({ trustedVerifier: true }).authorTrustedVerifier, true)
  })

  it('collects links from facets, with their domains', () => {
    const meta = extract({
      links: ['https://www.example.com/article', 'https://atproto.com/specs/lexicon'],
    })
    assert.equal(meta.hasLinks, true)
    assert.equal(meta.linkCount, 2)
    assert.deepEqual(
      meta.links.map((l) => l.domain),
      ['example.com', 'atproto.com'],
    )
    assert.equal(meta.primaryDomain, 'example.com')
  })

  it('finds bare URLs in text when a post has no link facets', () => {
    const meta = extract({ text: 'See https://example.org/thing for details.' })
    assert.equal(meta.linkCount, 1)
    assert.equal(meta.links[0]?.domain, 'example.org')
    assert.equal(meta.links[0]?.source, 'text')
    assert.equal(meta.links[0]?.url, 'https://example.org/thing', 'trailing punctuation is trimmed')
  })

  it('does not double-count a URL present in both text and facets', () => {
    const meta = extract({
      text: 'Read https://example.org/thing',
      links: ['https://example.org/thing'],
    })
    assert.equal(meta.linkCount, 1)
    assert.equal(meta.links[0]?.source, 'facet')
  })

  it('reads images and their alt text', () => {
    const meta = extract({ images: [{ alt: 'A red bicycle' }, { alt: 'A blue door' }] })
    assert.equal(meta.hasImages, true)
    assert.equal(meta.imageCount, 2)
    assert.equal(meta.hasMedia, true)
    assert.equal(meta.hasAltText, true)
    assert.match(meta.altText, /red bicycle/)
    assert.match(meta.altText, /blue door/)
  })

  it('reads video embeds', () => {
    const meta = extract({ video: true })
    assert.equal(meta.hasVideo, true)
    assert.equal(meta.hasMedia, true)
    assert.equal(meta.hasImages, false)
  })

  it('reads external link cards', () => {
    const meta = extract({
      external: {
        uri: 'https://docs.bsky.app/guide',
        title: 'A guide',
        description: 'How things work',
      },
    })
    assert.equal(meta.hasExternal, true)
    assert.equal(meta.externalTitle, 'A guide')
    assert.equal(meta.externalDescription, 'How things work')
    assert.equal(meta.primaryDomain, 'docs.bsky.app')
    assert.equal(meta.links[0]?.source, 'embed')
    assert.equal(meta.links[0]?.title, 'A guide')
  })

  it('reads quote posts', () => {
    const meta = extract({
      quote: { uri: 'at://did:plc:x/app.bsky.feed.post/9', handle: 'bob.test', text: 'Original' },
    })
    assert.equal(meta.isQuote, true)
    assert.equal(meta.quotedAuthorHandle, 'bob.test')
    assert.equal(meta.quotedText, 'Original')
  })

  it('reads a quote that also carries media', () => {
    const meta = extract({
      images: [{ alt: 'Chart' }],
      quote: { uri: 'at://did:plc:x/app.bsky.feed.post/9', handle: 'bob.test', text: 'Original' },
    })
    assert.equal(meta.isQuote, true, 'recordWithMedia yields both')
    assert.equal(meta.imageCount, 1)
    assert.equal(meta.altText, 'Chart')
  })

  it('distinguishes replies from top-level posts', () => {
    const top = extract({})
    assert.equal(top.isReply, false)
    assert.equal(top.isRoot, true)

    const reply = extract({
      did: 'did:plc:carol',
      replyTo: {
        parentUri: 'at://did:plc:alice/app.bsky.feed.post/1',
        rootUri: 'at://did:plc:alice/app.bsky.feed.post/1',
      },
    })
    assert.equal(reply.isReply, true)
    assert.equal(reply.isRoot, false)
    assert.equal(reply.replyParentDid, 'did:plc:alice')
    assert.equal(reply.isSelfReply, false)
  })

  it('spots a self-reply, which is how threads are written', () => {
    const meta = extract({
      did: 'did:plc:alice',
      replyTo: {
        parentUri: 'at://did:plc:alice/app.bsky.feed.post/1',
        rootUri: 'at://did:plc:alice/app.bsky.feed.post/1',
      },
    })
    assert.equal(meta.isSelfReply, true)
  })

  it('collects mentions from facets and pairs them with handles in the text', () => {
    const meta = extract({
      text: 'Talking to @bob.example.com about this',
      mentions: [{ did: 'did:plc:bob', handle: 'bob.example.com' }],
    })
    assert.equal(meta.mentionCount, 1)
    assert.equal(meta.mentions[0]?.did, 'did:plc:bob')
    assert.equal(meta.mentions[0]?.handle, 'bob.example.com')
  })

  it('counts an unfaceted @handle in the text as a mention', () => {
    const meta = extract({ text: 'cc @carol.example.org' })
    assert.equal(meta.mentionCount, 1)
    assert.equal(meta.mentions[0]?.handle, 'carol.example.org')
    assert.equal(meta.mentions[0]?.did, undefined)
  })

  it('normalises hashtags to lower case without the hash', () => {
    const meta = extract({ tags: ['ATProto', '#Lexicon'] })
    assert.deepEqual(meta.tags.sort(), ['atproto', 'lexicon'])
    assert.equal(meta.tagCount, 2)
  })

  it('merges self-labels and moderation labels, ignoring negated ones', () => {
    const meta = extract({ selfLabels: ['!warn'], modLabels: ['spam'] })
    assert.deepEqual(meta.labels.sort(), ['!warn', 'spam'])
    assert.equal(meta.hasLabels, true)
  })

  it('reads declared languages', () => {
    assert.deepEqual(extract({ langs: ['en', 'cy'] }).langs, ['en', 'cy'])
    assert.deepEqual(extract({}).langs, [])
  })

  it('keeps a deleted post as a bookmark', () => {
    const meta = extractMetadata(notFoundBookmark('at://did:plc:gone/app.bsky.feed.post/1'))
    assert.ok(meta)
    assert.equal(meta.itemState, 'not_found')
    assert.equal(meta.uri, 'at://did:plc:gone/app.bsky.feed.post/1')
    assert.equal(meta.authorDid, 'did:plc:gone')
    assert.equal(meta.text, '')
  })

  it('keeps a blocked post as a bookmark', () => {
    const meta = extractMetadata(
      blockedBookmark('at://did:plc:blocked/app.bsky.feed.post/1', 'did:plc:blocked'),
    )
    assert.ok(meta)
    assert.equal(meta.itemState, 'blocked')
    assert.equal(meta.authorDid, 'did:plc:blocked')
  })

  it('rejects a payload with no subject URI', () => {
    assert.equal(extractMetadata({}), null)
    assert.equal(extractMetadata(null), null)
    assert.equal(extractMetadata('nonsense'), null)
    assert.equal(extractMetadata({ subject: {} }), null)
  })

  it('survives a malformed record rather than throwing', () => {
    const meta = extractMetadata({
      $type: 'app.bsky.bookmark.defs#bookmarkView',
      subject: { uri: 'at://did:plc:x/app.bsky.feed.post/1' },
      item: {
        $type: 'app.bsky.feed.defs#postView',
        uri: 'at://did:plc:x/app.bsky.feed.post/1',
        record: { text: 42, facets: 'not an array', langs: [null, 'en'] },
        author: 'not an object',
        embed: { $type: 'app.bsky.embed.images#view', images: 'nope' },
        indexedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    assert.ok(meta)
    assert.equal(meta.text, '')
    assert.equal(meta.authorHandle, null)
    assert.deepEqual(meta.langs, ['en'], 'the valid entries survive')
    assert.equal(meta.imageCount, 0)
  })

  it('falls back to indexedAt when a record has no createdAt', () => {
    const meta = extractMetadata({
      $type: 'app.bsky.bookmark.defs#bookmarkView',
      subject: { uri: 'at://did:plc:x/app.bsky.feed.post/1' },
      item: {
        $type: 'app.bsky.feed.defs#postView',
        uri: 'at://did:plc:x/app.bsky.feed.post/1',
        record: { text: 'no createdAt' },
        author: { did: 'did:plc:x', handle: 'x.test' },
        indexedAt: '2026-05-05T00:00:00.000Z',
      },
    })
    assert.equal(meta?.createdAt, '2026-05-05T00:00:00.000Z')
  })
})
