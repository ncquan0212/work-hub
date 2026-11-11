// work-hub bridge extension (MV3). Every minute it asks the hub on this computer for queued jobs, does each one
// in this Chrome profile, and posts the result back. Read-only by construction: a job is either a GET
// fetch with the profile's cookies, or a page opened in a minimized window whose text is read and which
// is then closed. No clicks, no form input, allow-listed URLs only. config.js is written by
// `npm run bridge:extension` (hub address, shared key, and the company values from data/config.json) and never leaves
// this computer.
import { DOMAINS, HUB, JIRA, KEY, VERSION } from './config.js'

const ALLOWED = [
  /^https:\/\/mail\.google\.com\/mail\/u\/\d+\/feed\/atom(\/[\w-]+)?$/,
  /^https:\/\/play\.google\.com\/console\//,
  /^https:\/\/admob\.google\.com\//,
  ...(JIRA ? [new RegExp(`^${JIRA.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/rest/api/2/`)] : []),
]
// which hub profile this Chrome profile is, from the account signed in to Chrome (chromeDomains in data/config.json)
const DOMAIN_PROFILE = DOMAINS
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function whoAmI() {
  const u = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })
  return DOMAIN_PROFILE[(u.email || '').split('@')[1] || ''] || null
}

async function doFetch(url) {
  const r = await fetch(url, { credentials: 'include', redirect: 'follow' })
  const body = await r.text()
  return { status: r.status, finalUrl: r.url, headers: { 'x-ausername': r.headers.get('x-ausername') || '', 'content-type': r.headers.get('content-type') || '' }, body: body.slice(0, 2_000_000) }
}

// runs inside the page
function extract(waitFor) {
  const body = document.body
  const text = body ? body.innerText.slice(0, 300000) : ''
  return {
    matched: waitFor ? !!document.querySelector(waitFor) : false,
    data: {
      title: document.title, text,
      jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => { try { return JSON.parse(s.textContent) } catch { return null } }).filter(Boolean),
      tables: [...document.querySelectorAll('table')].slice(0, 20).map(t => [...t.rows].slice(0, 200).map(r => [...r.cells].map(c => c.innerText.trim().slice(0, 200)))),
      links: [...document.querySelectorAll('a[href]')].slice(0, 800).map(a => [a.href, a.innerText.trim().slice(0, 160)]),
    },
  }
}

async function doPage(url, waitFor) {
  const win = await chrome.windows.create({ url, state: 'minimized', focused: false })
  const tabId = win.tabs[0].id
  try {
    const deadline = Date.now() + 60000
    let last = null, prevLen = -1, stable = 0
    while (Date.now() < deadline) {
      await sleep(1500)
      const tab = await chrome.tabs.get(tabId)
      if (tab.status !== 'complete') continue
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: extract, args: [waitFor || null] })
      last = res && res.result
      if (!last) continue
      if (last.matched) break
      // single-page consoles keep loading after "complete": wait until the text stops growing
      const len = last.data.text.length
      stable = len > 300 && len === prevLen ? stable + 1 : 0
      prevLen = len
      if (!waitFor && stable >= 2) break
    }
    if (!last) throw new Error('trang không tải xong')
    const tab = await chrome.tabs.get(tabId)
    return { ...last.data, finalUrl: tab.url }
  } finally { chrome.windows.remove(win.id).catch(() => {}) }
}

let busy = false
async function poll() {
  if (busy) return
  busy = true
  try {
    const profile = await whoAmI()
    if (!profile) return
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${HUB}/bridge/poll?profile=${profile}&v=${VERSION}`, { headers: { 'x-hub-key': KEY } })
      if (r.status !== 200) return
      const job = await r.json()
      let out
      try {
        if (!ALLOWED.some(re => re.test(job.url))) throw new Error('URL ngoài danh sách cho phép')
        out = { id: job.id, ok: true, result: job.kind === 'fetch' ? await doFetch(job.url) : await doPage(job.url, job.waitFor) }
      } catch (e) { out = { id: job.id, ok: false, error: String((e && e.message) || e).slice(0, 300) } }
      await fetch(`${HUB}/bridge/result`, { method: 'POST', headers: { 'x-hub-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify(out) })
    }
  } catch { /* hub not running: try again next minute */ } finally { busy = false }
}

chrome.alarms.create('poll', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'poll') poll() })
chrome.runtime.onStartup.addListener(poll)
chrome.runtime.onInstalled.addListener(poll)
