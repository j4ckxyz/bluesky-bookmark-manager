# [This](https://constellation.microcosm.blue/) is a [constellation 🌌](https://github.com/at-microcosm/links/tree/main/constellation) API server from [microcosm](https://github.com/at-microcosm) ✨

Constellation is a self-hosted JSON API to an atproto-wide index of PDS record back-links, so you can query social interactions in real time. It can answer questions like:

- [How many people liked a liked a bluesky post?](https://constellation.microcosm.blue/links/count/distinct-dids?target=at%3A//did%3Aplc%3A44ybard66vv44zksje25o7dz/app.bsky.feed.post/3lhhz7k2yqk2h&collection=app.bsky.feed.like&path=.subject.uri)
- [Who are all the bluesky followers of an identity?](https://constellation.microcosm.blue/links/distinct-dids?target=did:plc:oky5czdrnfjpqslsw2a5iclo&collection=app.bsky.graph.follow&path=.subject)
- [What are all the replies to a Frontpage submission?](https://constellation.microcosm.blue/links?target=at://did:plc:nlromb2qyyl6rszaluwhfy6j/fyi.unravel.frontpage.post/3lhd2ivyc422n&collection=fyi.unravel.frontpage.comment&path=.post.uri)
- [What are _all_ the sources of links to an identity?](https://constellation.microcosm.blue/links/all?target=did:plc:vc7f4oafdgxsihk4cry2xpze)
- and more

It works by recursively walking _all_ records coming through the firehose, searching for anything that looks like a link. Links are indexed by the target they point at, the collection the record came from, and the JSON path to the link in that record.

This server has indexed 7,804,665,377 links between 1,422,295,754 targets and sources from 19,081,229 identities over 211 days.  
(indexing new records in real time, backfill still TODO)

The API is currently **unstable**. But feel free to use it! If you want to be nice, put your project name and bsky username (or email) in your user-agent header for api requests.

## API Endpoints

### `GET /links`

A list of records linking to a target.

#### Query parameters:

- `target`: required, must url-encode. Example: `at://did:plc:vc7f4oafdgxsihk4cry2xpze/app.bsky.feed.post/3lgwdn7vd722r`
- `collection`: required. Example: `app.bsky.feed.like`
- `path`: required, must url-encode. Example: `.subject.uri`

**Try it:**

**GET** /links
  ?target=     
  &collection= 
  &path=        get links

### `GET /links/distinct-dids`

A list of distinct DIDs (identities) with links to a target.

#### Query parameters:

- `target`: required, must url-encode. Example: `at://did:plc:vc7f4oafdgxsihk4cry2xpze/app.bsky.feed.post/3lgwdn7vd722r`
- `collection`: required. Example: `app.bsky.feed.like`
- `path`: required, must url-encode. Example: `.subject.uri`

**Try it:**

**GET** /links/distinct-dids
  ?target=     
  &collection= 
  &path=        get links

### `GET /links/count`

The total number of links pointing at a given target.

#### Query parameters:

- `target`: required, must url-encode. Example: `did:plc:vc7f4oafdgxsihk4cry2xpze`
- `collection`: required. Example: `app.bsky.graph.block`
- `path`: required, must url-encode. Example: `.subject`
- `cursor`: optional, see Definitions.

**Try it:**

**GET** /links/count
  ?target=     
  &collection= 
  &path=        get links count

### `GET /links/count/distinct-dids`

The total number of DIDs (identities) with links to at a given target.

#### Query parameters:

- `target`: required, must url-encode. Example: `did:plc:vc7f4oafdgxsihk4cry2xpze`
- `collection`: required. Example: `app.bsky.graph.block`
- `path`: required, must url-encode. Example: `.subject`
- `cursor`: optional, see Definitions.

**Try it:**

**GET** /links/count/distinct-dids
  ?target=     
  &collection= 
  &path=        get links count

### `GET /links/all`

Show all sources with links to a target, including linking record counts and distinct linking DIDs

#### Query parameters:

- `target`: required, must url-encode. Example: `did:plc:oky5czdrnfjpqslsw2a5iclo`

**Try it:**

**GET** /links/all?target= get all target link counts

### `[deprecated] GET /links/all/count`

The total counts of all links pointing at a given target, by collection and path.

DEPRECATED: Use `GET /links/all` instead.

#### Query parameters:

- `target`: required, must url-encode. Example: `did:plc:oky5czdrnfjpqslsw2a5iclo`

**Try it:**

**GET** /links/all/count?target= get all target link counts

## Definitions

### Target

A DID like `did:plc:hdhoaan3xa3jiuq4fg4mefid`, or an AT-URI like `at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3lgu4lg6j2k2v`, or a URI like `https://example.com`.

### Collection

A record NSID like `app.bsky.feed.like`.

### Path

A (currently-very-very-hacky) json-path-ish representation of the source of a link in a record. Records may contain multiple links with different meanings, so this specifies which specific link is of interest. Like `.subject.uri`.

### Cursor

Paged responses include a `cursor` property. When it's `null`, no more data is available. If it's not null, you can repeat the request with `&cursor=<cursor>` in the URL query to get the next set of responses.

To get this response as JSON, set request header `Accept: application/json`.

[Constellation API docs main](https://constellation.microcosm.blue/)