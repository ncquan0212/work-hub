import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { openDb } from '../src/core/db.ts'
import { bridgeFetch, initBridge, loggedOut, markSeen } from '../src/lib/bridge.ts'
import { serveBridge } from '../src/modules/bridge/index.ts'
import { APPS } from '../src/config.ts'
import { appPaths, badBehavior, detailPct, moneyAfter, pctAfter, playAccounts } from '../src/modules/consoles.ts'
import { APP_SUBJECTS, parseFeed } from '../src/modules/gmail.ts'

test('bridge: a queued fetch reaches the "extension" and its result comes back; strangers are refused', async () => {
  const db = openDb(':memory:'); initBridge(db)
  const server = serveBridge(db, 0, 'k'.repeat(64))
  await new Promise(r => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const H = { 'x-hub-key': 'k'.repeat(64) }
  try {
    await assert.rejects(bridgeFetch(db, 'falcon', 'https://jira.example.com/rest/api/2/search', AbortSignal.timeout(5000)), /chưa kết nối/) // never seen: fail fast
    assert.equal((await fetch(`${base}/bridge/poll?profile=falcon&v=1`, { headers: { 'x-hub-key': 'wrong' } })).status, 403)
    assert.equal((await fetch(`${base}/bridge/poll?profile=falcon&v=1`, { headers: { ...H, origin: 'https://evil.example' } })).status, 403)
    markSeen(db, 'falcon', '1')
    await assert.rejects(bridgeFetch(db, 'falcon', 'https://evil.example/x', AbortSignal.timeout(1000)), /ngoài danh sách/)

    const pending = bridgeFetch(db, 'falcon', 'https://jira.example.com/rest/api/2/search?jql=x', AbortSignal.timeout(10_000))
    const job = await (await fetch(`${base}/bridge/poll?profile=falcon&v=1.0.0`, { headers: H })).json()
    assert.equal(job.kind, 'fetch')
    assert.equal((await fetch(`${base}/bridge/poll?profile=falcon&v=1.0.0`, { headers: H })).status, 204) // taken once only
    await fetch(`${base}/bridge/result`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ id: job.id, ok: true, result: { status: 200, finalUrl: 'u', headers: { 'x-ausername': 'user' }, body: '{}' } }) })
    const r = await pending
    assert.equal(r.headers['x-ausername'], 'user')
  } finally { server.close(); db.close() }
})

test('Gmail Atom feed: user feedback kept and assigned to apps, Google mail dropped', () => {
  const entry = (title: string, email: string, summary = '') => `<entry><title>${title}</title><summary>${summary}</summary><link rel="alternate" href="https://mail.google.com/mail?account_id=x&amp;message_id=1"/><modified>2026-11-08T03:00:00Z</modified><issued>2026-11-08T03:00:00Z</issued><author><name>A</name><email>${email}</email></author></entry>`
  const feed = `<?xml version="1.0"?><feed version="0.3" xmlns="http://purl.org/atom/ns#"><fullcount>7</fullcount>
    ${entry('Feedback XRemote: Universal TV Remote', 'user@gmail.com', 'app crash khi kết nối TV')}
    ${entry('User Feedback - Brainova', 'u2@yahoo.com', 'I was charged twice &amp; want a refund')}
    ${entry('Your AdMob payment', 'payments-noreply@google.com')}
    ${entry('hello', 'someone@gmail.com')}</feed>`
  const d = parseFeed(feed)
  assert.equal(d.unread, 7)
  assert.deepEqual(d.mails.map(m => [m.app, m.topics]), [['XRemote', ['crash', 'kết nối']], ['Brainova', ['thanh toán']], [null, []]])
  assert.equal(d.mails[0].link, 'https://mail.google.com/mail?account_id=x&message_id=1')
  assert.throws(() => parseFeed('<html>sign in</html>'), /không trả feed/)
})

test('Play accounts and feedback subjects come from the apps in the config', () => {
  // apps sharing a developer account are read from one app list, in app order
  assert.deepEqual(playAccounts().map(a => [a.dev, a.account, a.apps.map(x => `${x.key}:${x.title}`)]), [
    ['1000000000000000001', 'Studio A', ['xremote:XRemote', 'xcast:XCast']],
    ['1000000000000000002', 'Studio B', ['idol:Live Idol']],
    ['1000000000000000003', 'Studio C', ['brain:Brainova']],
  ])
  // no playDev: not on Play here; no account name or store title: the id and the app name stand in
  assert.deepEqual(playAccounts([{ key: 'a', name: 'A', pkg: 'p.a.b' }, { key: 'b', name: 'B', pkg: 'p.b.c', playDev: '42' }]),
    [{ dev: '42', account: '42', apps: [{ key: 'b', title: 'B' }] }])
  assert.deepEqual(APP_SUBJECTS.map(([n]) => n), APPS.map(a => a.name))
  assert.ok(APP_SUBJECTS.every(([, re]) => re.flags === 'i'))
  assert.equal(APP_SUBJECTS.find(([, re]) => re.test('feedback xcast: tv cast'))?.[0], 'XCast')
})

