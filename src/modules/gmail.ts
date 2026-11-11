// F1 · User feedback mail in the publisher mailbox (the `publisher` Chrome profile), through the browser bridge:
// Gmail's Atom feed with the profile's own login (no OAuth app: owner rule R1). The feed lists UNREAD
// inbox mail only, newest 20. Each app's in-app feedback uses a fixed subject (from the app code; config
// feedbackSubject), which assigns a mail to an app.
import { APPS, COMPANY_DOMAINS, PROFILE_LABELS } from '../config.ts'
import { ago, clock, cut, empty, esc, link, num, pill, section, stale } from '../core/html.ts'
import { NotConfigured, type Alert, type Module } from '../core/types.ts'
import { bridgeFetch, initBridge, loggedOut } from '../lib/bridge.ts'

const FEED = 'https://mail.google.com/mail/u/0/feed/atom'

export const APP_SUBJECTS: [string, RegExp][] = APPS.filter(a => a.feedbackSubject).map(a => [a.name, new RegExp(a.feedbackSubject!, 'i')])
const BOX = PROFILE_LABELS.publisher ?? 'Chrome profile của hộp thư publisher'
const NOT_USERS = new RegExp(`(@|\\.)(${['google.com', 'googlemail.com', ...COMPANY_DOMAINS].map(d => RegExp.escape(d)).join('|')})$|no-?reply|donotreply|mailer-daemon`, 'i')
// rough topic tags from keywords (Vietnamese and English), to spot repeats at a glance
const TOPICS: [string, RegExp][] = [
  ['crash', /crash|văng|thoát|force close|không mở|đơ|lag|freeze/i],
  ['ads', /\bads?\b|quảng cáo|advert/i],
  ['kết nối', /connect|kết nối|pair|wifi|không tìm thấy|cast|mirror/i],
  ['thanh toán', /pay|subscription|subscribe|refund|charge|premium|mua|hoàn tiền|trừ tiền/i],
]

export type Mail = { subject: string; summary: string; from: string; email: string; at: number; link: string; app: string | null; topics: string[] }
export type GmailData = { unread: number; mails: Mail[] }

const xml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')
const tag = (s: string, t: string) => xml(s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1]?.trim() ?? '')

/** Gmail Atom feed → user-feedback mails (Google/AdMob/no-reply and our own domains left out). */
export function parseFeed(text: string): GmailData {
  if (!/<feed[\s>]/.test(text)) throw new Error('Gmail không trả feed (có thể chưa đăng nhập)')
  const mails: Mail[] = []
  for (const m of text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1], subject = tag(e, 'title'), email = tag(e, 'email')
    if (NOT_USERS.test(email)) continue
    const summary = tag(e, 'summary')
    mails.push({
      subject, summary, from: tag(e, 'name'), email, at: Date.parse(tag(e, 'issued') || tag(e, 'modified')) || 0,
      link: xml(e.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? ''),
      app: APP_SUBJECTS.find(([, re]) => re.test(subject))?.[0] ?? null,
      topics: TOPICS.filter(([, re]) => re.test(`${subject} ${summary}`)).map(([t]) => t),
    })
  }
  return { unread: Number(tag(text, 'fullcount')) || 0, mails }
}

