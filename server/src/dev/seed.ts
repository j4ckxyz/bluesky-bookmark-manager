/**
 * Fills the database with plausible bookmarks so the interface can be worked
 * on without a Bluesky account.
 *
 *   npm run seed:demo -w server
 *
 * Prints a session cookie you can paste into your browser's dev tools.
 * Never run this against a database you care about.
 */
import { loadConfig } from '../config.ts'
import { AccountStore } from '../db/accounts.ts'
import { BookmarkStore } from '../db/bookmarks.ts'
import { openDatabase } from '../db/index.ts'
import { extractMetadata } from '../metadata.ts'
import { SyncRunStore } from '../sync/runs.ts'

const DEMO_DID = 'did:plc:demoaccount00000000000'

/**
 * A stand-in Open Graph image. Inlined as a data URI so `seed:demo` shows real
 * link cards without reaching the network for a placeholder.
 */
function demoThumb(label: string, hue: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="764" height="400">` +
    `<rect width="764" height="400" fill="hsl(${hue} 55% 42%)"/>` +
    `<text x="50%" y="52%" text-anchor="middle" fill="white"` +
    ` font-family="system-ui, sans-serif" font-size="38">${label}</text>` +
    `</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const AUTHORS = [
  { did: 'did:plc:author01', handle: 'sam.example.social', name: 'Sam Rivera', verified: true },
  { did: 'did:plc:author02', handle: 'protocol-notes.example.com', name: 'Protocol Notes', verified: true },
  { did: 'did:plc:author03', handle: 'maya.example.social', name: 'Maya Okafor', verified: false },
  { did: 'did:plc:author04', handle: 'tom.example.dev', name: 'Tom Lindqvist', verified: false },
  { did: 'did:plc:author05', handle: 'newsroom.example.com', name: 'The Newsroom', verified: true },
  { did: 'did:plc:author06', handle: 'birdwatch.example.org', name: 'Birdwatch', verified: false },
]

const POSTS: Array<{
  text: string
  author: number
  tags?: string[]
  links?: string[]
  images?: string[]
  video?: boolean
  reply?: boolean
  quote?: { handle: string; text: string }
  external?: { uri: string; title: string; description: string; thumb?: string }
  langs?: string[]
  likes?: number
  reposts?: number
  daysAgo: number
}> = [
  {
    text: 'Account portability is the part of the AT Protocol people underrate. Your identity is a DID, your data is a repo, and neither is owned by the app you happen to be using today.',
    author: 0,
    tags: ['atproto'],
    likes: 3200,
    reposts: 890,
    daysAgo: 4,
  },
  {
    text: 'New guide on consuming the firehose without falling over: backfill, cursors, and what to do when you drop events.',
    author: 1,
    external: {
      uri: 'https://docs.bsky.app/docs/advanced-guides/firehose',
      title: 'Consuming the firehose',
      description: 'A practical guide to the network event stream, including backfill strategy.',
      thumb: demoThumb('docs.bsky.app', 212),
    },
    tags: ['atproto', 'firehose'],
    likes: 1450,
    reposts: 410,
    daysAgo: 9,
  },
  {
    text: 'Spent the afternoon reading the lexicon spec properly rather than guessing. Highly recommend. The schema system is doing far more work than it looks like from outside.',
    author: 2,
    links: ['https://atproto.com/specs/lexicon'],
    tags: ['lexicon'],
    likes: 220,
    daysAgo: 15,
  },
  {
    text: 'Moderation on a decentralised network is a composable stack, not a single switch. Labellers, mute lists, and server policy all sit at different layers.',
    author: 0,
    reply: true,
    tags: ['moderation'],
    likes: 980,
    reposts: 300,
    daysAgo: 21,
  },
  {
    text: 'Photo essay from the north coast this weekend.',
    author: 3,
    images: [
      'Waves breaking over a stone harbour wall at dusk, long exposure',
      'A lighthouse silhouetted against an orange sky',
    ],
    likes: 640,
    daysAgo: 28,
  },
  {
    text: 'Short clip showing the new lexicon tooling generating a typed client from a schema in about two seconds.',
    author: 2,
    video: true,
    tags: ['lexicon', 'typescript'],
    likes: 410,
    daysAgo: 33,
  },
  {
    text: 'Quoting this because the point about network effects deserves more attention than it got.',
    author: 4,
    quote: {
      handle: 'sam.example.social',
      text: 'Network effects compound when users can leave without losing their audience. That changes the incentives for every operator on the network.',
    },
    links: ['https://github.com/bluesky-social/atproto'],
    likes: 1100,
    reposts: 520,
    daysAgo: 40,
  },
  {
    text: 'Un billet en français sur la fédération et ce qu’elle change pour les rédactions.',
    author: 4,
    langs: ['fr'],
    links: ['https://www.lemonde.fr/pixels/'],
    likes: 88,
    daysAgo: 52,
  },
  {
    text: 'Reminder that DIDs are not addresses. Resolving one is a lookup, and the answer can change. Cache accordingly.',
    author: 1,
    tags: ['atproto', 'identity'],
    likes: 760,
    daysAgo: 61,
  },
  {
    text: 'Bird of the day: a goldcrest, somehow surviving a British February at nine grams.',
    author: 5,
    images: ['A goldcrest perched on a frosted branch, tiny and round'],
    tags: ['birds'],
    likes: 2400,
    reposts: 700,
    daysAgo: 74,
  },
  {
    text: 'The self-hosting story matters more than the protocol purity argument. If running your own PDS is genuinely hard, decentralisation is theoretical.',
    author: 3,
    reply: true,
    likes: 530,
    daysAgo: 88,
  },
  {
    text: 'Threadgates, postgates, and detached quotes: a short tour of the controls that already exist and which ones people actually use.',
    author: 0,
    links: ['https://docs.bsky.app/blog/'],
    tags: ['moderation', 'atproto'],
    likes: 1900,
    reposts: 640,
    daysAgo: 103,
  },
  {
    text: 'Benchmarking SQLite full-text search against a hosted search service for a personal archive. SQLite wins comfortably at this size, and it is one file.',
    author: 2,
    tags: ['sqlite'],
    links: ['https://www.sqlite.org/fts5.html'],
    likes: 340,
    daysAgo: 120,
  },
  {
    text: 'Anyone else find that reading the actual RFC takes less time than reading three blog posts about the RFC?',
    author: 3,
    likes: 4100,
    reposts: 1200,
    daysAgo: 150,
  },
  {
    text: 'Long-form writing on the network is finally usable. Here is a piece on what changes when the social graph is portable infrastructure rather than a product moat.',
    author: 4,
    external: {
      uri: 'https://www.theguardian.com/technology',
      title: 'When the social graph becomes infrastructure',
      description: 'What portability changes about the economics of running a social network.',
      thumb: demoThumb('theguardian.com', 24),
    },
    likes: 870,
    daysAgo: 182,
  },
]

function build(index: number, spec: (typeof POSTS)[number]): Record<string, unknown> {
  const author = AUTHORS[spec.author % AUTHORS.length]!
  const uri = `at://${author.did}/app.bsky.feed.post/demo${index}`
  const createdAt = new Date(Date.now() - spec.daysAgo * 86_400_000).toISOString()
  const bookmarkedAt = new Date(
    Date.now() - Math.max(0, spec.daysAgo - 2) * 86_400_000,
  ).toISOString()

  const facets: unknown[] = []
  for (const link of spec.links ?? []) {
    facets.push({
      index: { byteStart: 0, byteEnd: 1 },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: link }],
    })
  }
  for (const tag of spec.tags ?? []) {
    facets.push({
      index: { byteStart: 0, byteEnd: 1 },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag }],
    })
  }

  const record: Record<string, unknown> = {
    $type: 'app.bsky.feed.post',
    text: spec.text,
    createdAt,
    langs: spec.langs ?? ['en'],
  }
  if (facets.length > 0) record['facets'] = facets
  if (spec.reply) {
    record['reply'] = {
      parent: { uri: `at://${author.did}/app.bsky.feed.post/parent${index}`, cid: 'bafyparent' },
      root: { uri: `at://${author.did}/app.bsky.feed.post/root${index}`, cid: 'bafyroot' },
    }
  }

  let embed: Record<string, unknown> | null = null
  if (spec.images) {
    embed = {
      $type: 'app.bsky.embed.images#view',
      images: spec.images.map((alt, i) => ({
        thumb: `https://example.invalid/thumb${i}.jpg`,
        fullsize: `https://example.invalid/full${i}.jpg`,
        alt,
      })),
    }
  } else if (spec.video) {
    embed = {
      $type: 'app.bsky.embed.video#view',
      cid: 'bafyvideo',
      playlist: 'https://example.invalid/playlist.m3u8',
      alt: 'Screen recording of a code generator running',
    }
  } else if (spec.external) {
    embed = { $type: 'app.bsky.embed.external#view', external: { ...spec.external } }
  }

  if (spec.quote) {
    const quoteView = {
      $type: 'app.bsky.embed.record#view',
      record: {
        $type: 'app.bsky.embed.record#viewRecord',
        uri: `at://did:plc:author01/app.bsky.feed.post/quoted${index}`,
        cid: 'bafyquoted',
        author: { did: 'did:plc:author01', handle: spec.quote.handle },
        value: { $type: 'app.bsky.feed.post', text: spec.quote.text },
        indexedAt: createdAt,
      },
    }
    embed = embed
      ? { $type: 'app.bsky.embed.recordWithMedia#view', record: quoteView, media: embed }
      : quoteView
  }

  const post: Record<string, unknown> = {
    $type: 'app.bsky.feed.defs#postView',
    uri,
    cid: `bafydemo${index}`,
    author: {
      did: author.did,
      handle: author.handle,
      displayName: author.name,
      verification: {
        verifications: [],
        verifiedStatus: author.verified ? 'valid' : 'none',
        trustedVerifierStatus: 'none',
      },
    },
    record,
    indexedAt: createdAt,
    likeCount: spec.likes ?? 0,
    repostCount: spec.reposts ?? 0,
    replyCount: Math.floor((spec.likes ?? 0) / 40),
    quoteCount: Math.floor((spec.likes ?? 0) / 120),
  }
  if (embed) post['embed'] = embed

  return {
    $type: 'app.bsky.bookmark.defs#bookmarkView',
    subject: { uri, cid: `bafydemo${index}` },
    createdAt: bookmarkedAt,
    item: post,
  }
}

