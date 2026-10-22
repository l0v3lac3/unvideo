import { navigate } from '../lib/router';
import { SOURCES, sourceHomeRoute } from '../lib/sources';

/**
 * Home: one card per registered source. Adding a site means adding a registry
 * entry (backend + frontend) — this view never changes.
 */
export function Home() {
  return (
    <section className="home">
      <div className="home-grid">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            className="home-card"
            onClick={() => navigate(sourceHomeRoute(s))}
          >
            <span className="home-card-kind">
              {s.kind === 'video' ? '视频解析' : '资讯视频'}
            </span>
            <h2 className="home-card-title">{s.label}</h2>
            <p className="home-card-desc">{s.desc}</p>
          </button>
        ))}
      </div>
    </section>
  );
}
