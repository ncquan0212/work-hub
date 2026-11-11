// Markdown that Claude writes (Develop task replies) → HTML. The text is untrusted: every fragment goes
// through esc() first, then only fixed tags are added, and links are made only from https URLs.
// Covers what the replies use: headings, paragraphs, **bold**, *italic*, `code`, fenced code, lists (nested,
// ordered, checklists), tables, quotes, rules. Tested in test/core.test.ts.
// ponytail: line-based, not full CommonMark (no setext headings, reference links, raw HTML); add when a reply needs it.
import { esc } from './html.ts'

const A = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`

/** One line of inline Markdown. Code spans become \0n\0 placeholders while the rest is formatted (so `**a `b`**`
 *  still bolds), then come back escaped and unformatted. */
export function inline(s: string) {
  const codes: string[] = []
  return esc(s.replace(/\0/g, '').replace(/`([^`\n]+)`/g, (_, c) => `\0${codes.push(c) - 1}\0`))
    .replace(/\[([^\]\n]+)\]\((https:\/\/[^\s)\0]+)\)/g, (_, t, u) => A(u, t))
    .replace(/(^|[\s(])(https:\/\/[^\s<\0]*[^\s<\0.,;:!?)])/g, (_, pre, u) => pre + A(u, u))
    .replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/\0(\d+)\0/g, (_, i) => `<code>${esc(codes[+i])}</code>`)
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
const NUMERIC = /^[-+−]?[$€]?[\d.,]+\s?(%|[kKmMbB]|ms|s|x)?$/

function table(head: string, sep: string, rows: string[]) {
  const body = rows.map(cells)
  // a column is right-aligned when the separator says so (`---:`) or every filled cell in it is a number
  const right = cells(sep).map((c, i) => (c.endsWith(':') && !c.startsWith(':'))
    || (body.some(r => r[i]) && body.every(r => !r[i] || NUMERIC.test(r[i]))))
  const td = (tag: string, c: string, i: number) => {
    const cls = right[i] ? 'num' : tag === 'td' && c.length > 24 ? 'wrap' : ''
    return `<${tag}${cls ? ` class="${cls}"` : ''}>${inline(c)}</${tag}>`
  }
  return `<div class="scroll"><table><thead><tr>${cells(head).map((c, i) => td('th', c, i)).join('')}</tr></thead>`
    + `<tbody>${body.map(r => `<tr>${r.map((c, i) => td('td', c, i)).join('')}</tr>`).join('')}</tbody></table></div>`
}

export function md(src: string): string {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  const lists: { tag: 'ul' | 'ol'; indent: number }[] = [] // each open list leaves its last <li> open
  const flush = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = [] }
  const closeLists = (above = -1) => { while (lists.length && lists.at(-1)!.indent > above) out.push(`</li></${lists.pop()!.tag}>`) }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) { // fenced code: everything up to the closing fence, verbatim
      flush(); closeLists()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i])
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) { flush(); continue } // a blank line ends a paragraph; a list ends at the next non-list line
    let m: RegExpMatchArray | null
    if ((m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      const indent = m[1].replace(/\t/g, '  ').length, tag = /\d/.test(m[2]) ? 'ol' : 'ul'
      closeLists(indent)
      const top = lists.at(-1)
      if (top && top.indent === indent && top.tag !== tag) closeLists(indent - 1)
      if (lists.at(-1)?.indent === indent) out.push('</li><li>')
      else { lists.push({ tag, indent }); const n = parseInt(m[2]); out.push(`<${tag}${n > 1 ? ` start="${n}"` : ''}><li>`) }
      const task = m[3].match(/^\[([ xX])\]\s+(.*)$/)
      out.push(task ? `<input type="checkbox" disabled${task[1] === ' ' ? ' aria-label="chưa xong"' : ' checked aria-label="xong"'}>${inline(task[2])}` : inline(m[3]))
      continue
    }
    if (lists.length && /^\s{2,}\S/.test(line)) { out.push(`<br>${inline(line.trim())}`); continue } // continues the item
    closeLists()
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue }
    if ((m = line.match(/^\s*#{1,6}\s+(.*?)(?:\s+#+)?\s*$/))) { flush(); out.push(`<h3>${inline(m[1])}</h3>`); continue }
    if (/^\s*\|/.test(line) && TABLE_SEP.test(lines[i + 1] ?? '')) {
      flush()
      const head = line, sep = lines[++i], rows: string[] = []
      while (/^\s*\|/.test(lines[i + 1] ?? '')) rows.push(lines[++i])
      out.push(table(head, sep, rows))
      continue
    }
    if ((m = line.match(/^\s*>\s?(.*)$/))) {
      flush()
      const q = [m[1]]
      while ((m = (lines[i + 1] ?? '').match(/^\s*>\s?(.*)$/))) { q.push(m[1]); i++ }
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`)
      continue
    }
    para.push(line.trim())
  }
  flush(); closeLists()
  return `<div class="md">${out.join('')}</div>`
}
