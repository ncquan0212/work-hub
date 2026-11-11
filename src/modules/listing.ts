// F2 · Public Google Play listing of each app: rating, rating count, installs bucket, last update.
// Public pages, no login. Rating comes from the page's JSON-LD (structured data); installs and the
// update date are read next to their visible labels and validated, so a layout change gives "—",
// never a wrong number (2026-11-08: a plain text regex picked up other apps' ratings on pages that
// have none of their own).
import { APPS } from '../config.ts'
import { ago, cut, empty, esc, link, num, section, stale } from '../core/html.ts'
import { NotConfigured, type Module } from '../core/types.ts'

export type Listing = { key: string; name: string; error?: string; title?: string | null; rating?: number | null; ratings?: number | null
  installs?: string | null; updated?: string | null; url: string }

export function parseListing(html: string) {
  let rating: number | null = null, ratings: number | null = null, title: string | null = null
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const j = JSON.parse(m[1])
      if (j?.['@type'] !== 'SoftwareApplication') continue
      title = typeof j.name === 'string' ? j.name : null
      const r = j.aggregateRating
      if (r && Number.isFinite(Number(r.ratingValue))) { rating = Number(r.ratingValue); ratings = Number.isFinite(Number(r.ratingCount)) ? Number(r.ratingCount) : null }
    } catch { /* not JSON */ }
  }
  const installs = html.match(/>([^<>]{1,16})<\/div><div[^>]*>Downloads<\/div>/)?.[1]?.trim() ?? null
  const updated = html.match(/>Updated on<\/div><div[^>]*>([^<>]{4,30})<\/div>/)?.[1]?.trim() ?? null
  return {
    title,
    rating: rating != null && rating >= 1 && rating <= 5 ? rating : null,
    ratings,
    installs: installs && /^\d[\d.,]*[KMB]?\+$/.test(installs) ? installs : null,
    updated: updated && !Number.isNaN(Date.parse(updated)) ? updated : null,
  }
}

export const listing: Module<Listing[]> = {
  id: 'listing', title: 'Trang Play công khai', group: 'feedback', every: 6 * 3600, timeout: 90,

  async collect({ signal }) {
    if (!APPS.length) throw new NotConfigured('chưa có app trong data/config.json')
    const out = await Promise.all(APPS.map(async (a): Promise<Listing> => {
      const url = `https://play.google.com/store/apps/details?id=${encodeURIComponent(a.pkg)}&hl=en&gl=US`
      try {
        const r = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { 'accept-language': 'en-US,en' } })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return { key: a.key, name: a.name, url, ...parseListing(await r.text()) }
      } catch (e) {
        return { key: a.key, name: a.name, url, error: (e as Error).message }
      }
    }))
    if (out.length && out.every(r => r.error)) throw new Error(out[0].error!) // every app failed: keep the old numbers, raise the alert
    return out
  },

  css: String.raw`
@media (min-width: 48rem) and (max-width: 79.99rem) { .listing-panel { grid-column: 1 / -1 } }
.listing-body { container: listing / inline-size; min-width: 0 }
.listing-apps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: var(--space-lg) }
.listing-apps > li { grid-row: span 5; display: grid; grid-template-rows: subgrid; row-gap: var(--space-2xs); align-content: start; min-width: 0; padding: var(--space-md) 0 0; border-top: 1px solid var(--rule) }
.listing-apps > li:nth-child(-n+2) { border-top: 0; padding-top: 0 }
.listing-apps > li:nth-child(n+3) { margin-top: var(--space-md) }
.listing-apps .sub { margin: 0; overflow-wrap: anywhere }
.listing-name { font-weight: 600; min-width: 0; overflow-wrap: anywhere }
.listing-rating { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2xs) var(--space-xs); margin-top: var(--space-2xs) }
.listing-rating .fig { font-size: var(--text-2xl); font-weight: 400 }
.listing-none { color: var(--muted); font-size: var(--text-sm) }
@container listing (min-width: 40rem) {
  .listing-apps { grid-template-columns: repeat(4, minmax(0, 1fr)) }
  .listing-apps > li:nth-child(-n+4) { border-top: 0; padding-top: 0; margin-top: 0 }
  .listing-rating .fig { font-size: var(--text-fig); font-weight: 300 }
}
`,

  panel(s, v) {
    const o = { cls: 'listing-panel' }
    if (!s?.data) return section(this.title, `${stale(s, v.now)}${empty('Đang lấy lần đầu…')}`, '', 'listing', o)
    const day = (x: string) => new Date(Date.parse(x)).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const items = s.data.map(l => `<li><div class="listing-name">${link(l.url, l.name)}</div>${l.error ? `<p class="sub bad-t">${esc(cut(l.error, 120))}</p>` : `
      <div class="sub muted">${esc(cut(l.title, 48))}</div>
      <div class="listing-rating">${l.rating == null ? '<span class="listing-none">chưa có điểm</span>' : `<span class="fig">${esc(l.rating.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}</span><span class="muted">${esc(num(l.ratings))} lượt</span>`}</div>
      <div class="sub">${l.installs ? `${esc(l.installs)} lượt cài` : '<span class="muted">chưa rõ lượt cài</span>'}</div>
      <div class="sub muted">${l.updated ? `cập nhật ${esc(day(l.updated))}` : 'chưa rõ ngày cập nhật'}</div>`}</li>`).join('')
    return section(this.title, `${stale(s, v.now)}<div class="listing-body"><ul class="listing-apps">${items}</ul></div>`, `Play US, tiếng Anh, ${ago(s.dataAt, v.now)}`, 'listing', o)
  },
}
