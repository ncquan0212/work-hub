// Theo dõi bản 2 pages: a card per running comparison, suggestions to confirm, a 30-day timeline per app, the run
// page (new users by hour, each metric's lift with its 95% interval, retention and ad LTV curves, the full table), and
// the run form. Everything from a source (RC labels, condition names, notes) goes through esc().
import type { DatabaseSync } from 'node:sqlite'
import { APPS, PROFILE_LABELS } from '../../config.ts'
import { ago, board, boardHead, cut, empty, esc, pill, section } from '../../core/html.ts'
import type { Slot, View } from '../../core/types.ts'
import { addDays } from '../../lib/days.ts'
import { chiSquare } from '../../lib/stats.ts'
import { xyChart } from '../../lib/svg.ts'
import type { GroupFacts } from './compare.ts'
import {
  DEFAULT_APP,
  ARM_RE, DAY, DEFAULT_HORIZON, DEFAULT_METRIC, HEADLINE, HOUR, METRICS, armSize, armValue, compareArms, decideDay, metricsFor, primaryOf, rcEvents,
  shownCall, vnInput, vnTime, type Call, type Lift, type Run, type RunMetric,
} from './runs.ts'
import { SOURCE, getState, listRuns, playSteps, rcMatch, rcSums, releases, runFacts, runHours } from './store.ts'

const vi = (x: number, d: number) => x.toLocaleString('vi-VN', { maximumFractionDigits: d, minimumFractionDigits: d })
const n0 = (x: number) => Math.round(x).toLocaleString('vi-VN')
const appName = (k: string) => APPS.find(a => a.key === k)?.name ?? k
const csrf = (v: View) => `<input type="hidden" name="_csrf" value="${esc(v.csrf)}">`
const KIND: Record<string, string> = { version: 'Version', ab: 'A/B' }
const STATUS: Record<string, string> = { suggested: 'Gợi ý', active: 'Đang chạy', ended: 'Đã dừng', dismissed: 'Đã bỏ' }
const vnDay = (t: number) => { const s = new Date(t + 7 * HOUR).toISOString(); return `${s.slice(8, 10)}/${s.slice(5, 7)}` }
const days = (r: Run, now: number) => Math.max(0, ((r.end_at ?? now) - r.start_at) / DAY)

