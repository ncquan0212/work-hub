// Server-rendered SVG line chart (no script: the hover layer is one transparent band per day carrying a
// native <title> tooltip). Spec from the dataviz skill: one y-axis, 2px lines, recessive hairline grid,
// end value labelled on the main series only, a legend for 2+ series, text in ink colours not series
// colours. Colours are the CSS tokens --c-raw / --c-ma7 / --c-ma28 (src/core/style.ts, light + night).
import { esc } from '../core/html.ts'

export type Series = { label: string; cls: 'raw' | 's1' | 's2'; values: (number | null)[] }
export type Marker = { day: string; label: string }

const W = 600, H = 200, L = 44, R = 46, T = 10, B = 26

function niceStep(range: number, ticks: number) {
  const raw = range / ticks, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p
}

const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`

/** The y range on nice steps, or null with nothing to draw. */
function yScale(series: Series[], ticks: number) {
  const all = series.flatMap(s => s.values).filter((v): v is number => v != null && Number.isFinite(v))
  if (!all.length) return null
  let lo = Math.min(...all), hi = Math.max(...all)
  if (lo >= 0 && lo < hi * 0.5) lo = 0 // anchor at zero unless the data lives far from it
  if (hi === lo) { hi = hi === 0 ? 1 : hi * 1.1; lo = lo === 0 ? 0 : lo * 0.9 }
  const step = niceStep(hi - lo, ticks)
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step }
}

const pathOf = (vals: (number | null)[], x: (i: number) => number, y: (v: number) => number) => {
  let d = '', pen = false
  vals.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) { pen = false; return }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true
  })
  return d
}

export function lineChart(o: { days: string[]; series: Series[]; fmt: (v: number) => string; axisFmt?: (v: number) => string; markers?: Marker[]; title: string }) {
  const { days, series, fmt } = o
  const axisFmt = o.axisFmt ?? fmt
  const sc = yScale(series, 4)
  if (days.length < 2 || !sc) return `<p class="muted">Chưa đủ số liệu để vẽ.</p>`
  const { lo, hi, step } = sc
  const x = (i: number) => L + (i * (W - L - R)) / (days.length - 1)
  const y = (v: number) => T + (H - T - B) * (1 - (v - lo) / (hi - lo))

  const grid: string[] = []
  for (let v = lo; v <= hi + step / 2; v += step) {
    grid.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${esc(axisFmt(v))}</text>`)
  }
  const xl = [0, Math.floor((days.length - 1) / 2), days.length - 1]
    .map(i => `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}">${esc(ddmm(days[i]))}</text>`)

  const lines = series.map(s => `<path class="${s.cls}" d="${pathOf(s.values, x, y)}"/>`).join('')

  // end label on the main series (the first 's1'), or the raw series if it is alone
  const main = series.find(s => s.cls === 's1') ?? series[0]
  const li = main.values.findLastIndex(v => v != null)
  const end = li >= 0 ? `<circle class="dot" cx="${x(li).toFixed(1)}" cy="${y(main.values[li]!).toFixed(1)}" r="4"/><text class="val" x="${(x(li) + 7).toFixed(1)}" y="${(y(main.values[li]!) + 3).toFixed(1)}">${esc(fmt(main.values[li]!))}</text>` : ''

  // event rug along the bottom of the plot (RC publish, release, A/B start)
  const idx = new Map(days.map((d, i) => [d, i]))
  const rug = (o.markers ?? []).filter(m => idx.has(m.day)).map(m => {
    const mx = x(idx.get(m.day)!).toFixed(1)
    return `<g><title>${esc(ddmm(m.day))}: ${esc(m.label)}</title><line class="rug" x1="${mx}" x2="${mx}" y1="${H - B}" y2="${H - B - 7}"/></g>`
  }).join('')

  // hover: one band per day, native tooltip listing every series
  const band = (W - L - R) / Math.max(1, days.length - 1)
  const hits = days.map((d, i) => {
    const vals = series.map(s => `${s.label}: ${s.values[i] == null ? '—' : fmt(s.values[i]!)}`).join(' · ')
    return `<rect class="hit" x="${(x(i) - band / 2).toFixed(1)}" y="${T}" width="${band.toFixed(1)}" height="${H - T - B}"><title>${esc(ddmm(d))} — ${esc(vals)}</title></rect>`
  }).join('')

  const legend = series.length > 1 ? `<div class="legend">${series.map(s => `<span><i class="${s.cls}"></i>${esc(s.label)}</span>`).join('')}</div>` : ''
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title)}">${grid.join('')}${xl.join('')}${lines}${rug}${end}${hits}</svg>${legend}`
}

/** The full-screen chart (Report's zoom page). The plot stretches to whatever box CSS gives it (preserveAspectRatio
 *  none, strokes that do not scale) and the labels are HTML placed in %, so they keep their size on a phone held
 *  either way and on a 2560px screen. Same marks as lineChart, plus a tick about every tenth of the range. */
