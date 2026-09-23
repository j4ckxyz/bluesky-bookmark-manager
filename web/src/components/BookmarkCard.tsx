import { useState } from 'react'
import {
  BadgeCheck,
  BookmarkX,
  ExternalLink,
  EyeOff,
  Film,
  Heart,
  Image as ImageIcon,
  Link2,
  MessageSquare,
  Quote,
  Repeat2,
  Tag as TagIcon,
  Trash2,
  User,
} from 'lucide-react'
import { compactNumber, fullDate, highlightRuns, prettyUrl, relativeTime } from '../lib/format.ts'
import type { Bookmark } from '../lib/types.ts'

type Props = {
  bookmark: Bookmark
  terms: string[]
  onFilter: (fragment: string) => void
}

/** Renders post text with the matched search terms marked. */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0 || text.length === 0) return <>{text}</>
  return (
    <>
      {highlightRuns(text, terms).map((run, index) =>
        run.match ? <mark key={index}>{run.text}</mark> : <span key={index}>{run.text}</span>,
      )}
    </>
  )
}

/**
 * An external link. When the post carried an Open Graph image we show the full
 * card; otherwise it falls back to the compact title-and-domain row. A thumb
 * that fails to load (link rot, a blocked CDN) drops back to the compact form
 * rather than leaving a broken image behind.
 */
function LinkCard({
  url,
  domain,
  title,
  description,
  thumb,
}: {
  url: string
  domain: string | null
  title: string
  description: string | null
  thumb: string | null
}) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const showThumb = Boolean(thumb) && !thumbFailed

  return (
    <a
      className={`bookmark__link${showThumb ? ' bookmark__link--rich' : ''}`}
      href={url}
      target="_blank"
      rel="noreferrer noopener"
    >
      {showThumb ? (
        <img
          className="bookmark__link-thumb"
          src={thumb ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setThumbFailed(true)}
        />
      ) : (
        <Link2 size={15} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
      )}
      <span className="bookmark__link-body">
        <span className="bookmark__link-title">{title}</span>
        {showThumb && description && (
          <span className="bookmark__link-desc">{description}</span>
        )}
        <span className="bookmark__link-domain">{domain}</span>
        <span className="visually-hidden"> (opens in a new tab)</span>
      </span>
    </a>
  )
}

