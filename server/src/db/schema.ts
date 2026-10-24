/**
 * Schema migrations. Each entry runs once, in order, inside a transaction.
 * Append new migrations; never edit a released one.
 */
export type Migration = { name: string; sql: string }

export const MIGRATIONS: Migration[] = [
  {
    name: '001_initial',
    sql: /* sql */ `
      CREATE TABLE accounts (
        did                   TEXT PRIMARY KEY,
        handle                TEXT NOT NULL,
        display_name          TEXT,
        avatar                TEXT,
        pds_url               TEXT NOT NULL,
        session_blob          TEXT,
        is_owner              INTEGER NOT NULL DEFAULT 0,
        disabled              INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        last_sync_at          TEXT,
        last_sync_status      TEXT,
        backfill_completed_at TEXT,
        sync_counter          INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE auth_sessions (
        token_hash   TEXT PRIMARY KEY,
        did          TEXT NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        last_seen_at TEXT,
        user_agent   TEXT
      );
      CREATE INDEX idx_auth_sessions_did ON auth_sessions(did);

      CREATE TABLE api_tokens (
        token_hash   TEXT PRIMARY KEY,
        did          TEXT NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        hint         TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at   TEXT
      );
      CREATE INDEX idx_api_tokens_did ON api_tokens(did);

      CREATE TABLE bookmarks (
        id                      INTEGER PRIMARY KEY,
        did                     TEXT NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
        uri                     TEXT NOT NULL,
        cid                     TEXT,
        rkey                    TEXT,

        bookmarked_at           TEXT,
        first_seen_at           TEXT NOT NULL,
        last_seen_at            TEXT NOT NULL,
        -- Id of the last sync run that saw this bookmark upstream. Run ids are
        -- strictly increasing, which makes reconciliation exact where a
        -- millisecond timestamp would tie between two back-to-back syncs.
        last_seen_run           INTEGER NOT NULL DEFAULT 0,
        removed_at              TEXT,
        status                  TEXT NOT NULL DEFAULT 'active',
        sort_index              INTEGER NOT NULL DEFAULT 0,
        item_state              TEXT NOT NULL DEFAULT 'ok',

        author_did              TEXT,
        author_handle           TEXT,
        author_display_name     TEXT,
        author_avatar           TEXT,
        author_verified         INTEGER NOT NULL DEFAULT 0,
        author_trusted_verifier INTEGER NOT NULL DEFAULT 0,

        text                    TEXT,
        created_at              TEXT,
        indexed_at              TEXT,

        is_reply                INTEGER NOT NULL DEFAULT 0,
        is_root                 INTEGER NOT NULL DEFAULT 1,
        is_self_reply           INTEGER NOT NULL DEFAULT 0,
        reply_root_uri          TEXT,
        reply_parent_uri        TEXT,
        reply_parent_did        TEXT,

        is_quote                INTEGER NOT NULL DEFAULT 0,
        quoted_uri              TEXT,
        quoted_author_handle    TEXT,
        quoted_text             TEXT,

        has_links               INTEGER NOT NULL DEFAULT 0,
        link_count              INTEGER NOT NULL DEFAULT 0,
        has_images              INTEGER NOT NULL DEFAULT 0,
        image_count             INTEGER NOT NULL DEFAULT 0,
        has_alt_text            INTEGER NOT NULL DEFAULT 0,
        has_video               INTEGER NOT NULL DEFAULT 0,
        has_media               INTEGER NOT NULL DEFAULT 0,
        has_external            INTEGER NOT NULL DEFAULT 0,
        external_uri            TEXT,
        external_title          TEXT,
        external_description    TEXT,
        primary_domain          TEXT,

        mention_count           INTEGER NOT NULL DEFAULT 0,
        tag_count               INTEGER NOT NULL DEFAULT 0,
        langs                   TEXT NOT NULL DEFAULT '[]',
        labels                  TEXT NOT NULL DEFAULT '[]',
        has_labels              INTEGER NOT NULL DEFAULT 0,

        word_count              INTEGER NOT NULL DEFAULT 0,
        char_count              INTEGER NOT NULL DEFAULT 0,
        alt_text                TEXT,

        like_count              INTEGER,
        repost_count            INTEGER,
        reply_count             INTEGER,
        quote_count             INTEGER,
        bookmark_count          INTEGER,

        raw                     TEXT,
        UNIQUE (did, uri)
      );

      CREATE INDEX idx_bookmarks_owner        ON bookmarks(did, status);
      CREATE INDEX idx_bookmarks_bookmarked   ON bookmarks(did, status, bookmarked_at DESC);
      CREATE INDEX idx_bookmarks_created      ON bookmarks(did, status, created_at DESC);
      CREATE INDEX idx_bookmarks_author       ON bookmarks(did, author_handle);
      CREATE INDEX idx_bookmarks_domain       ON bookmarks(did, primary_domain);
      CREATE INDEX idx_bookmarks_last_seen    ON bookmarks(did, last_seen_run);

      CREATE TABLE bookmark_links (
        bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
        url         TEXT NOT NULL,
        domain      TEXT NOT NULL,
        source      TEXT NOT NULL,
        title       TEXT
      );
      CREATE INDEX idx_links_bookmark ON bookmark_links(bookmark_id);
      CREATE INDEX idx_links_domain   ON bookmark_links(domain);

      CREATE TABLE bookmark_mentions (
        bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
        did         TEXT,
        handle      TEXT
      );
      CREATE INDEX idx_mentions_bookmark ON bookmark_mentions(bookmark_id);
      CREATE INDEX idx_mentions_handle   ON bookmark_mentions(handle);
      CREATE INDEX idx_mentions_did      ON bookmark_mentions(did);

      CREATE TABLE bookmark_tags (
        bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
        tag         TEXT NOT NULL
      );
      CREATE INDEX idx_tags_bookmark ON bookmark_tags(bookmark_id);
      CREATE INDEX idx_tags_tag      ON bookmark_tags(tag);

      CREATE TABLE sync_runs (
        id           INTEGER PRIMARY KEY,
        did          TEXT NOT NULL REFERENCES accounts(did) ON DELETE CASCADE,
        mode         TEXT NOT NULL,
        trigger      TEXT NOT NULL,
        status       TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        finished_at  TEXT,
        pages        INTEGER NOT NULL DEFAULT 0,
        scanned      INTEGER NOT NULL DEFAULT 0,
        created      INTEGER NOT NULL DEFAULT 0,
        updated      INTEGER NOT NULL DEFAULT 0,
        removed      INTEGER NOT NULL DEFAULT 0,
        restored     INTEGER NOT NULL DEFAULT 0,
        error        TEXT
      );
      CREATE INDEX idx_sync_runs_did ON sync_runs(did, started_at DESC);

      -- Full-text index. Rowid is kept in lockstep with bookmarks.id.
      CREATE VIRTUAL TABLE bookmarks_fts USING fts5(
        text,
        author,
        tags,
        link_text,
        alt_text,
        quoted_text,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      -- Auto-maintained term vocabulary, used for typo expansion and suggestions.
      CREATE VIRTUAL TABLE bookmarks_vocab USING fts5vocab(bookmarks_fts, row);

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    // Thumbnail for an external link card, so posts can show the Open Graph
    // image rather than a bare title. Existing rows stay NULL until a full
    // sync re-reads them from the AppView.
    name: '002_external_thumb',
    sql: /* sql */ `
      ALTER TABLE bookmarks ADD COLUMN external_thumb TEXT;
    `,
  },
  {
    // Token scopes: a `full` token reaches the whole `/api/v1` surface, an
    // `agent` token only the read-only `/api/agent/v1` surface. Existing
    // tokens keep the access they were created with. Tokens may also expire.
    name: '003_token_scopes',
    sql: /* sql */ `
      ALTER TABLE api_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'full';
      ALTER TABLE api_tokens ADD COLUMN expires_at TEXT;
    `,
  },
]