export const gmail: Module<GmailData> = {
  id: 'gmail', title: 'Mail phản hồi của user', group: 'feedback', every: 30 * 60, timeout: 150,

  init: initBridge,

  async collect({ db, signal }) {
    if (!APPS.length) throw new NotConfigured('chưa có app trong data/config.json')
    if (!PROFILE_LABELS.publisher) throw new NotConfigured('chưa có Chrome profile cho hộp thư publisher (chromeProfiles.publisher trong data/config.json)')
    const r = await bridgeFetch(db, 'publisher', FEED, signal)
    if (loggedOut(r.finalUrl) || r.status === 401) throw new Error(`${BOX} chưa đăng nhập Gmail`)
    if (r.status !== 200) throw new Error(`Gmail HTTP ${r.status}`)
    return parseFeed(r.body)
  },

  css: String.raw`
@media (min-width: 120rem) { .gmail-panel { grid-column: span 3 } }
.gmail-body { container: gmail / inline-size; display: grid; gap: var(--space-md); min-width: 0 }
.gmail-index { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-xs) }
.gmail-index a, .gmail-index span { display: inline-flex; align-items: center; gap: var(--space-xs); min-height: 36px; padding: 0 var(--space-md); border-radius: var(--radius-pill);
  font-size: var(--text-sm); font-weight: 500; text-decoration: none; box-shadow: inset 0 0 0 1px var(--rule-2); transition: background-color var(--dur-micro) var(--ease-out) }
.gmail-index b { font-variant-numeric: tabular-nums }
.gmail-index span { color: var(--muted); box-shadow: inset 0 0 0 1px var(--rule) }
@media (hover: hover) { .gmail-index a:hover { background: var(--paper-3) } }
@media (pointer: coarse) { .gmail-index a, .gmail-index span { min-height: 44px } }
.gmail-group { display: grid; gap: var(--space-xs); min-width: 0; scroll-margin-top: calc(var(--bar-h) + var(--space-md)) }
.gmail-group h3 { display: flex; align-items: baseline; gap: var(--space-xs) }
.gmail-mails { list-style: none; margin: 0; padding: 0; display: grid }
.gmail-mails > li { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "from at" "what what"; gap: var(--space-3xs) var(--space-sm); padding: var(--space-sm) 0; border-top: 1px solid var(--rule); min-width: 0 }
.gmail-mails > li:first-child { border-top: 0; padding-top: var(--space-2xs) }
.gmail-from { grid-area: from; min-width: 0; font-size: var(--text-sm); overflow-wrap: anywhere }
.gmail-from b { font-weight: 600 }
.gmail-from .sub { margin: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
.gmail-at { grid-area: at; font-size: var(--text-sm); color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums }
.gmail-what { grid-area: what; display: grid; gap: var(--space-3xs); min-width: 0 }
.gmail-subj { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs) var(--space-xs); font-weight: 600; min-width: 0 }
.gmail-subj > a, .gmail-subj > span:first-child { min-width: 0; overflow-wrap: anywhere }
.gmail-snip { color: var(--ink-2); font-size: var(--text-sm); overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden }
@container gmail (min-width: 46rem) {
  .gmail-mails > li { grid-template-columns: minmax(0, 13rem) minmax(0, 1fr) auto; grid-template-areas: "from what at"; column-gap: var(--space-lg) }
}
`,

  panel(s, v) {
    const d = s?.data
    const o = { span: 2 as const, cls: 'gmail-panel' }
    if (!d) return section(this.title, `${stale(s, v.now)}${empty(`Chưa đọc được Gmail (cần extension trong ${BOX}).`)}`, '', 'gmail', o)
    const groups = [...APP_SUBJECTS.map(([a]) => a), null].map(app => ({ app, id: `gmail-${app ? app.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'khac'}`, label: app ?? 'App khác', xs: d.mails.filter(m => m.app === app) }))
    const index = `<ul class="gmail-index" aria-label="Số mail theo app">${groups.map(g => `<li>${g.xs.length ? `<a href="#${g.id}">${esc(g.label)} <b>${g.xs.length}</b></a>` : `<span>${esc(g.label)} <b>0</b></span>`}</li>`).join('')}</ul>`
    const mail = (m: Mail) => `<li><div class="gmail-from"><b dir="auto">${esc(m.from || m.email)}</b><div class="sub">${esc(m.email)}</div></div>
      <time class="gmail-at" datetime="${esc(new Date(m.at).toISOString())}" title="${esc(clock(m.at))}">${esc(ago(m.at, v.now))}</time>
      <div class="gmail-what"><div class="gmail-subj">${m.subject ? link(m.link, cut(m.subject, 90)) : link(m.link, '(không có tiêu đề)')}${m.topics.map(t => pill(t === 'crash' || t === 'thanh toán' ? 'warn' : 'mute', t)).join('')}</div>
      ${m.summary ? `<p class="gmail-snip" dir="auto">${esc(cut(m.summary, 300))}</p>` : ''}</div></li>`
    const list = groups.filter(g => g.xs.length).map(g => `<div class="gmail-group" id="${g.id}"><h3>${esc(g.label)} <span class="muted">${g.xs.length}</span></h3><ul class="gmail-mails">${g.xs.map(mail).join('')}</ul></div>`).join('')
    return section(this.title, `${stale(s, v.now)}<div class="gmail-body">${index}${list || empty('Không có mail phản hồi chưa đọc.')}</div>`,
      `${num(d.unread)} mail chưa đọc trong hộp thư của ${BOX}, feed chỉ lấy 20 mail mới nhất`, 'gmail', o)
  },

  alerts(s): Alert[] {
    const xs = (s?.data?.mails ?? []).filter(m => m.app && m.topics.some(t => t === 'crash' || t === 'thanh toán'))
    return xs.length ? [{ tone: 'warn', text: `${xs.length} mail phản hồi chưa đọc nói về crash/thanh toán`, href: '/feedback' }] : []
  },
}
