// "Bật thông báo trên máy này" and "Gửi thử tới máy này" on /ops/notify (Web Push, architecture.md "Thông báo", owner 2026-11-09).
// The hub's service worker (/sw.js, core/sw.js) shows the pushes; this file registers it, subscribes this browser with the
// hub's VAPID public key and posts the subscription as a form (with the CSRF token, like every other post).
// Without it the page still lists the notifications; push just cannot be turned on. Text goes in with textContent only.
{
  const box = document.querySelector('.notify-push[data-key]')
  if (box) {
    const say = box.querySelector('[data-say]'), acts = box.querySelector('[data-acts]')
    const on = box.querySelector('[data-act=on]'), test = box.querySelector('[data-act=test]')
    const key = Uint8Array.from(atob(box.dataset.key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
    const show = (text, subscribed) => { say.textContent = text; acts.hidden = false; on.hidden = subscribed; test.hidden = !subscribed }
    const post = async (path, fields) => {
      try {
        const r = await fetch(path, { method: 'POST', body: new URLSearchParams({ _csrf: box.dataset.csrf, ...fields }) })
        return r.ok ? await r.json() : { ok: false, why: r.status === 403 ? 'trang đã cũ, tải lại rồi thử lại.' : `hub trả lỗi ${r.status}.` }
      } catch { return { ok: false, why: 'không gọi được hub.' } }
    }
    // a subscription made with another key (data/vapid.json was made again) cannot get the hub's pushes
    const ours = s => { const k = s?.options.applicationServerKey; return !!k && k.byteLength === key.length && new Uint8Array(k).every((x, i) => x === key[i]) }
    const current = async () => { const reg = await navigator.serviceWorker.getRegistration('/'); return reg ? reg.pushManager.getSubscription() : null }
    const save = s => { const j = s.toJSON(); return post('/ops/notify/subscribe', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }) }

    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      say.textContent = 'Trình duyệt này không nhận được thông báo đẩy. Mở hub bằng Chrome, qua địa chỉ https của hub.'
    } else if (Notification.permission === 'denied') {
      say.textContent = 'Máy này đang chặn thông báo của hub. Mở cài đặt trang (biểu tượng bên trái thanh địa chỉ), cho phép Thông báo, rồi tải lại trang.'
    } else (async () => {
      const s = Notification.permission === 'granted' ? await current().catch(() => null) : null
      if (!ours(s)) return show('Chưa bật trên máy này.', false)
      // the browser may have renewed it: the hub keeps the one this browser has now
      const r = await save(s)
      show(r.ok ? 'Đã bật trên máy này.' : `Đã bật trên máy này, nhưng hub chưa lưu được: ${r.why}`, r.ok)
    })()

    on.addEventListener('click', async () => {
      on.disabled = true
      try {
        if (await Notification.requestPermission() !== 'granted') return show('Chưa được phép: bấm Cho phép khi trình duyệt hỏi.', false)
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
        await navigator.serviceWorker.ready
        let s = await reg.pushManager.getSubscription()
        if (s && !ours(s)) { await s.unsubscribe(); s = null }
        s ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
        const r = await save(s)
        show(r.ok ? 'Đã bật trên máy này. Bấm Gửi thử để kiểm.' : `Không bật được: ${r.why}`, r.ok)
      } catch (e) { show(`Không bật được: ${e?.message || e}`, false) }
      finally { on.disabled = false }
    })
    test.addEventListener('click', async () => {
      test.disabled = true
      const s = await current().catch(() => null)
      const r = s ? await post('/ops/notify/test', { endpoint: s.endpoint }) : { ok: false, why: 'máy này chưa bật thông báo.' }
      say.textContent = r.ok ? 'Đã gửi. Thông báo hiện trong vài giây.' : `Gửi không được: ${r.why}`
      test.disabled = false
    })
  }
}