function main(): void {
  const config = loadConfig()
  const db = openDatabase(config.databasePath)
  const accounts = new AccountStore(db, config.encryptionKey)
  const bookmarks = new BookmarkStore(db)
  const runs = new SyncRunStore(db)

  accounts.upsert({
    did: DEMO_DID,
    handle: 'demo.example.social',
    displayName: 'Demo account',
    avatar: null,
    pdsUrl: 'https://bsky.social',
    session: {
      did: DEMO_DID,
      handle: 'demo.example.social',
      accessJwt: 'demo-access-token',
      refreshJwt: 'demo-refresh-token',
      service: 'https://bsky.social',
    },
  })

  const run = runs.start(DEMO_DID, 'backfill', 'manual')
  const seenAt = new Date().toISOString()

  let created = 0
  POSTS.forEach((spec, index) => {
    const meta = extractMetadata(build(index, spec))
    if (!meta) return
    const outcome = bookmarks.upsert(DEMO_DID, meta, {
      seenAt,
      runId: run.id,
      sortIndex: index,
      raw: null,
    })
    if (outcome === 'created') created++
  })

  runs.update({
    ...run,
    status: 'completed',
    finishedAt: new Date().toISOString(),
    pages: 1,
    scanned: POSTS.length,
    created,
  })
  accounts.markSync(DEMO_DID, 'ok', true)

  const cookie = accounts.createAuthSession(DEMO_DID, 30, 'seed script')

  console.log(`Seeded ${created} new bookmarks (${POSTS.length} total) for @demo.example.social`)
  console.log(`Database: ${config.databasePath}`)
  console.log('')
  console.log('Sign in by setting this cookie on the site origin:')
  console.log(`  bskybm_session=${cookie}`)
  console.log('')
  console.log('The demo credentials are not real, so run the server with SYNC_ENABLED=false')
  console.log('to stop the scheduler trying (and failing) to reach a hosting provider.')

  db.close()
}

main()
