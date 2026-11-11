// The task page as a chat (owner 2026-11-09). Loaded after paste.js; without it the page still works (the form posts and
// the page reloads). What it adds:
//  - Enter sends on a keyboard, Shift+Enter makes a new line; a touch keyboard has no Shift, so there Enter stays a new
//    line and the button sends (as in ChatGPT's app). Cmd/Ctrl+Enter sends anywhere. Never while an IME is composing
//    (Vietnamese Telex/VNI): that Enter belongs to the IME.
//  - sending does not reload the page; the box empties, the draft is kept in this browser until the message is in;
//  - the thread updates itself from /develop/task/:id/live: new messages, "Claude đang…", the panels, what the box
//    offers (2 s while a turn is open, 15 s otherwise, slower in a background tab);
//  - the view follows new messages when it is at the bottom, otherwise a button says there are new ones;
//  - a copy button on Claude's replies.
// Everything put into the page is HTML the hub rendered and escaped (develop/index.ts), or text set as text.
{
  const msgs = document.querySelector('.develop-msgs[data-task]')
  const form = document.querySelector('form.develop-compose')
  if (msgs && form) {
    const id = msgs.dataset.task, base = `/develop/task/${id}`
    const ta = form.querySelector('textarea'), sendBtn = form.querySelector('button[value=discuss]')
    const err = document.getElementById('compose-err'), note = document.getElementById('compose-note')
    const off = document.getElementById('compose-off'), pill = document.getElementById('newmsg')
    const keyboard = matchMedia('(hover: hover) and (pointer: fine)')
    let after = Number(msgs.dataset.after) || 0, state = form.dataset.state, busy = false, timer = 0
    // paste.js added its hint to the placeholder: keep it when the placeholder changes with the state
    const hint = ta.placeholder.slice((ta.dataset.base ?? '').length)
    // what each panel the hub renders is now (a hash from the hub), so an unchanged one is not rebuilt (focus, taps)
    const seen = new Map(['typing', 'live', 'status', 'steps'].map(k => [k, msgs.dataset['v' + k[0].toUpperCase() + k.slice(1)]]))

    const KEY = `develop-draft-${id}`
    // storage can be off (private window, blocked site data): the box then simply starts empty
    const draft = {
      get: () => { try { return localStorage.getItem(KEY) ?? '' } catch { return '' } },
      set: v => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY) } catch { /* not kept */ } },
    }
    if (!ta.value) ta.value = draft.get()
    let saving = 0
    ta.addEventListener('input', () => { clearTimeout(saving); saving = setTimeout(() => draft.set(ta.value.trim() ? ta.value : ''), 300) })

    const atBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 160
    const toBottom = smooth => scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    // a jump, not a glide: it can be a long way down
    pill.addEventListener('click', () => { pill.hidden = true; toBottom(false) })
    addEventListener('scroll', () => { if (!pill.hidden && atBottom()) pill.hidden = true }, { passive: true })

    const addCopy = () => msgs.querySelectorAll('.msg:not(.me) > .who').forEach(who => {
      if (who.querySelector('.develop-copy')) return
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'develop-copy', textContent: 'Chép' })
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(who.parentElement.querySelector('.md')?.innerText ?? ''); b.textContent = 'Đã chép' } catch { b.textContent = 'Không chép được' }
        setTimeout(() => { b.textContent = 'Chép' }, 1500)
      })
      who.append(b)
    })
    addCopy()

    // an element the hub renders by id: replaced when it changed, removed when gone, put in place when new. Focus inside
    // it moves to the same control in the new one (the stop button, a status button)
    const swap = (elId, html, v, place) => {
      if (seen.get(elId) === v) return false
      seen.set(elId, v)
      const el = document.getElementById(elId)
      if (!html) { el?.remove(); return !!el }
      if (!el) { place(html); return true }
      const f = el.contains(document.activeElement) ? document.activeElement : null
      const key = f && (f.closest('form')?.getAttribute('action') ?? '') + '|' + (f.getAttribute('value') ?? '')
      el.outerHTML = html
      if (key) [...document.getElementById(elId)?.querySelectorAll('button, a') ?? []]
        .find(b => (b.closest('form')?.getAttribute('action') ?? '') + '|' + (b.getAttribute('value') ?? '') === key)?.focus({ preventScroll: true })
      return true
    }
    // "Claude đang…" changes its words in place: a status region swapped whole is not read out
    const typing = (html, v) => {
      if (seen.get('typing') === v) return false
      seen.set('typing', v)
      const el = document.getElementById('typing')
      if (!html) { el?.remove(); return !!el }
      const next = new DOMParser().parseFromString(html, 'text/html').getElementById('typing')
      if (!el || !next) { el?.remove(); (off ?? form).insertAdjacentHTML('beforebegin', html); return true }
      el.querySelector('p > span:last-child').replaceWith(next.querySelector('p > span:last-child'))
      return true
    }
    const setState = j => {
      if (j.state === 'closed') return location.reload() // closed elsewhere: the whole page changes
      state = j.state
      form.dataset.state = state; form.hidden = state === 'cancel'
      if (off) off.hidden = state !== 'cancel'
      ta.dataset.base = j.placeholder; ta.placeholder = j.placeholder + hint
      if (seen.get('compose-note') !== j.note) { seen.set('compose-note', j.note); note.innerHTML = j.note }
    }
    const modeLabel = form.querySelector('.develop-mode summary b')
    const apply = (j, follow) => {
      const stick = follow || atBottom()
      // one answer per poll is in flight, and a message already shown is never added again
      const fresh = j.messages.filter(h => { const m = /data-id="(\d+)"/.exec(h); return !m || !msgs.querySelector(`[data-id="${m[1]}"]`) })
      if (fresh.length) {
        msgs.querySelector(':scope > .empty')?.remove()
        document.getElementById('latest')?.removeAttribute('id') // the batch carries the new #latest
        for (const h of fresh) msgs.insertAdjacentHTML('beforeend', h)
        addCopy()
      }
      after = Math.max(after, j.after)
      const moved = typing(j.typing, j.v.typing)
      swap('live', j.live, j.v.live, h => document.querySelector('.develop-task-main')?.insertAdjacentHTML('afterbegin', h))
      swap('status', j.status, j.v.status, h => document.querySelector('.develop-task-side')?.insertAdjacentHTML('afterbegin', h))
      swap('steps', j.steps, j.v.steps, h => document.getElementById('status')?.insertAdjacentHTML('afterend', h))
      if (modeLabel && modeLabel.textContent !== j.mode) modeLabel.textContent = j.mode
      if (j.state !== state || seen.get('compose-note') !== j.note) setState(j)
      if (fresh.length || moved) { if (stick) toBottom(true); else if (fresh.length) pill.hidden = false }
    }
    // one poll at a time: a call made while one is out runs once more after it (two answers with the same `after`
    // would add the same messages twice)
    let inflight = null, again = false, follow = false
    const poll = async f => {
      follow ||= !!f
      if (inflight) { again = true; return inflight }
      clearTimeout(timer)
      inflight = (async () => {
        do {
          again = false
          const f2 = follow; follow = false
          try {
            const r = await fetch(`${base}/live?after=${after}`, { cache: 'no-store' })
            if (r.ok) apply(await r.json(), f2)
          } catch { /* offline for a moment: the next poll tries again */ }
        } while (again)
      })()
      await inflight
      inflight = null
      timer = setTimeout(poll, document.hidden ? 60_000 : state === 'reply' ? 15_000 : 2_000)
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll() })
    timer = setTimeout(poll, state === 'reply' ? 15_000 : 2_000)

    const say = text => { err.textContent = text }
    ta.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.shiftKey || e.altKey) return
      if (!(e.metaKey || e.ctrlKey || keyboard.matches)) return
      e.preventDefault()
      if (!busy && (ta.value.trim() || form.querySelector('input[type=file]')?.files.length)) form.requestSubmit(sendBtn)
    })
    form.addEventListener('submit', async e => {
      e.preventDefault()
      if (busy) return
      const body = new FormData(form, e.submitter)
      // what goes now: text typed or images pasted while it is on its way stay in the box
      const text = ta.value, nFiles = form.querySelector('input[type=file]')?.files.length ?? 0
      busy = true; say(''); form.classList.add('is-sending')
      const buttons = [...form.querySelectorAll('button[type=submit]')]; buttons.forEach(b => { b.disabled = true })
      try {
        const r = await fetch(`${form.action}?js=1`, { method: 'POST', body })
        const j = (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : { ok: false, why: (await r.text()).slice(0, 200) }
        if (j.ok) {
          // not form.reset(): it would put the run mode back to what the page was loaded with (review 2026-11-09)
          ta.value = ta.value.startsWith(text) ? ta.value.slice(text.length).replace(/^\s+/, '') : ta.value
          draft.set(ta.value.trim() ? ta.value : '')
          form.dispatchEvent(new CustomEvent('develop:sent', { detail: nFiles })) // paste.js drops the images that went
          await poll(true)
        } else say(j.why || 'Chưa gửi được, thử lại.')
      } catch { say('Mất kết nối, tin chưa gửi. Thử lại.') }
      finally { busy = false; form.classList.remove('is-sending'); buttons.forEach(b => { b.disabled = false }); ta.focus({ preventScroll: true }) }
    })
  }
}
