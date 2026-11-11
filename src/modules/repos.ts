// E2 · Git state of the repos in data/config.json (each app's, then the extra ones): branch, uncommitted files, stash,
// ahead/behind, last commit, version numbers. Read-only.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { APPS, REPOS } from '../config.ts'
import { ago, cut, empty, esc, num, section, stale } from '../core/html.ts'
import { NotConfigured, type Module } from '../core/types.ts'

const run = promisify(execFile)

export function parseStatus(out: string) {
  const lines = out.split('\n').filter(Boolean)
  const ab = lines.find(l => l.startsWith('# branch.ab '))?.match(/\+(\d+) -(\d+)/)
  return {
    branch: lines.find(l => l.startsWith('# branch.head '))?.slice(14) ?? '?',
    ahead: ab ? Number(ab[1]) : null,
    behind: ab ? Number(ab[2]) : null,
    dirty: lines.filter(l => !l.startsWith('#')).length,
  }
}

export function gradleVersion(src: string) {
  // build.gradle.kts writes `versionCode = 24`, Groovy build.gradle writes `versionCode 165`
  return {
    code: src.match(/versionCode\s*=?\s*(\d+)/)?.[1] ?? null,
    name: src.match(/versionName\s*=?\s*"([^"]+)"/)?.[1] ?? null,
  }
}

export function pbxVersion(src: string, plist: string) {
  // project.pbxproj holds one buildSettings block per target × config; the app's blocks are the ones
  // naming its own Info.plist (Brainova also has a StreakWidget target with other numbers).
  for (const block of src.split('buildSettings = {').slice(1)) {
    const b = block.split(/\n\t*\};/)[0]
    if (!b.includes(`INFOPLIST_FILE = ${plist};`)) continue
    return {
      name: b.match(/MARKETING_VERSION = ([^;]+);/)?.[1] ?? null,
      code: b.match(/CURRENT_PROJECT_VERSION = ([^;]+);/)?.[1] ?? null,
    }
  }
  return null
}

async function git(dir: string, signal: AbortSignal, ...args: string[]) {
  // LOAD-BEARING: --no-optional-locks. Several agent sessions share these working trees; a plain
  // `git status` takes index.lock and makes their commits fail.
  return (await run('git', ['-C', dir, '--no-optional-locks', ...args], { encoding: 'utf8', timeout: 15_000, signal })).stdout
}

type Version = { code: string | null; name: string | null }
// missing: the folder is not there (a repo this person has not cloned): its row says so, it is not a failure
export type RepoRow = { key: string; name: string; error?: string; missing?: boolean; branch?: string; ahead?: number | null; behind?: number | null; dirty?: number
  stash?: number; last?: { hash: string; at: number; subject: string }; fetchedAt?: number | null; android?: Version | null; ios?: Version | null }

// A table from 48rem (name, branch and versions in the first cell, so the commit gets the width); below,
// each repo restacks into a block: name and branch with the versions at the right, the counts as words, the commit.
const CSS = String.raw`
.repos-wrap { overflow-x: auto; overscroll-behavior-x: contain; min-width: 0 }
.repos-table th[scope=row] { font-weight: 400; white-space: normal; min-width: 7.5rem }
.repos-id { display: block; min-width: 0 }
.repos-id b { font-weight: 600; color: var(--ink) }
.repos-branch { display: block; font: 400 var(--text-xs)/1.4 var(--mono); color: var(--muted); overflow-wrap: anywhere; margin-top: var(--space-3xs) }
.repos-ver { display: flex; flex-wrap: wrap; gap: var(--space-2xs); margin-top: var(--space-xs) }
.repos-zero { color: var(--muted) }
.repos-commit { white-space: normal; min-width: 11rem; overflow-wrap: anywhere }
.repos-commit .tag { margin-right: var(--space-2xs) }
.repos-meta { display: flex; flex-wrap: wrap; gap: 0 var(--space-sm); margin-top: var(--space-3xs); font-size: var(--text-xs); color: var(--muted) }
.repos-err { white-space: normal; overflow-wrap: anywhere }
@media (max-width: 47.99rem) {
  .repos-table, .repos-table tbody { display: block }
  .repos-table thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%) }
  .repos-table tr { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2xs) var(--space-md); padding: var(--space-sm) 0; border-top: 1px solid var(--rule) }
  .repos-table tr:first-child { border-top: 0; padding-top: 0 }
  .repos-table tr:last-child { padding-bottom: 0 }
  .repos-table tr > * { padding: 0; border: 0; background: none }
  .repos-table th[scope=row] { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--space-2xs) var(--space-sm); min-width: 0 }
  .repos-id { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--space-xs) }
  .repos-id b { font-size: var(--text-md) }
  .repos-branch, .repos-ver { margin: 0 }
  .repos-ver { justify-content: flex-end; margin-left: auto }
  .repos-table td.num { text-align: left }
  .repos-table td[data-label]::after { content: " " attr(data-label); color: var(--muted); font-weight: 400 }
  .repos-table .repos-even { display: none }
  .repos-table .repos-commit, .repos-table .repos-err { flex-basis: 100%; min-width: 0 }
}
`

