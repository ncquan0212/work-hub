// Paste or drop images into the Develop form on the page (owner 2026-11-09, architecture.md "Develop"). The hub's one script, and an
// optional one: the file picker works without it, so the hint that pasting works is added here, not in the HTML.
// Served by the develop module at /develop/paste.js?v=<hash>; CSP script-src 'self' (core/server.ts).
// Every way in adds to one list: paste, drop, and the picker too (a native pick would otherwise replace what was pasted).
// The list is what the form sends: it is written back into the <input type="file"> through a DataTransfer.
{
  const input = document.querySelector('input[type=file][name=images]')
  if (input) {
    const max = Number(input.dataset.max) || 6
    const label = input.closest('label') ?? input.parentElement
    // the task page's composer keeps its file input in a small button: the thumbnails go where data-preview says, and the
    // hint into the text box's placeholder (data-hint), so the box grows only when there is something to show
    const preview = document.getElementById(input.dataset.preview ?? '') ?? label, hintTo = document.getElementById(input.dataset.hint ?? '')
    const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text ? { textContent: text } : {})
    // only the count line is live, and it is always rendered (an element shown and filled at once is not announced)
    const box = el('div', 'develop-paste'), list = el('div', 'develop-imgs'), line = el('span', 'develop-hint')
    list.hidden = true; line.setAttribute('aria-live', 'polite'); box.append(list, line)
    if (hintTo instanceof HTMLTextAreaElement) hintTo.placeholder += ', dán hay kéo thả ảnh vào cũng được'
    else label.append(el('span', 'develop-hint', 'Dán ảnh (⌘V, Ctrl+V) hay kéo thả vào trang cũng được.'))
    preview.append(box)
    // the box may sit inside the <label>: a click on it must not open the picker
    box.addEventListener('click', e => e.preventDefault())

    let chosen = []
    const urls = new Map() // one object URL per file, for as long as the file is in the list
    const set = (files, focusAt) => {
      const had = chosen.length
      chosen = files
      // only what the server keeps is sent: past it the post could pass the 64 MB cap and fail whole
      const dt = new DataTransfer()
      for (const f of files.slice(0, max)) dt.items.add(f)
      input.files = dt.files
      for (const [f, u] of urls) if (!files.includes(f)) { URL.revokeObjectURL(u); urls.delete(f) }
      list.replaceChildren(...files.map((f, i) => {
        if (!urls.has(f)) urls.set(f, URL.createObjectURL(f))
        const b = el('button', 'develop-paste-img'); b.type = 'button'; b.setAttribute('aria-label', `Bỏ ảnh ${i + 1}`)
        // the name shows where the browser cannot draw the file (HEIC in Chrome)
        b.append(Object.assign(el('img'), { src: urls.get(f), alt: f.name }))
        b.addEventListener('click', () => set(chosen.filter((_, j) => j !== i), i))
        return b
      }))
      line.textContent = files.length ? `${Math.min(files.length, max)} ảnh gửi kèm${files.length > max ? `, chỉ ${max} ảnh đầu được gửi` : ''}. Bấm vào ảnh để bỏ.`
        : had ? 'Đã bỏ hết ảnh.' : ''
      list.hidden = !files.length
      // the button that had focus is gone: the next thumbnail, or the picker, takes it
      if (focusAt !== undefined) (list.children[Math.min(focusAt, files.length - 1)] ?? input).focus()
    }
    const images = files => [...(files ?? [])].filter(f => f && f.type.startsWith('image/'))
    const has = (types, t) => [...(types ?? [])].includes(t)

    // files the browser put back into the input (Back to this page) count too
    if (input.files.length) set([...input.files])
    input.addEventListener('change', () => set([...chosen, ...input.files]))
    // chat.js says how many images went with a message: those leave the list, quietly (they were sent, not removed);
    // a native form reset empties it
    input.form?.addEventListener('develop:sent', e => { set(chosen.slice(Number(e.detail) || 0)); if (!chosen.length) line.textContent = '' })
    input.form?.addEventListener('reset', () => setTimeout(() => set([])))
    document.addEventListener('paste', e => {
      const cd = e.clipboardData
      if (!cd) return
      let got = images(cd.files)
      if (!got.length) got = images([...cd.items].filter(i => i.kind === 'file').map(i => i.getAsFile()))
      if (!got.length) return
      set([...chosen, ...got])
      // a screenshot carries no text. A copy from Excel or Sheets carries both: its text still goes in, and the
      // picture of it shows here, to be taken out with a tap
      if (!has(cd.types, 'text/plain')) e.preventDefault()
    })
    // a file, or a link outside a text field, dropped on the page would open in the tab and lose what was typed
    const held = e => has(e.dataTransfer?.types, 'Files') || (has(e.dataTransfer?.types, 'text/uri-list') && !e.target.closest?.('textarea, input'))
    document.addEventListener('dragover', e => { if (held(e)) e.preventDefault() })
    document.addEventListener('drop', e => {
      if (!held(e)) return
      e.preventDefault()
      const got = images(e.dataTransfer.files)
      if (got.length) set([...chosen, ...got])
    })
  }
}