test('console page readers: numbers next to labels, validated; logged-out pages recognised', () => {
  assert.equal(pctAfter('Overview\nUser-perceived crash rate\n0.21%\nBad behavior threshold 1.09%', /user[- ]perceived crash rate/), 0.21)
  assert.equal(pctAfter('User-perceived ANR rate 0,35 %', /user[- ]perceived ANR rate/), 0.35)
  assert.equal(pctAfter('nothing here', /user[- ]perceived crash rate/), null)
  assert.equal(moneyAfter('Estimated earnings\nToday so far\nUS$1,234.56\nYesterday\n$99.10', /today so far/), 1234.56)
  assert.equal(moneyAfter('Yesterday\n$99.10', /yesterday/), 99.1)
  // AdMob home rounds with a suffix (2026-11-09); a next line starting with M is not a suffix
  const home = 'Today so far\n$7.48K\nYesterday\n$24.6K\nThis month so far\n$178K\nLast month\n$1.2M\nRequests\n$5.62\nMatch rate'
  assert.deepEqual([/today so far/, /yesterday/, /this month so far/, /last month/].map(r => moneyAfter(home, r)), [7480, 24600, 178000, 1200000])
  assert.equal(moneyAfter('Yesterday\n$99.10\nMatch rate', /yesterday/), 99.1)
  // Vietnamese console labels
  assert.equal(pctAfter('Tỷ lệ sự cố mà người dùng nhận thấy\n0,21%', /user[- ]perceived crash rate|tỷ lệ sự cố mà người dùng nhận thấy/), 0.21)
  // Play app list: the n-th package line pairs with the n-th arrow_forward row link, not the sidebar's dashboard link
  const dev = '1', link = (id: string, text: string): [string, string] => [`https://play.google.com/console/u/0/developers/${dev}/app/${id}/app-dashboard`, text]
  const list = { text: 'Tìm kiếm\nXRemote: Universal TV Remote\ncom.example.xremote\nDoanh thu (USD)\n207 $\n\tarrow_forward\nXCast: TV Cast\nCác thay đổi chưa được gửi đi xem xét\ncom.example.xcast\narrow_forward\nTrợ giúp',
    links: [link('11', 'dashboard'), link('11', 'arrow_forward'), link('22', 'arrow_forward')] }
  assert.deepEqual(appPaths(list, dev), { 'com.example.xremote': `/developers/${dev}/app/11`, 'com.example.xcast': `/developers/${dev}/app/22` })
  assert.deepEqual(appPaths({ ...list, links: list.links.slice(0, 2) }, dev), {}) // counts differ: no guessing
  // a new app without a package line (no bundle yet) loses only its own row, first or last
  const draft = 'Ứng dụng mới\nBản nháp\narrow_forward\n'
  assert.deepEqual(appPaths({ text: draft + list.text, links: [link('11', 'dashboard'), link('99', 'arrow_forward'), ...list.links.slice(1)] }, dev), appPaths(list, dev))
  assert.deepEqual(appPaths({ text: list.text.replace('Trợ giúp', draft), links: [...list.links, link('99', 'arrow_forward')] }, dev), appPaths(list, dev))
  // review 2026-11-09: the playVitals labels on an English page (threw), a missing value (read the threshold), NFD text,
  // and an AdMob amount shown as a dash (took the next label's)
  const CRASH = /user[- ]perceived crash rate|tỷ lệ sự cố mà người dùng nhận thấy/
  assert.equal(pctAfter('User-perceived crash rate\n0.21%', CRASH), 0.21)
  assert.equal(pctAfter('User-perceived crash rate\ninfo\n0.21%', CRASH), 0.21)
  assert.equal(pctAfter('Tỷ lệ sự cố mà người dùng nhận thấy\nKhông đủ dữ liệu\nNgưỡng hành vi xấu\n1,09%', CRASH), null)
  assert.equal(pctAfter('User-perceived crash rate\nNo data\nBad behavior threshold\n1.09%', CRASH), null)
  assert.equal(pctAfter('Tỷ lệ sự cố mà người dùng nhận thấy'.normalize('NFD') + '\n0,21%', CRASH), 0.21)
  assert.equal(moneyAfter('Today so far\n—\nYesterday\n$24.6K', /today so far/), null)
  assert.ok(loggedOut('https://accounts.google.com/ServiceLogin?service=admob'))
  assert.ok(loggedOut('https://google.play/business/'))
  assert.ok(!loggedOut('https://play.google.com/console/u/0/developers/1/app-list'))
})