export function bigChart(o: { days: string[]; series: Series[]; fmt: (v: number) => string; axisFmt?: (v: number) => string; markers?: Marker[]; title: string }) {
  const { days, series, fmt } = o, n = days.length
  const sc = yScale(series, 5)
  if (n < 2 || !sc) return `<p class="muted">Chưa đủ số liệu để vẽ.</p>`
  const { lo, hi, step } = sc
  // 0..100 both ways: % for the HTML, ×10 for the 1000-unit SVG
  const px = (i: number) => (i * 100) / (n - 1), py = (v: number) => (100 * (hi - v)) / (hi - lo)
  const pct = (v: number) => `${v.toFixed(2)}%`
  const ys: string[] = [], grid: string[] = []
  for (let v = lo; v <= hi + step / 2; v += step) {
    ys.push(`<span style="top:${pct(py(v))}">${esc((o.axisFmt ?? fmt)(v))}</span>`)
    grid.push(`<line class="grid" x1="0" x2="1000" y1="${(py(v) * 10).toFixed(1)}" y2="${(py(v) * 10).toFixed(1)}"/>`)
  }
  // ticks back from the last day, so the latest one is always labelled; every other one goes on a narrow screen
  const k = Math.max(1, Math.ceil((n - 1) / 10)), xs: string[] = []
  for (let j = 0, i = n - 1; i >= 0; j++, i -= k) xs.unshift(`<span${j % 2 ? ' class="odd"' : ''} style="left:${pct(px(i))}">${esc(ddmm(days[i]))}</span>`)
  const X = (i: number) => px(i) * 10, Y = (v: number) => py(v) * 10
  const lines = series.map(s => `<path class="${s.cls}" d="${pathOf(s.values, X, Y)}"/>`).join('')
  const idx = new Map(days.map((d, i) => [d, i]))
  // HTML too: a fixed 8px, where a share of the plot would be a stub on a phone held sideways and a post on a PC
  const rug = (o.markers ?? []).filter(m => idx.has(m.day)).map(m => `<i class="bc-rug" style="left:${pct(px(idx.get(m.day)!))}" title="${esc(ddmm(m.day))}: ${esc(m.label)}"></i>`).join('')
  const band = 1000 / (n - 1)
  const hits = days.map((d, i) => `<rect class="hit" x="${(X(i) - band / 2).toFixed(1)}" y="0" width="${band.toFixed(1)}" height="1000"><title>${esc(ddmm(d))} — ${esc(series.map(s => `${s.label}: ${s.values[i] == null ? '—' : fmt(s.values[i]!)}`).join(', '))}</title></rect>`).join('')
  const main = series.find(s => s.cls === 's1') ?? series[0], li = main.values.findLastIndex(v => v != null)
  const dot = li >= 0 ? `<i class="bc-dot" style="left:${pct(px(li))};top:${pct(py(main.values[li]!))}"></i>` : ''
  const end = li >= 0 ? `<span style="top:${pct(py(main.values[li]!))}">${esc(fmt(main.values[li]!))}</span>` : ''
  return `<div class="bigchart" role="img" aria-label="${esc(o.title)}"><div class="bc-y">${ys.join('')}</div>`
    + `<div class="bc-plot"><svg viewBox="0 0 1000 1000" preserveAspectRatio="none">${grid.join('')}${lines}${hits}</svg>${rug}${dot}</div>`
    + `<div class="bc-end">${end}</div><div class="bc-x">${xs.join('')}</div></div>`
}

/** A sparkline for a tile: the daily values faint, the moving average in the accent over a soft area.
 *  No axes, no grid, no labels (the figure beside it carries the number); the title is the accessible name. */
export function sparkline(values: (number | null)[], avg: (number | null)[], title: string) {
  const all = [...values, ...avg].filter((v): v is number => v != null && Number.isFinite(v))
  // under a week of points a sparkline draws noise (a cliff, a lone spike): show nothing instead
  if (values.filter(v => v != null && Number.isFinite(v)).length < 7) return ''
  const w = 200, h = 40, pad = 3
  let lo = Math.min(...all), hi = Math.max(...all)
  if (hi === lo) { hi += 1; lo -= 1 }
  const x = (i: number) => (i * w) / (values.length - 1)
  const y = (v: number) => pad + (h - 2 * pad) * (1 - (v - lo) / (hi - lo))
  const path = (vals: (number | null)[]) => pathOf(vals, x, y)
  const pts = avg.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null && Number.isFinite(p[1]))
  const area = pts.length >= 7 ? `<path class="area" d="M${x(pts[0][0]).toFixed(1)},${h}${pts.map(([i, v]) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}L${x(pts.at(-1)![0]).toFixed(1)},${h}Z"/>` : ''
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(title)}">${area}<path class="raw" d="${path(values)}"/><path class="s1" d="${path(avg)}"/></svg>`
}

export type XYSeries = { label: string; short?: string; cls: string; pts: (number | null)[] }

