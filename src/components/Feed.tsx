import { useEffect, useState } from 'react';
import { getFeed } from '../lib/api';
import { searchQueryOf } from '../lib/router';
import type { FeedItem, FeedPage } from '../lib/types';

/**
 * Feed pages are kept for the session so back/forward and site switches
 * repaint the list immediately (and scroll restoration has a stable height to
 * land on). A fresh fetch always runs in the background to pick up new posts.
 */
const feedCache = new Map<string, FeedPage>();
const FEED_CACHE_LIMIT = 60;

function cacheKey(
  src: string,
  node: string,
  path: string,
  page: number,
): string {
  return `${src}|${node}|${path}|${page}`;
}

function remember(key: string, result: FeedPage) {
  feedCache.set(key, result);
  while (feedCache.size > FEED_CACHE_LIMIT) {
    const oldest = feedCache.keys().next().value;
    if (oldest === undefined) break;
    feedCache.delete(oldest);
  }
}

/** One row in the feed. */
function FeedCard({
  item,
  onOpen,
  onOpenPath,
}: {
  item: FeedItem;
  onOpen: (item: FeedItem) => void;
  onOpenPath: (path: string) => void;
}) {
  const date = item.published
    ? new Date(item.published).toLocaleDateString('zh-CN')
    : '';
  // A div (not a <button>) so the tag chips inside can be real buttons.
  return (
    <div
      className="feed-card"
      role="button"
      tabIndex={0}
      aria-label={item.title}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(item);
        }
      }}
    >
      <div className="feed-cover">
        {item.cover ? (
          <img src={item.cover} alt="" loading="lazy" />
        ) : (
          <div className="feed-cover-empty">无封面</div>
        )}
      </div>
      <div className="feed-body">
        <h3 className="feed-title" title={item.title}>
          {item.title}
        </h3>
        <div className="feed-meta">
          {(item.tags ?? []).slice(0, 3).map((t) => (
            <button
              key={t.path}
              className="feed-cat"
              title={t.name}
              onClick={(e) => {
                e.stopPropagation();
                if (t.path.startsWith('/')) onOpenPath(t.path);
              }}
            >
              {t.name}
            </button>
          ))}
        </div>
        <div className="feed-foot">
          {date ? <span>{date}</span> : null}
          {(item.meta ?? []).map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Prev/next, the current page indicator, a page input and an explicit jump
 * button. Rendered both above and below the grid so deep paging (thousands of
 * pages) does not require scrolling to the bottom and back.
 */
function PageControls({
  page,
  totalPages,
  onPageChange,
  className = '',
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(String(page));

  const jump = () => {
    const value = Number(draft);
    if (!Number.isInteger(value) || value < 1) {
      setDraft(String(page));
      return;
    }
    const target = Math.min(totalPages, value);
    setDraft(String(target));
    if (target !== page) onPageChange(target);
  };

  return (
    <div className={`pager${className ? ` ${className}` : ''}`}>
      <button disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        上一页
      </button>
      <span>
        {page} / {totalPages}
      </span>
      <input
        type="number"
        min={1}
        max={totalPages}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            jump();
          }
        }}
        aria-label="页码"
      />
      <button onClick={jump}>跳转</button>
      <button
        disabled={page >= totalPages}
        onClick={() => onPageChange(page + 1)}
      >
        下一页
      </button>
    </div>
  );
}

/**
 * Paginated feed (home or category) for one feed source. Fetches through the
 * Convex backend so the browser never needs CORS to the node, and hands a
 * chosen item up to the parent to open as an article.
 *
 * `page` is owned by the route (not local state) so the browser back button and
 * in-app paging stay in sync. Mount with a key that includes src+path+page to
 * reset the view when the route changes.
 */
export function Feed({
  src,
  path,
  page,
  node,
  onOpen,
  onOpenPath,
  onPageChange,
}: {
  src: string;
  path: string;
  page: number;
  node: string;
  onOpen: (item: FeedItem) => void;
  onOpenPath: (path: string) => void;
  onPageChange: (page: number) => void;
}) {
  const key = cacheKey(src, node, path, page);
  const [data, setData] = useState<FeedPage | null>(
    () => feedCache.get(key) ?? null,
  );
  const [loading, setLoading] = useState(() => !feedCache.has(key));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFeed(src, path, page, node)
      .then((res) => {
        if (cancelled) return;
        remember(key, res);
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, src, path, page, node]);

  const totalPages = data?.totalPages ?? 0;

  // Search results list (path = /search/<query>/): show a heading with the
  // decoded query and an explicit no-results state (upstream pages with no
  // matches simply render 0 cards).
  const isSearch = path.startsWith('/search/');
  const searchQuery = isSearch ? searchQueryOf(path) : '';

  const goToPage = (next: number) => {
    if (next < 1 || next > totalPages || next === page) return;
    onPageChange(next);
  };

  return (
    <section className="feed">
      {isSearch ? (
        <h2 className="feed-search-head">搜索「{searchQuery}」的结果</h2>
      ) : null}
      {data && data.items.length === 0 ? (
        <p className="status">
          {isSearch
            ? `没有搜到「${searchQuery}」的相关内容，换个关键词试试`
            : '没有内容'}
        </p>
      ) : null}
      {data && totalPages > 1 ? (
        <PageControls
          className="pager-top"
          page={page}
          totalPages={totalPages}
          onPageChange={goToPage}
        />
      ) : null}

      <div className="feed-grid">
        {loading && !data
          ? Array.from({ length: 8 }).map((_, i) => (
              <div className="feed-card feed-skeleton" key={i} />
            ))
          : data?.items.map((item) => (
              <FeedCard
                key={item.id}
                item={item}
                onOpen={onOpen}
                onOpenPath={onOpenPath}
              />
            ))}
      </div>

      {error ? <p className="hint">{error}</p> : null}

      {data && totalPages > 1 ? (
        <PageControls
          page={page}
          totalPages={totalPages}
          onPageChange={goToPage}
        />
      ) : null}
    </section>
  );
}
