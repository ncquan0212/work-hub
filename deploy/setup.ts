// npm run setup: checks what this copy needs, fills the service templates for this OS (deploy/<os>/) into
// data/deploy/ and PRINTS the commands that install them. It never runs them: installing services is the person's own
// call (AGENTS.md). Zero dependencies; it runs no program, it only reads files and writes data/deploy/.
// Steps and checks: docs/setup.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const OUT = join(REPO, 'data', 'deploy') // the services run without HUB_DATA, so their data/ is this one
const OS = ({ darwin: 'macos', linux: 'linux', win32: 'windows' } as Record<string, string>)[process.platform]
const win = process.platform === 'win32'
const q = (p: string) => `"${p}"`

const say = (mark: 'ok' | '!!' | '--', what: string, fix = '') => console.log(`[${mark}] ${what}${fix ? `\n       ${fix}` : ''}`)

// on PATH, as the services will see it (they get the same PATH); read only, nothing is run
const which = (name: string) => (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  .flatMap(d => (win ? ['.exe', '.cmd', ''] : ['']).map(x => join(d, name + x))).find(f => existsSync(f))

console.log(`work-hub ở ${REPO}\n`)

// the services run the node on PATH: Homebrew's /opt/homebrew/bin/node survives an upgrade, execPath (its versioned
// Cellar folder) does not
const NODE = which('node') ?? process.execPath
const nodeOk = Number(process.versions.node.split('.')[0]) >= 26
say(nodeOk ? 'ok' : '!!', `Node ${process.versions.node} (${NODE})`, nodeOk ? '' : 'Cần Node ≥ 26 (docs/setup.md bước 2), rồi chạy lại npm run setup.')

const git = which('git')
say(git ? 'ok' : '!!', git ? `git: ${git}` : 'git: không thấy trên PATH', git ? '' : 'Cài git (docs/setup.md bước 1).')

// the runner looks in CLAUDE_BIN, then ~/.local/bin, then PATH (src/runner/main.ts)
const claude = process.env.CLAUDE_BIN || [join(homedir(), '.local', 'bin', win ? 'claude.exe' : 'claude')].find(existsSync) || which('claude')
if (!claude) say('!!', 'claude: không thấy', 'Chỉ trang Develop cần: cài Claude Code rồi đăng nhập (docs/setup.md bước 9). Các trang khác vẫn chạy.')
else if (win && claude.endsWith('.cmd')) say('!!', `claude: ${claude} là bản cài qua npm`, 'Runner chỉ chạy được claude.exe (bản cài native) trên Windows.')
else say('ok', `claude: ${claude}`)

const config = join(REPO, 'data', 'config.json')
if (!existsSync(config)) {
  say('!!', 'data/config.json chưa có: hub chạy được nhưng không theo app nào',
    `Chép mẫu rồi điền theo docs/config.md: ${win ? 'mkdir -Force data; copy config.example.json data\\config.json' : 'mkdir -p data && cp config.example.json data/config.json'}`)
} else {
  try {
    const c = await import('../src/config.ts') // validates the file the way the hub will
    say('ok', `data/config.json: ${c.APPS.length} app, ${c.REPOS.length} repo; module: ${[...c.ENABLED].join(', ')}`)
    if (!c.ENABLED.has('develop')) say('--', 'module develop tắt: không cần cài runner (runner tự thoát ngay)')
    say('--', c.ACCESS.tailnetHost ? `mở hub: http://127.0.0.1:${c.PORT} và https://${c.ACCESS.tailnetHost}` : `mở hub: http://127.0.0.1:${c.PORT} (chỉ trên máy này: access.tailnetHost trống)`)
  } catch (e) { say('!!', (e as Error).message, 'Sửa data/config.json theo docs/config.md.') }
}

if (!OS) { console.log(`\nChưa có mẫu service cho ${process.platform}: chạy tay npm start và npm run runner.`); process.exit(1) }
if (!nodeOk) process.exit(1) // the services would run this old node: its path goes into them

// fill deploy/<os>/* → data/deploy/: absolute paths, since launchd, systemd and Task Scheduler expand no ~ or $HOME
const values: Record<string, string> = {
  __HOME__: homedir(),
  __REPO__: REPO,
  __NODE__: NODE,
  // your shell's PATH minus what npm adds while it runs this script (node_modules/.bin, node-gyp-bin)
  __PATH__: [...new Set((process.env.PATH ?? '').split(delimiter).filter(d => d && !d.includes('node_modules')))].join(delimiter),
  __USER__: win ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : '',
}
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
mkdirSync(OUT, { recursive: true })
const files = readdirSync(join(REPO, 'deploy', OS))
for (const f of files) {
  const isXml = /\.(plist|xml)$/.test(f)
  const text = readFileSync(join(REPO, 'deploy', OS, f), 'utf8').replace(/__(HOME|REPO|NODE|PATH|USER)__/g, k => isXml ? xml(values[k]) : values[k])
  // schtasks reads a task file in the encoding its XML declaration names: UTF-16 with a BOM, as Task Scheduler exports
  writeFileSync(join(OUT, f), f.endsWith('.xml') ? Buffer.from('\ufeff' + text, 'utf16le') : text)
}
console.log(`\nĐã điền ${files.join(', ')} vào ${OUT}.`)
console.log('Lệnh cài chạy nền dưới đây là việc của bạn: đọc rồi tự dán (setup không tự chạy).\n')

const out = (p: string) => q(join(OUT, p))
if (OS === 'macos') {
  console.log(`Cài (launchd, chạy khi bạn đăng nhập vào máy):
  cp ${out('com.work-hub.plist')} ${out('com.work-hub.runner.plist')} ~/Library/LaunchAgents/
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.work-hub.plist
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.work-hub.runner.plist
  (đã cài trước đó: chạy launchctl bootout gui/$(id -u)/com.work-hub và gui/$(id -u)/com.work-hub.runner trước)
Kiểm:
  launchctl print gui/$(id -u)/com.work-hub | grep -E '^\\s+(state|pid)'
  curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8787/      → 200
Khởi động lại (sau git pull):
  launchctl kickstart -k gui/$(id -u)/com.work-hub; launchctl kickstart -k gui/$(id -u)/com.work-hub.runner
Log: ~/Library/Logs/work-hub.log, ~/Library/Logs/work-hub-runner.log`)
} else if (OS === 'linux') {
  console.log(`Cài (systemd --user):
  mkdir -p ~/.config/systemd/user
  cp ${out('work-hub.service')} ${out('work-hub-runner.service')} ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable --now work-hub work-hub-runner
  loginctl enable-linger "$USER"     # tuỳ chọn: chạy từ lúc bật máy, cả khi bạn chưa đăng nhập hay đã đăng xuất
Kiểm:
  systemctl --user status work-hub work-hub-runner
  curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8787/      → 200
Khởi động lại (sau git pull):
  systemctl --user restart work-hub work-hub-runner
Log: journalctl --user -u work-hub -f   (runner: -u work-hub-runner)`)
} else {
  const stop = (pat: string) => `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*${pat}*' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
  console.log(`Cài (Task Scheduler, chạy khi bạn đăng nhập; CHƯA THỬ trên máy Windows nào, xem docs/setup.md):
  schtasks /Create /F /TN work-hub /XML ${out('work-hub.xml')}
  schtasks /Create /F /TN work-hub-runner /XML ${out('work-hub-runner.xml')}
  schtasks /Run /TN work-hub
  schtasks /Run /TN work-hub-runner
Kiểm:
  schtasks /Query /TN work-hub
  curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:8787/      → 200
Khởi động lại (sau git pull), trong PowerShell:
  ${stop('src\\main.ts')}
  ${stop('src\\runner\\main.ts')}
  schtasks /Run /TN work-hub
  schtasks /Run /TN work-hub-runner
Log: data\\work-hub.log, data\\work-hub-runner.log`)
}
console.log(`
Tuỳ chọn, mở hub cho điện thoại và máy khác của bạn qua Tailscale (docs/setup.md bước 10):
  tailscale serve --bg 8787
  rồi điền access.tailnetHost và access.devices trong data/config.json (docs/config.md) và khởi động lại hub.`)