/** A chart over a numeric x (hours as UTC ms, days since install) for series that are groups (an A/B test's arms) rather
 *  than a raw line and its averages. Built like bigChart: the plot stretches to the box the caller's CSS gives `cls`
 *  (non-scaling strokes), labels are HTML placed in %, so text keeps its size on a phone and on a wide screen. One y
 *  axis, every series named at its end (`short`, pushed apart when they would touch) and in a legend, vertical marks
 *  for moments (a run's start), a hover band per x value whose native tooltip lists every series. Series colours are
 *  the caller's classes (`cls` per series), styled in the caller's module CSS. */
export function xyChart(o: { xs: number[]; series: XYSeries[]; fmt: (v: number) => string; axisFmt?: (v: number) => string; xLabel: (x: number) => string;
  xTicks: number[]; tickLabel?: (x: number) => string; marks?: { x: number; label: string }[]; title: string; cls: string }) {
  const { xs, series, fmt } = o
  const sc = yScale(series.map(s => ({ label: s.label, cls: 'raw' as const, values: s.pts })), 4)
  if (xs.length < 2 || !sc) return `<p class="muted">Chưa đủ số liệu để vẽ.</p>`
  const { lo, hi, step } = sc, x0 = xs[0], x1 = xs.at(-1)!
  const px = (v: number) => ((v - x0) * 100) / (x1 - x0), py = (v: number) => (100 * (hi - v)) / (hi - lo)
  const pct = (v: number) => `${v.toFixed(2)}%`
  const ys: string[] = [], grid: string[] = []
  for (let v = lo; v <= hi + step / 2; v += step) {
    ys.push(`<span style="top:${pct(py(v))}">${esc((o.axisFmt ?? fmt)(v))}</span>`)
    grid.push(`<line class="grid" x1="0" x2="1000" y1="${(py(v) * 10).toFixed(1)}" y2="${(py(v) * 10).toFixed(1)}"/>`)
  }
  const ticks = o.xTicks.filter(t => t >= x0 && t <= x1).map((t, j) => `<span${j % 2 ? ' class="odd"' : ''} style="left:${pct(px(t))}">${esc((o.tickLabel ?? o.xLabel)(t))}</span>`)
  const X = (i: number) => px(xs[i]) * 10, Y = (v: number) => py(v) * 10
  const lines = series.map(s => `<path class="${esc(s.cls)}" d="${pathOf(s.pts, X, Y)}"/>`).join('')
  const marks = (o.marks ?? []).filter(m => m.x >= x0 && m.x <= x1)
  const markLines = marks.map(m => `<line class="mark" x1="${(px(m.x) * 10).toFixed(1)}" x2="${(px(m.x) * 10).toFixed(1)}" y1="0" y2="1000"/>`).join('')
  const markText = marks.map(m => `<span class="xy-mark${px(m.x) > 60 ? ' right' : ''}" style="left:${pct(px(m.x))}">${esc(m.label)}</span>`).join('')
  // end labels: at least 7% of the height apart (about 14px in a 200px box)
  const ends = series.map(s => { const i = s.pts.findLastIndex(v => v != null); return i < 0 ? null : { s, i, y: py(s.pts[i]!) } })
    .filter((e): e is NonNullable<typeof e> => !!e).sort((a, b) => a.y - b.y)
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 7) ends[k].y = ends[k - 1].y + 7
  const dots = ends.map(e => `<i class="bc-dot ${esc(e.s.cls)}" style="left:${pct(px(xs[e.i]))};top:${pct(py(e.s.pts[e.i]!))}"></i>`).join('')
  const endText = ends.map(e => `<span style="top:${pct(e.y)}">${esc(e.s.short ?? e.s.label)} ${esc(fmt(e.s.pts[e.i]!))}</span>`).join('')
  const hits = xs.map((v, i) => {
    const a = i ? (X(i - 1) + X(i)) / 2 : 0, b = i < xs.length - 1 ? (X(i) + X(i + 1)) / 2 : 1000
    return `<rect class="hit" x="${a.toFixed(1)}" y="0" width="${Math.max(0.5, b - a).toFixed(1)}" height="1000"><title>${esc(o.xLabel(v))}: ${esc(series.map(s => `${s.label} ${s.pts[i] == null ? '—' : fmt(s.pts[i]!)}`).join(', '))}</title></rect>`
  }).join('')
  const legend = series.length > 1 ? `<div class="legend">${series.map(s => `<span><i class="${esc(s.cls)}"></i>${esc(s.label)}</span>`).join('')}</div>` : ''
  return `<div class="${esc(o.cls)}"><div class="bigchart" role="img" aria-label="${esc(o.title)}"><div class="bc-y">${ys.join('')}</div>`
    + `<div class="bc-plot"><svg viewBox="0 0 1000 1000" preserveAspectRatio="none">${grid.join('')}${markLines}${lines}${hits}</svg>${markText}${dots}</div>`
    + `<div class="bc-end">${endText}</div><div class="bc-x">${ticks.join('')}</div></div></div>${legend}`
}
