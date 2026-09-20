# Bluesky Bookmark Manager

A self-hosted, searchable archive of your Bluesky bookmarks.

You sign in once with an app password. The server backfills every bookmark you
have, enriches each one with metadata, and then checks every ten minutes for
new ones — and for ones you have removed on the Bluesky side. Everything is
stored in a single SQLite file on your own machine, searchable through a fast
full-text index and a rich API.

Built on Bluesky's official [`@bsky/sdk`](https://www.npmjs.com/package/@bsky/sdk)
and the `app.bsky.bookmark.*` lexicons.

```
┌─ web ──────────────┐     ┌─ server ─────────────────────────────┐     ┌─ your PDS ─┐
│ React + Vite       │────▶│ Fastify · SQLite + FTS5              │────▶│ app.bsky   │
│ search · stats     │◀────│ sync engine · search · exports · API │◀────│ .bookmark  │
└────────────────────┘ SSE └──────────────────────────────────────┘     └────────────┘
```

## What it does

- **Backfills everything.** The first sync walks your whole bookmark list, with
  live progress in the interface.
- **Stays in step.** A quick check every ten minutes picks up new bookmarks; a
  full reconciliation every hour also notices the ones you have removed.
- **Keeps what Bluesky loses.** Un-bookmarked, deleted and blocked posts stay in
  your archive, flagged rather than dropped.
- **Derives metadata worth searching.** Links and their domains, images and
  their alt text, video, quote posts, replies versus top-level, mentions,
  hashtags, languages, labels, author verification, engagement counts, word
  counts, and when each post was written versus when you saved it.
- **Searches properly.** Exact phrases in quotes, typo-tolerant fuzzy matching
  outside them, BM25 relevance ranking, and filters on every piece of metadata.
- **Exports cleanly.** Netscape bookmark HTML (the format browsers, Raindrop and
  Pocket import), plus JSON, CSV and NDJSON.
- **Has a real API.** Everything the interface does is available over
  `/api/v1` with a personal API token.

## Quick start

### Docker

```bash
git clone https://github.com/j4ckxyz/bluesky-bookmark-manager.git
cd bluesky-bookmark-manager
cp .env.example .env    # optional — edit to change the port and other settings
docker compose up -d
```

Open <http://localhost:8787>.

#### Changing the port

If port 8787 is already in use on the host (`failed to bind host port
0.0.0.0:8787/tcp: address already in use`), set `HOST_PORT` in `.env`:

```bash
echo 'HOST_PORT=8080' >> .env
docker compose up -d
```

Then open <http://localhost:8080>. The server keeps listening on 8787 *inside*
the container; only the host side moves, and `PUBLIC_URL` follows `HOST_PORT`
automatically unless you set it yourself.

Note `PORT` in `.env` is for running from source (`npm start`) and is ignored
under Docker — use `HOST_PORT` there.

#### Other settings

Anything in `.env.example` can go in `.env`: `MULTI_USER`, `ALLOWED_HANDLES`,
`SYNC_INTERVAL_MINUTES`, `ENCRYPTION_KEY`, `LOG_LEVEL` and the rest. Values you
leave out or leave blank fall back to the server's own defaults. Apply changes
with `docker compose up -d` — no rebuild needed, since these are read at
container start.

### From source

Requires Node 22.12 or newer.

```bash
git clone https://github.com/j4ckxyz/bluesky-bookmark-manager.git
cd bluesky-bookmark-manager
npm install
npm run build
npm start
```

Open <http://localhost:8787>.

### Signing in

1. In the Bluesky app, go to **Settings → Privacy and security → App passwords**
   and create one. Your main password is never needed and will not work if the
   account has two-factor authentication on.
2. Enter your handle. Suggestions appear as you type, and your hosting provider
   is detected automatically — you can override it if detection is wrong or you
   run your own PDS.
3. Sign in. The backfill starts immediately and reports progress as it goes.

By default the first account to sign in claims the instance. To let other people
use the same server, set `MULTI_USER=true`; each account gets its own private
archive, and the server syncs all of them.

## Searching

Type words to search. Unquoted words tolerate typos and match word prefixes;
quoted phrases match exactly, in order.