export const repos: Module<RepoRow[]> = {
  id: 'repos', title: 'Repo', group: 'ops', every: 60, timeout: 30, css: CSS,

  async collect({ signal }) {
    if (!REPOS.length) throw new NotConfigured('chưa có repo nào trong data/config.json (repo của app, hoặc repos)')
    const out = await Promise.all(REPOS.map(async (r): Promise<RepoRow> => {
      const app = APPS.find(a => a.key === r.key)
      if (!existsSync(r.repo)) return { key: r.key, name: r.name, missing: true, error: `không thấy thư mục ${r.repo}` }
      try {
        const [status, stash, log, gitDir] = await Promise.all([
          git(r.repo, signal, 'status', '--porcelain=v2', '--branch'),
          git(r.repo, signal, 'stash', 'list'),
          git(r.repo, signal, 'log', '-1', '--format=%h%x00%ct%x00%s'),
          git(r.repo, signal, 'rev-parse', '--absolute-git-dir'),
        ])
        const [hash, ct, subject] = log.trim().split('\0')
        const fetchHead = join(gitDir.trim(), 'FETCH_HEAD')
        return {
          key: r.key, name: r.name, ...parseStatus(status),
          stash: stash.split('\n').filter(Boolean).length,
          last: { hash, at: Number(ct) * 1000, subject },
          fetchedAt: existsSync(fetchHead) ? statSync(fetchHead).mtimeMs : null,
          android: app?.gradle ? gradleVersion(readFileSync(join(r.repo, app.gradle), 'utf8')) : null,
          ios: app?.pbxproj && app.infoPlist ? pbxVersion(readFileSync(join(r.repo, app.pbxproj), 'utf8'), app.infoPlist) : null,
        }
      } catch (e) {
        return { key: r.key, name: r.name, error: (e as Error).message.split('\n')[0] }
      }
    }))
    const there = out.filter(r => !r.missing)
    if (there.length && there.every(r => r.error)) throw new Error(there[0].error!) // every repo failed: keep the old numbers, raise the alert
    return out
  },

  panel(s, v) {
    const o = { span: 2 as const, cls: 'repos' }
    if (!s?.data) return section(this.title, empty('Đang lấy lần đầu…'), '', 'repos', o)
    const rows = s.data.map(r => {
      const ver = [r.android?.code ? `${r.android.name} (${r.android.code})` : '', r.ios?.code ? `iOS ${r.ios.name} (${r.ios.code})` : '']
        .filter(Boolean).map(x => `<span class="tag">${esc(x)}</span>`).join('')
      const name = `<th scope="row"><span class="repos-id"><b>${esc(r.name)}</b>${r.branch ? `<span class="repos-branch">${esc(r.branch)}</span>` : ''}</span>${ver ? `<span class="repos-ver">${ver}</span>` : ''}</th>`
      if (r.error) return `<tr>${name}<td colspan="4" class="repos-err ${r.missing ? 'muted' : 'bad-t'}">${esc(cut(r.error, 160))}</td></tr>`
      const even = !r.ahead && !r.behind
      return `<tr>${name}
        <td class="num ${r.dirty ? 'warn-t' : 'repos-zero'}" data-label="chưa commit">${num(r.dirty)}</td>
        <td class="num ${r.stash ? '' : 'repos-zero'}" data-label="stash">${num(r.stash)}</td>
        <td class="num${even ? ' repos-zero repos-even' : ''}" data-label="push/pull">${even ? '—' : `↑${r.ahead ?? '?'} ↓${r.behind ?? '?'}`}</td>
        <td class="repos-commit"><span class="tag">${esc(r.last?.hash)}</span>${esc(cut(r.last?.subject, 90))}
          <div class="repos-meta"><span>${esc(ago(r.last?.at, v.now))}</span>${r.fetchedAt ? `<span>fetch ${esc(ago(r.fetchedAt, v.now))}</span>` : ''}</div></td></tr>`
    }).join('')
    return section(this.title, `${stale(s, v.now)}<div class="repos-wrap"><table class="repos-table"><thead><tr><th>Repo, version</th><th class="num">Chưa commit</th><th class="num">Stash</th><th class="num">Push/pull</th><th>Commit cuối</th></tr></thead><tbody>${rows}</tbody></table></div>`,
      'Push/pull tính đến lần fetch cuối; hub không tự fetch', 'repos', o)
  },
}