test('Play "Hành vi xấu" cards, as read on 2026-11-11 (metric after the flag on Idol, before it on Brain)', () => {
  const idol = 'Chất lượng kỹ thuật\nerror\nHành vi xấu\nXem chi tiết\nThông tin này có hữu ích không?\nthumb_up\nthumb_down\nTỷ lệ lỗi ANR mà người dùng nhận thấy\n0,51%\nexpand_less\nMở rộng tất cả\nTrải nghiệm người dùng\nTên bản phát hành: 17 (1.0.16)'
  assert.deepEqual(badBehavior(idol), ['Tỷ lệ lỗi ANR mà người dùng nhận thấy 0,51%'], 'the next section\'s release is not the card\'s')
  const brain = 'Xem thêm\nMức sử dụng bộ nhớ\nerror\nHành vi xấu\nTên bản phát hành: 165 (2.0.63)\nXem gói bị ảnh hưởng\nThông tin này có hữu ích không?\nthumb_up\nthumb_down\nHạn chót khắc phục\nthg 2 2027\nexpand_less'
  assert.deepEqual(badBehavior(brain), ['Mức sử dụng bộ nhớ, bản 165 (2.0.63), hạn khắc phục thg 2 2027'])
  assert.deepEqual(badBehavior('Tỷ lệ sự cố mà người dùng nhận thấy\n0,08%\nNgưỡng hành vi xấu\n1,09%'), [], '"Ngưỡng hành vi xấu" is a threshold label, not a flag')
})

test('Play metric detail page, as read on 2026-11-11: the rate after "Lần cập nhật…", never the peer average', () => {
  const CRASH = /tỷ lệ sự cố mà người dùng nhận thấy/, ANR = /tỷ lệ (?:lỗi )?ANR mà người dùng nhận thấy/
  const page = (value: string) => ['Tổng quan về Android vitals', 'date_range', '28 ngày gần đây nhất', 'arrow_drop_down',
    'Tỷ lệ sự cố mà người dùng nhận thấy', 'arrow_drop_down', 'Người dùng sử dụng các phiên bản Android công khai, Hàng ngày, 28 ngày',
    'Chỉnh sửa', 'Chỉnh sửa nhóm ứng dụng ngang hàng', 'Nhóm ứng dụng ngang hàng: Nhóm ứng dụng ngang hàng tùy chỉnh', 'arrow_drop_down',
    'filter_list', '', 'Lần cập nhật dữ liệu gần nhất là Thứ Ba, 15:00', '', 'help', 'help', value, 'Phiên bản chính thức', '-0,01%',
    'arrow_drop_down', 'so với giai đoạn trước', 'Xem sự cố', 'arrow_right_alt', '+0,03%', 'brightness_1',
    'so với điểm trung bình của nhóm ứng dụng ngang hàng', '0,13%', 'Điểm trung bình của nhóm ứng dụng ngang hàng'].join('\n')
  assert.equal(detailPct(page('0,16%'), CRASH), 0.16) // Brainova
  // XRemote's crash page: the metric name and the peer group between the date line and the value
  assert.equal(detailPct(page('0,09%').replace('help\nhelp\n', 'Tỷ lệ sự cố mà người dùng nhận thấy\nhelp\nso với ứng dụng ngang hàng: Nhóm ứng dụng ngang hàng tùy chỉnh\nhelp\n'), CRASH), 0.09)
  assert.equal(detailPct(page('-'), CRASH), null) // no value: not the peer average 0,13%
  assert.equal(detailPct(page('Không đủ dữ liệu'), CRASH), null)
  // Idol's ANR page, over the threshold: "error" and "so với ngưỡng" under the value, no "Phiên bản chính thức"
  assert.equal(detailPct(page('0,51%').replace('Phiên bản chính thức', 'error\n+0,04%\nso với ngưỡng lỗi trục trặc'), CRASH), 0.51)
  assert.equal(detailPct(page('0,16%'), ANR), null) // the page shows another metric
  assert.equal(pctAfter(page('0,16%'), CRASH), null) // why the overview's reader missed it
})