| Syntax | Finds |
| --- | --- |
| `firehose backfill` | posts containing both words, fuzzily, ranked by relevance |
| `"account portability"` | that exact phrase, in that order |
| `-marketing` | excludes posts containing the word |
| `from:@alice.bsky.social` | posts by an account (`author:`, `by:` also work) |
| `-from:@alice.bsky.social` | everything except that account |
| `@bob.example.com` | posts mentioning an account (`mentions:` also works) |
| `domain:github.com` | posts linking to a domain, subdomains included |
| `#atproto` | posts with that hashtag (`tag:` also works) |
| `lang:en` | posts in a language |
| `has:link` | also `image`, `video`, `media`, `alt`, `quote`, `tag`, `mention`, `labels`, `text` |
| `is:reply` | also `root`, `quote`, `verified`, `removed`, `deleted`, `blocked`, `thread` |
| `after:2026-01` `before:2026-03-14` | when the post was written |
| `saved-after:2026-01-01` | when *you* bookmarked it |

Filters combine with everything else, and `-` negates `has:` and `is:` too.
Dates accept `2026`, `2026-03` or `2026-03-14`. Press <kbd>/</kbd> anywhere to
jump to the search box.

Sort by best match, recently saved, recently posted, most liked or most
reposted. The filter panel offers the same controls by clicking, and shows the
top accounts, domains and hashtags within your current results.

### How the fuzzy matching works

A term that exists in your archive is searched as-is, plus as a prefix. Only a
term that appears nowhere — and is not a prefix of anything — is expanded to
near-spellings from the index vocabulary, within one edit for short words and
two for longer ones. Terms of three characters or fewer are never fuzzed. When
a correction is applied the interface says so.

Ranking is BM25 across six weighted fields (post text, author, hashtags, link
text, alt text, quoted text), nudged by how recently you saved something and how
widely it was liked, with a bonus when the literal term you typed appears in the
post.

## Exporting

Exports respect whatever your current search matches, so "export what I am
looking at" works. Available from the **Export** menu, or directly:

```
GET /api/v1/export?format=html          # Netscape bookmarks — browsers, Raindrop, Pocket
GET /api/v1/export?format=json          # every field, including all derived metadata
GET /api/v1/export?format=csv           # one row per bookmark, for spreadsheets
GET /api/v1/export?format=ndjson        # one JSON object per line, for streaming
GET /api/v1/export?format=html&has=link&from=alice.bsky.social
```

The HTML export links to each post on bsky.app, carries the bookmark date as
`ADD_DATE`, and packs derived metadata (hashtags, author, `has-image`,
`lang-en`, …) into `TAGS` so importers that support it keep the detail.

## API

Everything the interface uses is available over HTTP. Create a token under
**Settings → API access**, then send it as a bearer token:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8787/api/v1/search?q=atproto&has=link&sort=likes&limit=10"
```

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/health` | Liveness. No authentication. |
| `GET /api/v1/instance` | Whether the instance is claimed and open. No authentication. |
| `GET /api/v1/search` | Search and filter. See parameters below. |
| `GET /api/v1/bookmarks` | The same engine, defaulting to a plain listing. |
| `GET /api/v1/bookmarks/:idOrUri` | One bookmark, by numeric id or URL-encoded AT-URI. |
| `GET /api/v1/stats` | Totals, top accounts and domains, activity over time. |
| `GET /api/v1/suggest?q=` | Autocomplete over accounts, hashtags and domains you have saved. |
| `GET /api/v1/export` | Export the current selection. |
| `GET /api/v1/sync/status` | Current or last sync job. |
| `GET /api/v1/sync/events` | Live job progress over server-sent events. |
| `POST /api/v1/sync` | Start a sync. Optional body `{"mode":"quick"\|"full"\|"backfill"}`. |
| `POST /api/v1/sync/cancel` | Stop the running sync. |
| `GET /api/v1/sync/history` | Recent runs. |
| `GET/POST /api/v1/tokens`, `DELETE /api/v1/tokens/:hint` | Manage API tokens. |
| `POST /api/v1/auth/login`, `/logout`, `/disconnect` | Session management. |
| `GET /api/v1/identity/typeahead?q=`, `/resolve?handle=` | Handle suggestions and PDS lookup. |

Search parameters: `q`, `limit` (max 200), `offset`, `sort`, `status`
(`active` · `removed` · `all`), `facets=1`, and comma-separated `from`,
`mentions`, `domain`, `tag`, `lang`, `has`, `is`, plus `before` and `after`.
They combine with anything in `q`.

