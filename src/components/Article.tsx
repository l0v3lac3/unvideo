import { useEffect, useState } from 'react';
import { Player, type StreamSource } from './Player';
import { getArticle } from '../lib/api';
import { restoreScroll } from '../lib/router';
import type {
  Article,
  ArticleBlock,
  Recommendation,
  VideoBlock,
} from '../lib/types';

/**
 * Parsed articles are cached for the session: returning via back/forward (or
 * a recommendation) repaints instantly instead of showing a blank page while
 * the node is scraped again. A background revalidation still runs on every
 * mount.
 */
const articleCache = new Map<string, Article>();
const ARTICLE_CACHE_LIMIT = 30;
/** Original <title>, restored when leaving the article. */
const BASE_TITLE = document.title;

function cacheKey(src: string, path: string): string {
  return `${src}|${path}`;
}

function rememberArticle(key: string, article: Article) {
  articleCache.set(key, article);
  while (articleCache.size > ARTICLE_CACHE_LIMIT) {
    const oldest = articleCache.keys().next().value;
    if (oldest === undefined) break;
    articleCache.delete(oldest);
  }
}

/**
 * Article detail: metadata up top, then the normalized body blocks (text,
 * headings, quotes, images, videos and recommendation entries interleaved in
 * source order). Station promo posts (promo) render their text but no player.
 *
 * The video source for a `video` block:
 *  - `video.type === 'hls'` → hls.js against the m3u8 directly
 *  - otherwise → progressive `video.src`
 */
function videoSource(v: VideoBlock | null | undefined): StreamSource | null {
  if (!v) return null;
  // `pageUrl` videos must go through the source's video endpoint (rou.video
  // unwraps the PNG container and signs the playlist server-side).
  if (v.pageUrl) return { kind: 'rou', pageUrl: v.pageUrl };
  return {
    kind: 'url',
    url: v.url,
    type: v.type === 'hls' ? 'hls' : 'mp4',
  };
}

function RecCard({
  rec,
  onOpen,
}: {
  rec: Recommendation;
  onOpen: (p: string) => void;
}) {
  return (
    <button
      className="rec-card"
      onClick={() => onOpen(rec.path)}
      title={rec.title}
    >
      {rec.cover ? (
        <img className="rec-cover" src={rec.cover} alt="" loading="lazy" />
      ) : null}
      <span className="rec-text">
        <span className="rec-title">{rec.title}</span>
        {rec.desc ? <span className="rec-desc">{rec.desc}</span> : null}
      </span>
    </button>
  );
}

function BodyBlockView({
  block,
  index,
  src,
  path,
  onOpen,
}: {
  block: ArticleBlock;
  index: number;
  src: string;
  path: string;
  onOpen: (p: string) => void;
}) {
  switch (block.type) {
    case 'h': {
      const Tag = (block.level >= 3 ? 'h3' : 'h2') as 'h2' | 'h3';
      return <Tag className="article-heading">{block.text}</Tag>;
    }
    case 'img':
      return (
        <figure className="article-figure">
          <img src={block.url} alt="" loading="lazy" />
        </figure>
      );
    case 'quote':
      return <blockquote className="article-quote">{block.text}</blockquote>;
    case 'video': {
      const source = videoSource(block.video);
      if (!source) return null;
      return (
        <Player
          key={`${src}${path}#${index}${block.video.id || block.video.url}`}
          source={source}
        />
      );
    }
    case 'rec':
      return <RecCard rec={block.rec} onOpen={onOpen} />;
    case 'p':
      return <p className="article-p">{block.text}</p>;
  }
}

export function Article({
  src,
  path,
  node,
  onOpenPath,
}: {
  src: string;
  path: string;
  /** Content node (from site info) — passed to the backend request. */
  node: string;
  onOpenPath: (path: string) => void;
}) {
  const key = cacheKey(src, path);
  const [article, setArticle] = useState<Article | null>(
    () => articleCache.get(key) ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getArticle(src, path, node)
      .then((res) => {
        if (cancelled) return;
        rememberArticle(key, res);
        setArticle(res);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [key, src, path, node]);

  // Keep the tab title in sync (useful when several articles are in history)
  // and let the router apply a remembered scroll offset once content exists.
  useEffect(() => {
    if (!article) return;
    document.title = `${article.title} · unvideo`;
    restoreScroll();
    return () => {
      document.title = BASE_TITLE;
    };
  }, [article]);

  // Fallback for articles without body blocks: description + player + gallery.
  const hasBody = !!article?.blocks.length;

  return (
    <section className="article">
      {error ? <p className="hint">{error}</p> : null}

      {!article && !error ? <p className="status">正在加载文章…</p> : null}

      {article ? (
        <>
          <header className="article-header">
            <h1 className="article-title">{article.title}</h1>
            {article.promo ? (
              <span className="promo-badge">站点活动 / 广告</span>
            ) : null}
            <dl className="article-meta">
              {article.author ? (
                <>
                  <dt>作者</dt>
                  <dd>{article.author}</dd>
                </>
              ) : null}
              {article.published ? (
                <>
                  <dt>发布</dt>
                  <dd>{new Date(article.published).toLocaleString('zh-CN')}</dd>
                </>
              ) : null}
              {article.categories?.length ? (
                <>
                  <dt>栏目</dt>
                  <dd>{article.categories.join(' / ')}</dd>
                </>
              ) : null}
              {article.tags?.length ? (
                <>
                  <dt>标签</dt>
                  <dd className="article-tags">
                    {article.tags.map((t) => (
                      <button
                        key={t.path}
                        className="tag"
                        title={t.name}
                        onClick={() => {
                          if (t.path.startsWith('/')) onOpenPath(t.path);
                        }}
                      >
                        {t.name}
                      </button>
                    ))}
                  </dd>
                </>
              ) : null}
            </dl>
          </header>

          {hasBody ? (
            <div className="article-body">
              {article.blocks.map((block, i) => (
                <BodyBlockView
                  key={i}
                  block={block}
                  index={i}
                  src={article.src}
                  path={path}
                  onOpen={onOpenPath}
                />
              ))}
            </div>
          ) : (
            <>
              {article.description ? (
                <p className="article-desc">{article.description}</p>
              ) : null}
              {videoSource(article.video) ? (
                <Player
                  key={`${src}${path}`}
                  source={videoSource(article.video)!}
                />
              ) : (
                <p className="status">该文章没有可解析的视频。</p>
              )}
              {article.images?.length ? (
                <div className="gallery">
                  {article.images.map((img, i) => (
                    <figure className="article-figure" key={i}>
                      <img src={img} alt="" loading="lazy" />
                    </figure>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