export function BookmarkCard({ bookmark, terms, onFilter }: Props) {
  const displayName = bookmark.authorDisplayName || bookmark.authorHandle || 'Unknown account'
  const externalLink =
    bookmark.links.find((link) => link.source === 'embed') ?? bookmark.links[0] ?? null

  return (
    <article
      className={`bookmark${bookmark.status === 'removed' ? ' bookmark--removed' : ''}`}
      aria-label={`Bookmark from ${displayName}`}
    >
      <header className="bookmark__head">
        {bookmark.authorAvatar ? (
          <img className="bookmark__avatar" src={bookmark.authorAvatar} alt="" loading="lazy" />
        ) : (
          <span className="bookmark__avatar bookmark__avatar--placeholder" aria-hidden="true">
            <User size={16} />
          </span>
        )}

        <div className="bookmark__identity">
          <span className="bookmark__name">
            {displayName}
            {bookmark.authorVerified && (
              <BadgeCheck size={14} className="bookmark__verified" aria-label="Verified account" />
            )}
          </span>
          {bookmark.authorHandle && (
            <button
              type="button"
              className="bookmark__handle"
              style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer' }}
              onClick={() => onFilter(`from:@${bookmark.authorHandle}`)}
              title={`Show everything from @${bookmark.authorHandle}`}
            >
              @{bookmark.authorHandle}
            </button>
          )}
        </div>

        <div className="bookmark__meta">
          <time dateTime={bookmark.createdAt ?? undefined} title={fullDate(bookmark.createdAt)}>
            {relativeTime(bookmark.createdAt)}
          </time>
          {bookmark.postUrl && (
            <a
              className="button button--ghost button--icon"
              href={bookmark.postUrl}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Open on Bluesky"
              title="Open on Bluesky"
            >
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      </header>

      {bookmark.itemState === 'not_found' ? (
        <p className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Trash2 size={14} /> This post has been deleted. Its metadata is kept here.
        </p>
      ) : bookmark.itemState === 'blocked' ? (
        <p className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <EyeOff size={14} /> This post is not visible to you any more.
        </p>
      ) : (
        <p className="bookmark__text">
          <Highlighted text={bookmark.text} terms={terms} />
        </p>
      )}

      {bookmark.quotedText && (
        <blockquote className="bookmark__quote">
          <span className="bookmark__quote-author">
            @{bookmark.quotedAuthorHandle ?? 'unknown'}
          </span>
          <Highlighted text={bookmark.quotedText} terms={terms} />
        </blockquote>
      )}

      {externalLink && (
        <LinkCard
          url={externalLink.url}
          domain={externalLink.domain}
          title={bookmark.externalTitle || externalLink.title || prettyUrl(externalLink.url)}
          description={bookmark.externalDescription}
          thumb={bookmark.externalThumb}
        />
      )}

      {bookmark.altText && (
        <div className="bookmark__alt">
          <ImageIcon size={13} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>
            <Highlighted text={bookmark.altText} terms={terms} />
          </span>
        </div>
      )}

      <footer className="bookmark__footer">
        {bookmark.status === 'removed' && (
          <span className="badge badge--warning">
            <BookmarkX size={11} />
            Un-bookmarked {relativeTime(bookmark.removedAt)}
          </span>
        )}

        {bookmark.isReply && (
          <button type="button" className="tag-chip" onClick={() => onFilter('is:reply')}>
            reply
          </button>
        )}
        {bookmark.isQuote && (
          <button type="button" className="tag-chip" onClick={() => onFilter('is:quote')}>
            <Quote size={10} style={{ verticalAlign: '-1px' }} /> quote
          </button>
        )}
        {bookmark.hasVideo && (
          <button type="button" className="tag-chip" onClick={() => onFilter('has:video')}>
            <Film size={10} style={{ verticalAlign: '-1px' }} /> video
          </button>
        )}
        {bookmark.imageCount > 0 && (
          <button type="button" className="tag-chip" onClick={() => onFilter('has:image')}>
            <ImageIcon size={10} style={{ verticalAlign: '-1px' }} />{' '}
            {bookmark.imageCount === 1 ? 'image' : `${bookmark.imageCount} images`}
          </button>
        )}
        {bookmark.primaryDomain && (
          <button
            type="button"
            className="tag-chip"
            onClick={() => onFilter(`domain:${bookmark.primaryDomain}`)}
          >
            {bookmark.primaryDomain}
          </button>
        )}
        {bookmark.tags.map((tag) => (
          <button
            key={tag}
            type="button"
            className="tag-chip"
            onClick={() => onFilter(`#${tag}`)}
          >
            <TagIcon size={10} style={{ verticalAlign: '-1px' }} /> {tag}
          </button>
        ))}
        {bookmark.labels.map((label) => (
          <span key={label} className="badge badge--danger">
            {label}
          </span>
        ))}

        <div className="bookmark__stats">
          {bookmark.likeCount !== null && (
            <span className="bookmark__stat" title="Likes">
              <Heart size={12} /> {compactNumber(bookmark.likeCount)}
            </span>
          )}
          {bookmark.repostCount !== null && (
            <span className="bookmark__stat" title="Reposts">
              <Repeat2 size={12} /> {compactNumber(bookmark.repostCount)}
            </span>
          )}
          {bookmark.replyCount !== null && (
            <span className="bookmark__stat" title="Replies">
              <MessageSquare size={12} /> {compactNumber(bookmark.replyCount)}
            </span>
          )}
          <span className="bookmark__stat" title={`Saved ${fullDate(bookmark.bookmarkedAt)}`}>
            saved {relativeTime(bookmark.bookmarkedAt)}
          </span>
        </div>
      </footer>
    </article>
  )
}