A response carries `total`, `took`, the `terms` actually searched, any
`corrections` applied, the `results`, and `facets` when requested.

API tokens are stored only as a hash, and cannot be used to create more tokens.

## Configuration

Every setting is an environment variable, and every one is optional. See
[`.env.example`](.env.example) for the full list with defaults. The ones worth
knowing:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Where to listen. |
| `PUBLIC_URL` | `http://localhost:$PORT` | Your public address. An `https://` value turns on secure cookies. |
| `DATA_DIR` | `./data` | Where the database and encryption key live. |
| `ENCRYPTION_KEY` | generated | 32 bytes, base64 or hex. Protects stored refresh tokens. Generated into `DATA_DIR` if unset. |
| `MULTI_USER` | `false` | Allow more than one account to sign in. |
| `ALLOWED_HANDLES` | — | Comma-separated allowlist. |
| `SYNC_INTERVAL_MINUTES` | `10` | How often to check for new bookmarks. |
| `FULL_SYNC_EVERY` | `6` | Every Nth check is a full reconciliation. Hourly by default. |
| `PURGE_REMOVED_AFTER_DAYS` | `0` | Delete un-bookmarked posts after N days. `0` keeps them forever. |
| `TRUST_PROXY` | `false` | Set when behind a reverse proxy. |

### Behind a reverse proxy

Set `PUBLIC_URL` to your https address and `TRUST_PROXY=true`. The sync progress
stream is server-sent events, so make sure buffering is off — the server already
sends `X-Accel-Buffering: no`, which nginx honours.

## How syncing works

Three modes, chosen automatically:

- **Backfill** — the first full walk after signing in, paged 100 at a time with
  a short pause between pages.
- **Quick** — the every-ten-minutes check. It stops as soon as it has seen two
  consecutive pages of bookmarks it already knows, so it costs one or two
  requests once you are caught up.
- **Full** — every sixth check. Walks the whole list and, because a complete
  walk is the only proof a bookmark is gone, marks anything missing as removed.

Removal is a soft delete: the post stays in your archive with a timestamp, out
of your default results, findable under **Everything** or `is:removed`, and
restored automatically if you bookmark it again. Set
`PURGE_REMOVED_AFTER_DAYS` if you would rather they eventually go.

Each sync run is stamped with a monotonic id and every bookmark it sees records
that id, so reconciliation stays exact even when two runs land in the same
millisecond.

## Privacy and security

- Your app password is exchanged for a session and then discarded. The refresh
  token is encrypted with AES-256-GCM before it touches the database.
- Session cookies and API tokens are stored only as SHA-256 hashes.
- Nothing is sent anywhere except your own PDS and the public AppView (used
  unauthenticated for handle suggestions and profile pictures). Point
  `APPVIEW_URL` elsewhere, or leave the handle field alone, if you would rather
  it were not.
- The web interface is served same-origin, so there is no CORS surface, and
  cookies are `HttpOnly` and `SameSite=Lax`.
- Use an app password, never your main one, and revoke it in Bluesky's settings
  if you stop using this.

## Development

```bash
npm install
npm run dev:server   # API on :8787, restarts on change
npm run dev:web      # interface on :5173, proxies /api to the server
```

TypeScript runs directly under Node's type stripping, so there is no build step
in development.

```bash
npm run check        # typecheck both workspaces, then run the test suite
npm test             # 147 tests: metadata, query parsing, search, sync, API, exports
npm run seed:demo -w server   # fill the database with sample bookmarks
```

`seed:demo` prints a session cookie you can paste into your browser to try the
interface without a Bluesky account. Run the server with `SYNC_ENABLED=false`
alongside it, since the demo credentials are not real.

### Layout

```
server/
  src/
    atproto/     identity resolution, app-password sessions
    db/          schema, migrations, account and bookmark stores
    search/      query language parser, ranked search
    sync/        backfill and reconciliation engine, scheduler
    routes/      HTTP surface
    metadata.ts  everything derived from a bookmark view
    export.ts    Netscape HTML, JSON, CSV, NDJSON
  test/          node:test suites, fixture-driven
web/
  src/
    components/  sign-in, search, results, stats, settings
    lib/         API client, formatting, hooks
    styles/      design tokens and layout
```

The sync engine takes its page fetcher as an argument, so the whole thing is
tested against fixtures without a network.

## Licence

MIT. See [LICENSE](LICENSE).