export function fmtM(m: Pick<RunMetric, 'unit'>, v: number | null) {
  if (v == null || !Number.isFinite(v)) return '—'
  return m.unit === 'pct' ? `${vi(v * 100, v < 0.1 ? 2 : 1)}%` : m.unit === 'usd' ? `$${vi(v, v < 1 ? 4 : 2)}` : vi(v, 2)
}
const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${vi(Math.abs(x * 100), 1)}%`
const liftHtml = (l: Lift | null, c: Call) => !l ? '<span class="muted">—</span>'
  : `<span class="delta ${c.tone === 'ok' ? 'ok-t' : c.tone === 'bad' ? 'bad-t' : 'muted'}">${l.lift > 0 ? '▲' : l.lift < 0 ? '▼' : ''}${vi(Math.abs(l.lift * 100), 1)}%</span>`
const ciText = (l: Lift | null) => l?.lo != null && l.hi != null ? `${signed(l.lo)} đến ${signed(l.hi)}` : ''
const callHtml = (c: Call) => c.tone === 'mute' ? `<span class="muted">${esc(c.word)}</span>` : pill(c.tone, c.word)

// ───────────── one run's numbers ─────────────

type Cmp = { m: RunMetric; arm: string; a: ReturnType<typeof armValue>; b: ReturnType<typeof armValue>; l: Lift | null; c: Call }
export function runStats(db: DatabaseSync, r: Run) {
  const g = runFacts(db, r.id), sizes = r.arms.map(a => armSize(g.get(a))), total = sizes.reduce((s, x) => s + x, 0)
  const srm = sizes.length >= 2 && sizes.every(s => s >= 100) ? chiSquare(sizes, r.weights) : null
  const cmps: Cmp[] = [], pid = primaryOf(r).id, dec = r.decided_at ? r.decision?.split(',') : undefined
  if (r.pulled_to && r.arms.length >= 2) for (const m of metricsFor(r.app)) {
    for (const [i, arm] of r.arms.slice(1).entries()) {
      const x = compareArms(g.get(r.arms[0]), g.get(arm), m, r.pulled_to)
      if (x.a.den || x.b.den || m.src === 'day') cmps.push({ m, arm, ...x, c: shownCall(x.c, m.id === pid, dec?.[i]) })
    }
  }
  // version runs: a 100% rollout leaves one arm without new users, and the comparison becomes before/after
  const parallel = !(r.kind === 'version' && total >= 100 && Math.min(...sizes) < 0.02 * total)
  return { g, sizes, total, srm, cmps, parallel }
}

/** New installs per arm as one bar, the expected split as a tick, the numbers in words below. */
function split(r: Run, sizes: number[]) {
  const total = sizes.reduce((s, x) => s + x, 0), wsum = r.weights.reduce((s, x) => s + x, 0)
  if (!total) return '<p class="muted track-sub">Chưa có user mới trong nhóm.</p>'
  const share = sizes.map(s => s / total)
  let acc = 0
  const ticks = r.weights.slice(0, -1).map(w => { acc += w / wsum; return `<i class="track-exp" style="left:${(acc * 100).toFixed(2)}%"></i>` }).join('')
  const label = r.arms.map((a, i) => `${a} ${vi(share[i] * 100, 1)}%`).join(', ')
  return `<div class="track-split" role="img" aria-label="${esc(`User mới: ${label}. Kỳ vọng ${r.weights.join(':')}`)}">${share.map((s, i) => `<span class="t${i ? 'b' : 'a'}" style="width:${(s * 100).toFixed(2)}%"></span>`).join('')}${ticks}</div>
    <div class="legend track-legend">${r.arms.map((a, i) => `<span><i class="t${i ? 'b' : 'a'}"></i>${i ? 'B' : 'A'} <span class="tag">${esc(a)}</span> ${esc(vi(share[i] * 100, 1))}% <span class="muted">(${esc(n0(sizes[i]))})</span></span>`).join('')}<span class="muted">vạch: kỳ vọng ${esc(r.weights.join(':'))}</span></div>`
}

function srmLine(r: Run, st: ReturnType<typeof runStats>) {
  const w = esc(r.weights.join(':'))
  if (!st.srm) return `<p class="track-srm">${pill('mute', 'Chưa đủ số')}<span>Cần từ 100 user mới mỗi nhánh để kiểm tỉ lệ chia.</span></p>`
  return st.srm.p < 0.001
    ? `<p class="track-srm">${pill('bad', 'SRM')}<span>Tỉ lệ chia lệch so với ${w} (χ² = ${esc(vi(st.srm.chi2, 1))}, p = ${esc(st.srm.p.toExponential(1))}). Kết quả chưa đáng tin cho tới khi rõ nguyên nhân.</span></p>`
    : `<p class="track-srm">${pill('ok', 'Chia đúng')}<span>Khớp tỉ lệ ${w} (p = ${esc(vi(st.srm.p, 2))}).</span></p>`
}
const notParallel = '<p class="track-srm">' + pill('warn', 'So trước/sau') + '<span>Một nhánh gần như không có user mới trong khoảng này (rollout 100%?). Hai nhóm không cùng thời điểm, nên chênh lệch lẫn cả yếu tố thời gian.</span></p>'

function freshness(r: Run, now: number) {
  if (r.error) return `<p class="track-sub warn-t">Lần làm mới ${esc(ago(r.refreshed_at, now))} lỗi: ${esc(cut(r.error, 160))}</p>`
  if (!r.pulled_to) return `<p class="track-sub muted">Chưa có số nhóm user: hub làm mới trong vòng 30 phút sau khi xác nhận, rồi mỗi 6 giờ.</p>`
  return `<p class="track-sub muted">Số đến hết ngày ${esc(r.pulled_to.slice(8, 10))}/${esc(r.pulled_to.slice(5, 7))} (UTC), làm mới ${esc(ago(r.refreshed_at, now))}.</p>`
}

/** When the run concludes (once, on the primary metric), or that it did. */
function decisionLine(r: Run) {
  if (r.arms.length < 2 || r.status === 'suggested' || r.status === 'dismissed') return ''
  const m = primaryOf(r)
  if (r.decided_at) return `<p class="track-sub">Đã kết luận ngày ${esc(vnDay(r.decided_at))} ở ${esc(m.label)}, sau ${r.horizon} ngày cài. Số vẫn cập nhật, kết luận giữ nguyên.</p>`
  return `<p class="track-sub muted">Kết luận một lần, từ ngày ${esc(vnDay(Date.parse(`${decideDay(r, m)}T00:00:00Z`) + DAY))}: sau ${r.horizon} ngày cài và khi ${esc(m.label)} đủ tuổi. Trước đó kết quả chỉ là tạm thời.</p>`
}

// ───────────── board ─────────────

function card(v: View, r: Run) {
  const st = runStats(v.db, r), want = HEADLINE[r.app] ?? ['d1', 'ltv3', 'ads']
  const ids = [r.metric ?? DEFAULT_METRIC, ...want.filter(x => x !== (r.metric ?? DEFAULT_METRIC))].slice(0, 4)
  const rows = ids.map(id => st.cmps.find(x => x.m.id === id && x.arm === r.arms[1])).filter((x): x is Cmp => !!x).map(x =>
    `<li><span class="track-ml">${esc(x.m.label)}${x.m.id === (r.metric ?? DEFAULT_METRIC) ? ' <span class="muted">(chính)</span>' : ''}</span><span class="track-mv">${liftHtml(x.l, x.c)}<span class="track-ci">${esc(ciText(x.l))}</span></span><span class="track-mc">${callHtml(x.c)}</span></li>`).join('')
  const body = `<div class="row"><span class="pill info">${esc(KIND[r.kind])}</span><span class="track-sub">A <span class="tag">${esc(r.arms[0] ?? '?')}</span> B <span class="tag">${esc(r.arms[1] ?? '?')}</span>${r.arms.length > 2 ? ` +${r.arms.length - 2}` : ''}</span></div>
    <p class="track-sub">Từ ${esc(vnTime(r.start_at))}${r.end_at ? ` đến ${esc(vnTime(r.end_at))}` : ''} giờ VN, ${esc(vi(days(r, v.now), 1))} ngày</p>
    ${split(r, st.sizes)}${st.parallel ? srmLine(r, st) : notParallel}
    ${rows ? `<ul class="track-metrics">${rows}</ul>` : ''}${decisionLine(r)}${freshness(r, v.now)}`
  return section(r.name, body, appName(r.app), `run-${r.id}`, { cls: 'track-card', act: `<a href="/track/run/${r.id}">Xem đợt</a>` })
}

function suggestionList(v: View, rs: Run[]) {
  if (!rs.length) return ''
  const li = rs.map(r => {
    const arms = r.arms.length >= 2 ? r.arms.map((a, i) => `${i ? 'B' : 'A'} <span class="tag">${esc(a)}</span>`).join(' ') : '<span class="muted">chờ số theo giờ để biết hai version</span>'
    const alt = r.alt_at && Math.abs(r.alt_at - r.start_at) >= HOUR ? `<span>Theo dữ liệu: hai nhánh ổn định từ <b>${esc(vnTime(r.alt_at))}</b></span>` : r.alt_at ? '<span>Dữ liệu khớp giờ này</span>' : ''
    const can = r.arms.length >= 2
    return `<li><div class="row"><b><a href="/track/run/${r.id}">${esc(r.name)}</a></b>${pill('mute', SOURCE[r.source] ?? r.source)}</div>
      <div class="row sub">${arms}</div>
      <div class="row sub"><span>Bắt đầu ${esc(vnTime(r.start_at))} giờ VN</span><span>kỳ vọng ${esc(r.weights.join(':'))}</span>${alt}${r.end_at ? `<span>dừng ${esc(vnTime(r.end_at))}</span>` : ''}</div>
      ${r.note ? `<p class="sub muted">${esc(cut(r.note, 220))}</p>` : ''}
      <div class="inline track-acts">${can ? `<form method="post" action="/track/run/${r.id}/confirm">${csrf(v)}<button type="submit" class="ghost">Xác nhận</button></form>` : ''}
        ${can && r.alt_at && Math.abs(r.alt_at - r.start_at) >= HOUR ? `<form method="post" action="/track/run/${r.id}/confirm">${csrf(v)}<input type="hidden" name="at" value="alt"><button type="submit" class="ghost">Dùng giờ dữ liệu</button></form>` : ''}
        <a class="track-btn" href="/track/run/${r.id}/edit">Sửa</a>
        <form method="post" action="/track/run/${r.id}/dismiss">${csrf(v)}<button type="submit" class="ghost danger">Bỏ</button></form></div></li>`
  }).join('')
  return section('Gợi ý đợt so sánh', `<ul class="list track-sugg">${li}</ul>`, 'hub tìm từ lịch sử RC, số liệu và Play Console; bấm xác nhận hoặc sửa', 'goi-y', { span: 2, cls: 'track-suggest' })
}

type Mark = { at: number; cls: string; text: string }
/** 30 days per app on one shared axis: markers for versions, RC labels, A/B start and end, Play rollouts; runs as bars. */
export function timeline(v: View) {
  const to = v.now, from = to - 30 * DAY, pos = (t: number) => `${(((Math.max(from, Math.min(to, t)) - from) / (to - from)) * 100).toFixed(2)}%`
  const rel = releases(v.db, v.now), runs = listRuns(v.db)
  const all: (Mark & { app: string })[] = []
  const rows = APPS.map(a => {
    const marks: Mark[] = []
    for (const e of rcEvents(rcSums(v.db, a.key))) {
      if (e.at < from) continue
      if (e.type === 'label') marks.push({ at: e.at, cls: 'lbl', text: `Nhãn RC ${e.label}` })
      else if (e.type === 'ab_start') marks.push({ at: e.at, cls: 'ab', text: `${e.exp!.id} bắt đầu (${e.exp!.arms.join('/')})` })
      else if (e.type === 'ab_end') marks.push({ at: e.at, cls: 'abend', text: `${e.exp!.id} dừng` })
      else if (e.type === 'ab_arms') marks.push({ at: e.at, cls: 'ab', text: `${e.exp!.id} đổi nhánh ${e.from} → ${e.exp!.arms.join('/')}` })
    }
    for (const r of rel.filter(x => x.app === a.key)) { const t = Date.parse(`${r.day}T12:00:00Z`); if (t >= from) marks.push({ at: t, cls: 'ver', text: `Version ${r.version} có từ 1% user mới (ngày ${r.day.slice(8, 10)}/${r.day.slice(5, 7)})` }) }
    for (const s of playSteps(v.db, a.key)) if (s.at && s.at >= from) marks.push({ at: s.at, cls: 'roll', text: `Play: ${s.version} lên ${s.pct}%` })
    all.push(...marks.map(m => ({ ...m, app: a.key })))
    // runs as bars, stacked into lanes when they overlap
    const lanes: number[] = [], bars = runs.filter(r => r.app === a.key && (r.end_at ?? to) > from).sort((x, y) => x.start_at - y.start_at).map(r => {
      const end = r.end_at ?? to
      let lane = lanes.findIndex(e => e <= r.start_at); if (lane < 0) { lane = lanes.length; lanes.push(0) }
      lanes[lane] = end
      const w = ((Math.min(end, to) - Math.max(r.start_at, from)) / (to - from)) * 100
      return `<a class="track-bar s-${esc(r.status)}" href="/track/run/${r.id}" style="left:${pos(r.start_at)};width:${Math.max(0.8, w).toFixed(2)}%;top:calc(${lane} * var(--track-lane))" title="${esc(`${r.name}: ${STATUS[r.status]}, từ ${vnTime(r.start_at)}`)}"><span>${esc(r.name)}</span></a>`
    })
    const m = marks.map(x => `<i class="track-mk ${x.cls}" style="left:${pos(x.at)}" title="${esc(`${vnTime(x.at)}: ${x.text}`)}"></i>`).join('')
    return `<div class="track-tl-row"><div class="track-tl-name">${esc(a.name)}</div><div class="track-tl-lane"><div class="track-tl-marks">${m}</div><div class="track-tl-bars" style="height:calc(${Math.max(1, lanes.length)} * var(--track-lane))">${bars.join('')}</div></div></div>`
  }).join('')
  const ticks = [28, 21, 14, 7, 0].map((d, i) => `<span class="${i % 2 ? 'odd' : ''}${d ? '' : ' end'}" style="left:${pos(to - d * DAY)}">${esc(vnDay(to - d * DAY))}</span>`).join('')
  const legend = `<div class="legend track-tl-legend"><span><i class="track-mk ver"></i>version mới</span><span><i class="track-mk roll"></i>rollout Play</span><span><i class="track-mk lbl"></i>đổi nhãn RC</span><span><i class="track-mk ab"></i>A/B bắt đầu, đổi nhánh</span><span><i class="track-mk abend"></i>A/B dừng</span><span><i class="track-bar-key s-active"></i>đợt so sánh</span><span><i class="track-bar-key s-suggested"></i>gợi ý</span></div>`
  const recent = all.sort((x, y) => y.at - x.at).slice(0, 14).map(x => `<li><span class="muted">${esc(vnTime(x.at))}</span> <b>${esc(appName(x.app))}</b> ${esc(x.text)}</li>`).join('')
  const ps = getState(v.db, 'play')
  // no `falcon` Chrome profile in this copy: T3 is off, no line about it
  const play = !PROFILE_LABELS.falcon ? '' : !ps || (!ps.info && !ps.error) ? `Play Console: chưa đọc lần nào (mỗi ngày sau 08:30, qua ${PROFILE_LABELS.falcon}).`
    : ps.error ? `Play Console: ${cut(ps.error, 140)}.` : `Play Console: đọc ${ago(ps.at, v.now)}.`
  return section('30 ngày qua', `<div class="track-tl"><div class="track-tl-axis">${ticks}</div>${rows}</div>${legend}
    ${recent ? `<details class="track-recent"><summary>Các mốc gần đây</summary><ul>${recent}</ul></details>` : ''}${play ? `<p class="track-sub muted">${esc(play)}</p>` : ''}`,
    'giờ VN', 'dong-thoi-gian', { span: 'all', cls: 'track-timeline' })
}

export const METHOD = `<ol class="track-how">
<li><b>Nhóm user.</b> Chỉ user mới cài trong khoảng thời gian của đợt. Đợt version chia theo version lúc mở app lần đầu (<code>first_open</code>). Đợt A/B chia theo nhãn <code>experiment_group</code> user mang trong ngày cài: Firebase chỉ gán nhánh sau khi app tải RC, nên <code>first_open</code> thường còn nhãn mặc định (kiểm 09/11: chỉ khoảng 9% user của nhánh có nhãn nhánh ở <code>first_open</code>).</li>
<li><b>Giữ nguyên từ lúc cài.</b> Mọi chỉ số tính trên đúng những user đó, kể cả khi sau này họ lên version khác hay đổi nhãn. Hai nhánh cùng thời điểm, nên ngày trong tuần, nguồn quảng cáo hay mùa vụ tác động như nhau lên cả hai.</li>
<li><b>Chia đúng hay lệch (SRM).</b> Số user mỗi nhánh so với tỉ lệ kỳ vọng bằng kiểm định χ². p &lt; 0,001 là chia lệch: kết quả chưa đáng tin.</li>
<li><b>Mức chênh.</b> B so với A, tính bằng %. Chỉ số tỉ lệ (retention, onboarding…): khoảng tin cậy 95% của tỉ số hai tỉ lệ (khoảng log, Katz). Chỉ số trung bình (LTV ads, ads mỗi user): số gộp không có độ lệch của từng user, nên hub coi mỗi ngày cài là một lần đo trên cả hai nhánh, và tính khoảng 95% từ độ dao động của tỉ số B/A giữa các ngày (cần 4 ngày cài, mỗi ngày có từ 5% user của nhánh hoặc 100 user; ngày chỉ có vài user vẫn tính vào số gộp). VideoRate chỉ có số gộp nên không có khoảng.</li>
<li><b>Kết luận một lần, vào ngày định trước.</b> Mỗi đợt có số ngày trước khi kết luận (mặc định 7 ngày cài). Hub chờ đủ số ngày cài đó, rồi chờ chỉ số chính đủ tuổi (Retention D1 cần ngày cài cuối đã qua 2 ngày), rồi kết luận đúng một lần: B tốt hơn (cả khoảng 95% trên 0), B kém hơn (cả khoảng dưới 0), hoặc chưa thấy khác biệt. Hub báo kết luận đó một lần, kể cả khi chưa thấy khác biệt.</li>
<li><b>Vì sao không kết luận sớm.</b> Số dao động theo từng ngày. Nếu cứ 6 giờ xem một lần và kết luận ngay khi khoảng vừa nằm hẳn một phía, thì cả khi hai nhánh y hệt nhau cũng có khoảng 1/4 số đợt bị báo nhầm là khác nhau. Nên trước ngày kết luận, kết quả chỉ ghi "tạm thời" và không báo. Sau ngày đó số vẫn cập nhật, nhưng kết luận giữ nguyên.</li>
<li><b>Chỉ chỉ số chính được kết luận.</b> Các chỉ số khác chỉ để tham khảo: so nhiều chỉ số một lúc thì thế nào cũng có vài chỉ số trông như khác nhau chỉ do may rủi. Mẫu nhỏ (dưới 100 user một nhánh; với chỉ số tỉ lệ, dưới 10 user có hay không có sự kiện) thì không kết luận.</li>
<li><b>Đủ tuổi.</b> Retention Dn và LTV Dn chỉ tính ngày cài đã qua đủ n ngày, thêm 1 ngày dự phòng vì <code>retention_day</code> theo giờ của máy user.</li>
<li><b>Cập nhật.</b> Số làm mới mỗi 6 giờ. Nhóm user tính đến hết ngày UTC hôm qua (7 giờ sáng giờ VN), tối đa 28 ngày cài.</li></ol>`

export function boardPanel(s: Slot | undefined, v: View) {
  const runs = listRuns(v.db), active = runs.filter(r => r.status === 'active'), sugg = runs.filter(r => r.status === 'suggested')
  const ended = runs.filter(r => r.status === 'ended').slice(0, 8)
  const err = s && !s.ok && s.at ? `<p class="track-srm span-all">${pill('warn', 'Lỗi')}<span>Lần chạy ${esc(ago(s.at, v.now))} lỗi: ${esc(cut(s.error, 200))}. Số bên dưới là số đã lưu.</span></p>` : ''
  const head = boardHead('Đợt so sánh đang chạy', 'Mỗi đợt so user mới cài cùng thời điểm, chia theo nhánh lúc cài. Kết luận một lần ở chỉ số chính, sau số ngày đã định.',
    '<a href="/track/run/new">Ghi đợt mới</a>')
  const cards = active.length ? active.map(r => card(v, r)).join('')
    : section('Chưa có đợt nào đang chạy', empty('Xác nhận một gợi ý bên dưới, hoặc ghi đợt mới.'), '', '', { cls: 'track-card' })
  const past = `<ul class="list">${ended.map(r => `<li><div class="row"><a href="/track/run/${r.id}"><b>${esc(r.name)}</b></a></div><div class="row sub"><span>${esc(appName(r.app))}</span><span>${esc(vnTime(r.start_at))} đến ${esc(r.end_at ? vnTime(r.end_at) : '—')}</span></div></li>`).join('')}</ul>`
  const tools = section('Khác', `${ended.length ? `<h3>Đợt đã dừng</h3>${past}` : ''}<ul class="list"><li><a href="/track/version">So hai version tự chọn theo ngày cài (D0, số theo ngày)</a></li><li><a href="/track/run/new">Ghi một đợt so sánh</a></li></ul>
    <details class="track-method"><summary>Cách so một đợt</summary>${METHOD}</details>`, '', 'khac', { cls: 'track-other' })
  return head + err + cards + suggestionList(v, sugg) + timeline(v) + tools
}

// ───────────── run page ─────────────

/** Lift and its 95% interval per metric, on one axis around 0 (symmetric, at least ±5%, at most ±100%). */
function forest(all: Cmp[]) {
  let cmps = all
  const wait = cmps.filter(x => !x.l).map(x => x.m.label)
  cmps = cmps.filter(x => x.l)
  if (!cmps.length) return empty(wait.length ? `Chưa có chỉ số nào đủ số: ${wait.join(', ')}.` : 'Chưa có số.')
  // the axis follows the metrics with enough users; a small sample's wide interval runs off the edge
  const ext = Math.min(1, Math.max(0.05, ...cmps.filter(x => x.c.word !== 'Mẫu nhỏ').flatMap(x => [Math.abs(x.l!.lift), Math.abs(x.l!.lo ?? 0), Math.abs(x.l!.hi ?? 0)])))
  const D = [0.05, 0.1, 0.2, 0.3, 0.5, 1].find(d => d >= ext) ?? 1
  const at = (x: number) => `${(((Math.max(-D, Math.min(D, x)) + D) / (2 * D)) * 100).toFixed(2)}%`
  const li = cmps.map(x => {
    const l = x.l, tone = x.c.tone === 'ok' ? 'ok' : x.c.tone === 'bad' ? 'bad' : 'mute'
    const bar = l?.lo != null && l.hi != null ? `<b class="track-fci ${tone}" style="left:${at(l.lo)};width:calc(${at(l.hi)} - ${at(l.lo)})"></b>` : ''
    const pt = l ? `<i class="track-fpt ${tone}${Math.abs(l.lift) > D ? ' out' : ''}" style="left:${at(l.lift)}"></i>` : ''
    return `<li><span class="track-fl">${esc(x.m.label)}</span><span class="track-fx" role="img" aria-label="${esc(`${x.m.label}: ${l ? signed(l.lift) : 'chưa có'}${ciText(l) ? `, khoảng 95% ${ciText(l)}` : ''}`)}"><i class="track-f0"></i>${bar}${pt}</span>
      <span class="track-fv">${liftHtml(l, x.c)} <span class="track-ci">${esc(ciText(l) || (l?.how ?? ''))}</span></span></li>`
  }).join('')
  return `<div class="track-forest-axis"><span>${esc(signed(-D))}</span><span>0</span><span>${esc(signed(D))}</span></div><ul class="track-forest">${li}</ul>${wait.length ? `<p class="track-sub muted">Chờ đủ ngày hoặc chưa có số: ${esc(wait.join(', '))}.</p>` : ''}`
}

function hourChart(r: Run, hours: Map<number, Map<string, number>>) {
  // the hour the refresh ran in was still filling: leave it out
  const xs = [...hours.keys()].sort((a, b) => a - b).filter(t => !r.refreshed_at || t + HOUR <= r.refreshed_at)
  if (xs.length < 2) return empty('Chưa có số theo giờ.')
  const arms = r.arms.length ? r.arms : [...new Set([...hours.values()].flatMap(m => [...m.keys()]))]
  const full: number[] = []
  for (let t = xs[0]; t <= xs.at(-1)!; t += HOUR) full.push(t)
  const span = (full.at(-1)! - full[0]) / DAY, step = span > 5 ? 2 : 1
  const first = Math.ceil((full[0] + 7 * HOUR) / DAY) * DAY - 7 * HOUR, ticks: number[] = []
  for (let t = first; t <= full.at(-1)!; t += step * DAY) ticks.push(t)
  const series = arms.slice(0, 6).map((a, i) => ({ label: r.arms.length ? `${i ? 'B' : 'A'} ${a}` : a, short: r.arms.length ? (i ? 'B' : 'A') : a, cls: r.arms.length ? (i ? 'tb' : 'ta') : `t${i}`, pts: full.map(t => hours.get(t)?.get(a) ?? 0) }))
  const marks = [{ x: r.start_at, label: `bắt đầu ${vnTime(r.start_at)}` }, ...(r.alt_at && Math.abs(r.alt_at - r.start_at) >= HOUR ? [{ x: r.alt_at, label: 'ổn định' }] : []), ...(r.end_at ? [{ x: r.end_at, label: 'dừng' }] : [])]
  return xyChart({ xs: full, series, fmt: v => n0(v), xLabel: vnTime, tickLabel: vnDay, xTicks: ticks, marks, title: `User mới mỗi nhánh theo giờ, ${r.name}`, cls: 'track-xy' })
}

function curves(r: Run, g: Map<string, GroupFacts>, kind: 'ret' | 'ltv') {
  if (!r.pulled_to) return empty('Chưa có số.')
  const xs = [0, 1, 2, 3, 4, 5, 6, 7]
  // each arm's curve runs on one set of install days (those old enough for its last point, which must cover a tenth of
  // the arm, as in the table), so cumulative LTV never dips because a later point has fewer, older days
  const m = (d: number): RunMetric => kind === 'ret' ? { id: '', label: '', kind: 'prop', unit: 'pct', src: 'day', num: 'session_start.users', den: 'session_start.users', rd: d }
    : { id: '', label: '', kind: 'mean', unit: 'usd', src: 'day', num: 'ad_revenue.rev', den: 'session_start.users', rd: d, cum: true }
  const series = r.arms.slice(0, 6).map((a, i) => {
    const kmax = xs.filter(d => armValue(g.get(a), m(d), r.pulled_to!).den >= 0.1 * armSize(g.get(a))).at(-1) ?? -1
    return { label: `${i ? 'B' : 'A'} ${a}`, short: i ? 'B' : 'A', cls: i ? 'tb' : 'ta', pts: xs.map(d => d > kmax ? null : armValue(g.get(a), m(d), addDays(r.pulled_to!, d - kmax)).value) }
  })
  if (series.every(s => s.pts.filter(p => p != null).length < 2)) return empty('Chưa đủ ngày cài đủ tuổi để vẽ: D1 cần ngày cài đã qua 2 ngày.')
  const unit = kind === 'ret' ? 'pct' : 'usd'
  return xyChart({ xs, series, fmt: v => fmtM({ unit }, v), axisFmt: v => kind === 'ret' ? `${vi(v * 100, 0)}%` : fmtM({ unit }, v), xLabel: d => `D${d}`, xTicks: xs,
    title: kind === 'ret' ? 'Retention D0 đến D7 mỗi nhánh' : 'LTV ads cộng dồn mỗi nhánh', cls: 'track-xy' })
}

function table(r: Run, st: ReturnType<typeof runStats>) {
  if (!st.cmps.length) return empty('Chưa có số.')
  return r.arms.slice(1).map(arm => {
    const rows = st.cmps.filter(x => x.arm === arm).map(x => { const wait = x.c.word === 'Chờ đủ ngày'; return `<tr><th scope="row">${esc(x.m.label)}</th>
      <td class="num track-a">${esc(wait ? '—' : fmtM(x.m, x.a.value))}<span class="track-n">${wait ? '' : `n=${esc(n0(x.a.den))}${x.a.days.length ? `, ${x.a.days.length} ngày cài` : ''}`}</span></td>
      <td class="num track-b">${esc(wait ? '—' : fmtM(x.m, x.b.value))}<span class="track-n">${wait ? '' : `n=${esc(n0(x.b.den))}`}</span></td>
      <td class="num track-lift">${liftHtml(x.l, x.c)}</td><td class="track-call">${callHtml(x.c)}</td>
      <td class="track-ev">${esc(ciText(x.l) ? `95%: ${ciText(x.l)}` : '')}${x.l?.p != null ? esc(x.l.p < 0.001 ? ', p < 0,001' : `, p = ${vi(x.l.p, 3)}`) : ''}${x.l ? `<span class="track-how">${esc(x.l.how)}</span>` : ''}</td></tr>` }).join('')
    return `${r.arms.length > 2 ? `<h3>${esc(arm)} so với ${esc(r.arms[0])}</h3>` : ''}<div class="track-cmp"><table><thead><tr><th scope="col">Chỉ số</th><th scope="col" class="num">A ${esc(r.arms[0])}</th><th scope="col" class="num">B ${esc(arm)}</th><th scope="col" class="num">B so với A</th><th scope="col">Kết luận</th><th scope="col">Căn cứ</th></tr></thead><tbody>${rows}</tbody></table></div>`
  }).join('')
}

function byDay(r: Run, g: Map<string, GroupFacts>) {
  const ds = [...new Set(r.arms.flatMap(a => [...(g.get(a)?.keys() ?? [])]))].filter(d => d !== '*').sort()
  const rows = ds.map(d => `<tr><th scope="row">${esc(d.slice(8, 10))}/${esc(d.slice(5, 7))}</th>${r.arms.map(a => `<td class="num">${esc(n0(g.get(a)?.get(d)?.get(0)?.get('session_start.users') ?? 0))}</td>`).join('')}</tr>`).join('')
  return rows ? `<details class="track-days"><summary>User mới theo ngày cài (UTC)</summary><div class="scroll"><table><thead><tr><th scope="col">Ngày</th>${r.arms.map((a, i) => `<th scope="col" class="num">${i ? 'B' : 'A'} ${esc(a)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="track-sub muted">Theo ngày UTC của sự kiện; một user cài gần nửa đêm có thể nằm ở hai ngày.</p></details>` : ''
}

export function runPage(v: View, r: Run) {
  const st = runStats(v.db, r), hours = runHours(v.db, r.id), primary = METRICS.find(m => m.id === (r.metric ?? DEFAULT_METRIC))
  // a run written by hand (day precision) next to the RC experiment's own times, to the second
  const rc = rcMatch(v.db, r), off = rc && (Math.abs(rc.start - r.start_at) >= 60_000 || Math.abs((rc.end ?? 0) - (r.end_at ?? 0)) >= 60_000)
  const rcLine = rc ? `<p class="track-sub">Lịch sử RC: <span class="tag">${esc(rc.id)}</span> trên <span class="tag">${esc(rc.cond)}</span> từ ${esc(vnTime(rc.start))}${rc.end ? ` đến ${esc(vnTime(rc.end))} giờ VN` : ' giờ VN, vẫn chạy'}.${off ? ' Khác giờ của đợt.' : ''}</p>` : ''
  const acts = [
    off && r.status !== 'dismissed' ? `<form method="post" action="/track/run/${r.id}/rc-times">${csrf(v)}<button type="submit" class="ghost">Dùng giờ RC</button></form>` : '',
    r.status === 'suggested' && r.arms.length >= 2 ? `<form method="post" action="/track/run/${r.id}/confirm">${csrf(v)}<button type="submit">Xác nhận</button></form>` : '',
    r.status === 'suggested' && r.arms.length >= 2 && r.alt_at && Math.abs(r.alt_at - r.start_at) >= HOUR ? `<form method="post" action="/track/run/${r.id}/confirm">${csrf(v)}<input type="hidden" name="at" value="alt"><button type="submit" class="ghost">Dùng giờ dữ liệu (${esc(vnTime(r.alt_at))})</button></form>` : '',
    `<a class="track-btn" href="/track/run/${r.id}/edit">Sửa</a>`,
    r.status === 'active' ? `<form method="post" action="/track/run/${r.id}/end">${csrf(v)}<button type="submit" class="ghost">Dừng đợt bây giờ</button></form>` : '',
    r.status === 'suggested' ? `<form method="post" action="/track/run/${r.id}/dismiss">${csrf(v)}<button type="submit" class="ghost danger">Bỏ gợi ý</button></form>` : '',
  ].filter(Boolean).join('')
  const info = `<div class="row">${pill(r.status === 'active' ? 'info' : r.status === 'suggested' ? 'warn' : 'mute', STATUS[r.status])}<span class="pill info">${esc(KIND[r.kind])}</span><b>${esc(appName(r.app))}</b></div>
    <dl class="kv">
      <div><dt>Nhánh</dt><dd>${r.arms.length ? r.arms.map((a, i) => `${i ? 'B' : 'A'} <span class="tag">${esc(a)}</span>`).join(' ') : '<span class="muted">chưa biết</span>'}</dd></div>
      <div><dt>Tỉ lệ kỳ vọng</dt><dd>${esc(r.weights.join(':'))}</dd></div>
      <div><dt>Từ</dt><dd>${esc(vnTime(r.start_at))} giờ VN</dd></div>
      <div><dt>Đến</dt><dd>${r.end_at ? `${esc(vnTime(r.end_at))} giờ VN` : 'đang chạy'}</dd></div>
      <div><dt>Nguồn</dt><dd>${esc(SOURCE[r.source] ?? r.source)}${r.exp_id ? ` <span class="tag">${esc(r.exp_id)}</span>` : ''}${r.cond ? ` <span class="tag">${esc(r.cond)}</span>` : ''}</dd></div>
      <div><dt>Chỉ số chính</dt><dd>${esc(primary?.label ?? '—')}</dd></div>
      <div><dt>Kết luận sau</dt><dd>${esc(String(r.horizon))} ngày cài</dd></div></dl>
    ${rcLine}${r.note ? `<p class="track-note">${esc(r.note)}</p>` : ''}${decisionLine(r)}${freshness(r, v.now)}<div class="inline track-acts">${acts}</div>`
  const users = `${hourChart(r, hours)}<p class="track-sub muted">${r.kind === 'version' ? 'Số user có first_open với version đó mỗi giờ (giờ VN).' : 'Số user mới mang nhãn nhánh trong giờ đó (giờ VN); một user dùng app nhiều giờ được đếm ở mỗi giờ, nên chỉ để xem hình dạng và lúc bắt đầu.'}</p>
    <h3>Nhóm user của đợt</h3>${split(r, st.sizes)}${st.parallel ? srmLine(r, st) : notParallel}${byDay(r, st.g)}`
  const mine = st.cmps.filter(x => x.arm === r.arms[1])
  return board(section('Tổng quan', info, '', '', { cls: 'track-aside' })
    + section('User mới mỗi nhánh', users, '', 'user', { span: 2, cls: 'track-result' })
    + section('B so với A', `${forest(mine)}<p class="track-sub muted">Chấm là mức chênh, vạch là khoảng tin cậy 95%. Chỉ chỉ số chính có màu, và chỉ khi hub đã kết luận; các chỉ số khác để tham khảo.</p>`, r.arms.length >= 2 ? `${r.arms[1]} so với ${r.arms[0]}` : '', 'chenh', { span: 2, cls: 'track-result' })
    + section('Retention D0 đến D7', curves(r, st.g, 'ret'), 'ngày cài đủ tuổi', '', { cls: 'track-curve' })
    + section('LTV ads cộng dồn', curves(r, st.g, 'ltv'), 'USD mỗi user, từ ad_revenue', '', { cls: 'track-curve' })
    + section('Bảng số đầy đủ', table(r, st), r.pulled_to ? `đến hết ${r.pulled_to.slice(8, 10)}/${r.pulled_to.slice(5, 7)} UTC` : '', 'bang', { span: 'all', cls: 'track-full-table' })
    + section('Cách so một đợt', METHOD, '', 'cach', { span: 2, cls: 'track-method-panel' }))
}

// ───────────── form ─────────────

export function runForm(v: View, f: URLSearchParams, r: Run | null, error = '') {
  const val = (k: string, d = '') => esc(f.get(k) ?? d)
  const app = f.get('app') ?? r?.app ?? DEFAULT_APP, kind = f.get('kind') ?? r?.kind ?? 'ab', metric = f.get('metric') ?? r?.metric ?? DEFAULT_METRIC
  const opt = (xs: [string, string][], sel: string) => xs.map(([k, l]) => `<option value="${esc(k)}"${k === sel ? ' selected' : ''}>${esc(l)}</option>`).join('')
  const conds = [...new Set(APPS.flatMap(a => rcSums(v.db, a.key).flatMap(s => s.exps.map(e => e.cond))))]
  const hours = r ? runHours(v.db, r.id) : null
  const seen = hours && hours.size ? [...new Set([...hours.values()].flatMap(m => [...m.keys()]))] : []
  const body = `${error ? `<p class="track-srm" role="alert">${pill('bad', 'Chưa lưu')}<span>${esc(error)}</span></p>` : ''}
    <form method="post" action="/track/run/save" class="track-fields">${csrf(v)}${r ? `<input type="hidden" name="id" value="${r.id}">` : ''}
    <label>App<select name="app">${opt(APPS.map(a => [a.key, a.name]), app)}</select></label>
    <label>Loại<select name="kind">${opt([['ab', 'A/B (experiment_group)'], ['version', 'Version (app_version)']], kind)}</select></label>
    <label class="track-full">Tên<input type="text" name="name" required maxlength="120" value="${val('name', r?.name)}" placeholder="ví dụ abt_10 Set1/Set2"></label>
    <label>Các nhánh, A trước<input type="text" name="arms" required maxlength="200" value="${val('arms', r?.arms.join(', '))}" placeholder="Set1, Set2 hoặc 1.0.16, 1.0.17"></label>
    <label>Tỉ lệ chia kỳ vọng<input type="text" name="weights" maxlength="60" value="${val('weights', r?.weights.join(':'))}" placeholder="trống là chia đều, ví dụ 50:50"></label>
    <label>Bắt đầu (giờ VN)<input type="datetime-local" name="start" required value="${val('start', r ? vnInput(r.start_at) : '')}"></label>
    <label>Kết thúc (giờ VN, trống là đang chạy)<input type="datetime-local" name="end" value="${val('end', r?.end_at ? vnInput(r.end_at) : '')}"></label>
    <label>Chỉ số chính<select name="metric">${opt(METRICS.map(m => [m.id, m.label]), metric)}</select></label>
    <label>Số ngày trước khi kết luận<input type="number" name="horizon" min="1" max="28" step="1" inputmode="numeric" required value="${val('horizon', String(r?.horizon ?? DEFAULT_HORIZON))}"></label>
    <label>Condition RC<input type="text" name="cond" maxlength="120" list="track-conds" value="${val('cond', r?.cond ?? '')}" placeholder="AB_…"></label>
    <datalist id="track-conds">${conds.map(c => `<option value="${esc(c)}"></option>`).join('')}</datalist>
    <label class="track-full">Ghi chú, giả thuyết<textarea name="note" maxlength="2000">${val('note', r?.note ?? '')}</textarea></label>
    <button type="submit">${r?.status === 'suggested' ? 'Lưu và xác nhận' : 'Lưu đợt'}</button></form>`
  const help = `<p class="track-sub">Nhánh: version (ví dụ <span class="tag">1.0.17</span>) hay nhãn <code>experiment_group</code> (ví dụ <span class="tag">Set1</span>), chỉ chữ, số, dấu chấm, gạch.</p>
    ${seen.length ? `<p class="track-sub">Thấy trong số theo giờ: ${seen.map(s => `<span class="tag">${esc(s)}</span>`).join(' ')}</p>` : ''}
    <p class="track-sub muted">Đổi nhánh, app hay thời gian thì số cũ bị xoá và hub lấy lại trong vòng 30 phút.</p>`
  return board(section(r ? `Sửa đợt: ${r.name}` : 'Ghi một đợt so sánh', body, '', '', { span: 2, cls: 'track-new' }) + section('Gợi ý nhập', help, '', '', { cls: 'track-aside' }))
}

/** The form's fields → a run, or the reason it cannot be saved. The form shows minutes: a stored time precise to the
 *  second (RC) is kept when its minute comes back unchanged, so saving a name does not move the start. */
export function readForm(f: URLSearchParams, parseVn: (s: string) => number, old?: Pick<Run, 'start_at' | 'end_at'> | null) {
  const keep = (t: number, o: number | null | undefined) => o != null && t === o - o % 60_000 ? o : t
  const app = f.get('app') ?? '', kind = f.get('kind') ?? '', name = (f.get('name') ?? '').trim().slice(0, 120)
  const arms = (f.get('arms') ?? '').split(/[,\s/]+/).map(x => x.trim()).filter(Boolean)
  const wt = (f.get('weights') ?? '').trim(), w = wt ? wt.split(/[,:;\s/]+/).filter(Boolean).map(Number) : arms.map(() => 1)
  const start = keep(parseVn(f.get('start') ?? ''), old?.start_at), endText = f.get('end') ?? '', end = endText ? keep(parseVn(endText), old?.end_at) : null
  const hz = (f.get('horizon') ?? '').trim(), horizon = hz ? Number(hz) : DEFAULT_HORIZON
  const metric = METRICS.some(m => m.id === f.get('metric')) ? f.get('metric')! : DEFAULT_METRIC
  const why = !APPS.some(a => a.key === app) ? 'Chọn app.' : kind !== 'ab' && kind !== 'version' ? 'Chọn loại đợt.' : !name ? 'Cần tên đợt.'
    : arms.length < 2 || arms.length > 6 || new Set(arms).size !== arms.length ? 'Cần 2 đến 6 nhánh khác nhau.'
    : !arms.every(a => ARM_RE.test(a)) ? 'Nhánh chỉ gồm chữ, số, dấu chấm, gạch dưới, gạch ngang.'
    : w.length !== arms.length || !w.every(x => Number.isFinite(x) && x > 0) ? 'Tỉ lệ chia cần đúng một số dương cho mỗi nhánh.'
    : !Number.isFinite(start) ? 'Cần thời điểm bắt đầu.' : end != null && !(Number.isFinite(end) && end > start) ? 'Kết thúc phải sau bắt đầu.'
    : !(Number.isInteger(horizon) && horizon >= 1 && horizon <= 28) ? 'Số ngày trước khi kết luận: từ 1 đến 28.' : ''
  return { why, run: { app, kind: kind as Run['kind'], name, arms, weights: w, start_at: start, end_at: end, horizon, metric, cond: (f.get('cond') ?? '').trim().slice(0, 120) || null, note: (f.get('note') ?? '').slice(0, 2000) || null } }
}
