# Cài work-hub

Viết cho hai người đọc cùng lúc: bạn, và AI bạn nhờ cài. Mỗi bước có lệnh, lệnh kiểm, kết quả mong đợi và **ai làm**:
- **AI làm được:** AI chạy lệnh rồi chạy lệnh kiểm.
- **Bạn tự làm:** việc cần mật khẩu, đăng nhập, bấm trong trình duyệt, hay cài service chạy nền. AI dừng lại, đưa bạn lệnh
  hoặc chỉ dẫn, chờ bạn báo xong rồi mới chạy lệnh kiểm.

**Dặn AI:**
- Lệnh chạy ở thư mục repo, trừ khi ghi khác. Windows: lệnh viết cho PowerShell.
- Không ghi token hay mật khẩu vào `data/config.json`, không in nội dung `.env`, `~/.claude.json` hay file key ra màn hình.
- Không chạy `npm run once`, `npm run report:backfill`, `npm run track:backfill`: đó là lần gọi thật tới nguồn,
  Databuckets mỗi lần khoảng 100 giây và được lưu bên họ.
- Không tự cài service chạy nền, không tự chạy `tailscale serve`: in lệnh cho người dùng.
- Bước 5 tới 10 là tuỳ chọn: hỏi người dùng cần trang nào rồi chỉ làm bước tương ứng (bảng module ở `docs/config.md`).

## 1. Lấy code

**Ai làm:** AI làm được, nếu máy đã đăng nhập GitHub có quyền đọc repo (SSH key hoặc credential của git). Chưa có thì bạn tự
đăng nhập GitHub trước.

| | macOS, Ubuntu | Windows |
|---|---|---|
| Cài git (nếu thiếu) | macOS: `xcode-select --install` (bạn bấm Cài trong hộp thoại). Ubuntu: `sudo apt install -y git` (bạn gõ mật khẩu) | `winget install --id Git.Git -e` |
| Lệnh | `git clone https://github.com/ncquan0212/work-hub.git ~/Code/work-hub` | `git clone https://github.com/ncquan0212/work-hub.git $HOME\Code\work-hub` |
| Kiểm | `git -C ~/Code/work-hub log -1 --oneline` | `git -C $HOME\Code\work-hub log -1 --oneline` |

Mong đợi: một dòng commit. URL repo: owner gửi. Đặt ở thư mục khác cũng được.

## 2. Node ≥ 26

**Ai làm:** AI làm được; lệnh có `sudo` thì bạn gõ mật khẩu.

- macOS: `brew install node`
- Ubuntu: `curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash - && sudo apt install -y nodejs`
- Windows: `winget install OpenJS.NodeJS.LTS`, rồi mở terminal mới

Kiểm: `node --version`. Mong đợi: `v26` trở lên. Thấp hơn thì cài bản 26 từ nodejs.org.

## 3. Gói cho việc kiểm tra code

**Ai làm:** AI.

Lệnh: `npm install`. Chỉ cài `typescript` và `@types/node` cho `npm run check`; hub chạy không cần gói nào.
Kiểm: `npx tsc --version`. Mong đợi: một số phiên bản.

## 4. Config riêng: `data/config.json`

**Ai làm:** AI đề xuất, **bạn xác nhận** trước khi ghi.

| | Lệnh |
|---|---|
| macOS, Ubuntu | `mkdir -p data && cp config.example.json data/config.json` |
| Windows | `mkdir -Force data; copy config.example.json data\config.json` |

Rồi:
1. AI hỏi bạn đường dẫn các repo app và repo khác bạn muốn hub theo.
2. AI đọc các repo đó theo `docs/config.md` (mục "Dành cho AI") và đề xuất `apps`, `repos`, `modules`.
3. AI cho bạn xem nguyên đoạn JSON. Bạn đồng ý thì AI mới ghi.
4. **Xoá app mẫu `myapp` và repo mẫu `tools`** của file mẫu. Chưa theo app nào thì để `"apps": []`.

Kiểm: `npm run setup`. Mong đợi: `[ok] data/config.json: N app, M repo; module: …`. Lỗi JSON hay thiếu trường thì dòng
đó ghi `[!!]` kèm lý do.

## 5. Databuckets (Report, Theo dõi) — tuỳ chọn

**Ai làm:** bạn tự làm phần token; AI ghi tên dataset. URL, token và tên dataset: xin người quản lý Databuckets của team.

AI thêm `"databucketsDataset": "<tên dataset>"` vào `data/config.json`; thiếu nó thì hub không gọi Databuckets.

Chọn một trong hai cách:
- **Bạn dùng Claude Code:** thêm MCP ở scope user, header tĩnh, tên đúng là `databuckets`:
  `claude mcp add --transport http --scope user databuckets <URL> --header "Authorization: Bearer <token>"`.
  Hub đọc token tại chỗ trong `~/.claude.json`.
- **AI khác:** thêm vào `.env` hai dòng `DATABUCKETS_URL=<URL>` và `DATABUCKETS_TOKEN=<token>`
  (mẫu: `.env.example`; macOS, Ubuntu: `chmod 600 .env`).

Kiểm (không gọi Databuckets, không in token):
`node -e "const c=require(require('os').homedir()+'/.claude.json').mcpServers?.databuckets; console.log(c?.url ? 'có MCP databuckets' : 'chưa có')"`,
hoặc thấy hai tên biến trong `.env`. Đừng gọi thử: mỗi lần gọi khoảng 100 giây và được lưu bên Databuckets.

## 6. Crashlytics và Remote Config — tuỳ chọn

**Ai làm:** bạn tự làm phần đăng nhập và file key; AI điền config.

- **Crashlytics** (panel Crash 24h ở Vận hành, số crash trong Report và Theo dõi): `npx firebase-tools login`, đăng nhập bằng tài
  khoản Google có quyền xem các project Firebase. Mỗi app cần `appId` trong config.
  Kiểm: `npx firebase-tools projects:list`. Mong đợi: thấy project của các app.
- **Remote Config** (panel Remote Config ở Vận hành, mốc RC trong Report, gợi ý A/B): file key service account đã có của team, mỗi app một file,
  đặt trong `rcKeyDir` (mặc định `~/Code/tv-rc`), tên file ghi vào `rcKey` của app. Không tạo service account mới, không
  chép key vào repo. Kiểm: `ls ~/Code/tv-rc` (Windows: `dir $HOME\Code\tv-rc`). Mong đợi: thấy tên các file key.

## 7. Jira — tuỳ chọn

**Ai làm:** bạn tạo token và ghi vào `.env`; AI bật module.

1. Bạn tạo Personal Access Token trong trang hồ sơ Jira (Profile → Personal Access Tokens).
2. Bạn thêm `JIRA_PAT=<token>` vào `.env` (macOS, Ubuntu: `chmod 600 .env`). Không dán token vào chat với AI.
3. AI thêm `"jira"` vào `modules` và `"jiraHost": "https://<địa chỉ Jira của công ty>"` vào `data/config.json` (hỏi bạn địa chỉ).

Không có PAT thì jira đọc qua extension (bước 8). Kiểm sau bước 11: panel Jira ở trang Develop hiện issue của bạn.
Báo "Jira coi PAT là khách (anonymous)" là token sai hay hết hạn (Jira vẫn trả 200 với token sai, xem `docs/sources.md`).

## 8. Extension Chrome (Gmail, Play Console, AdMob) — tuỳ chọn

**Ai làm:** AI build và sửa config; **bạn tự nạp** extension vào Chrome.

1. AI thêm vào `modules` những gì bạn cần: `bridge` (bắt buộc), `gmail`, `consoles`, `jira`. Thêm `chromeProfiles` và
   `chromeDomains` cho từng vai trò bạn có (`docs/config.md`); `jiraHost` nếu đọc Jira qua extension.
2. AI chạy `npm run bridge:extension`. Mong đợi: in ra đường dẫn `data/extension`. Mỗi bản hub có khoá riêng, không dùng
   extension của người khác.
3. Bạn mở từng profile Chrome cần dùng: `chrome://extensions` → bật Developer mode → Load unpacked → chọn thư mục
   `data/extension`. Profile phải đăng nhập Chrome bằng tài khoản công ty hoặc tài khoản hộp thư publisher: extension
   nhận vai trò theo tài khoản đó.
4. Để mỗi profile mở ít nhất một cửa sổ Chrome.

Kiểm sau bước 11: trang Vận hành, panel "Trình duyệt (extension)", mỗi profile hiện "đang kết nối".

## 9. Claude Code (trang Develop)

**Ai làm:** AI cài; **bạn tự đăng nhập**.

- macOS, Ubuntu: `curl -fsSL https://claude.ai/install.sh | bash`
- Windows: `irm https://claude.ai/install.ps1 | iex` (bản native `claude.exe`; bản cài qua npm không chạy được với runner)

Bạn chạy `claude` một lần và đăng nhập. Kiểm: `claude --version`. Mong đợi: một số phiên bản.

Task Develop chạy trong các repo của `apps` và `repos` trong config. Dùng AI khác cho Develop: `docs/architecture.md`
mục "Đổi AI".

## 10. Tailscale: mở hub từ điện thoại và máy khác — tuỳ chọn

**Ai làm:** bạn tự làm phần Tailscale; AI điền config.

1. Bạn cài Tailscale, đăng nhập, bật HTTPS cho tailnet (trang admin của Tailscale → DNS → HTTPS Certificates).
2. Bạn chạy `tailscale serve --bg 8787` (Ubuntu, và macOS khi cài bằng Homebrew: thêm `sudo`).
3. AI điền `access.tailnetHost` và `access.devices` theo `docs/config.md`, rồi khởi động lại hub.

Kiểm: mở `https://<tailnetHost>` trên điện thoại. Mong đợi: trang Hôm nay. Máy không có trong `access.devices` bị chặn
(403). Thông báo đẩy trên điện thoại cần đường HTTPS này.

## 11. Chạy thử hub

**Ai làm:** AI.

> **Lưu ý trước khi chạy:** nếu config có app và đã có token Databuckets, lần chạy đầu gọi Databuckets **ngay**:
> `report` 4 lần, `track` 1 lần (D0), mỗi lần khoảng 100 giây, được lưu bên Databuckets. Hub không bao giờ tự gọi lại
> một lần gọi lỗi. Chưa muốn gọi thì bỏ cả `report` lẫn `track` khỏi `modules` trước.

Lệnh: `npm start` (chạy ở cửa sổ này; Ctrl+C để dừng).
Kiểm (cửa sổ khác): `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/` (Windows: `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:8787/`).
Mong đợi: `200`. Mở `http://127.0.0.1:8787` trong trình duyệt: trang Hôm nay. Phần chưa cấu hình hiện "chưa cấu hình".

## 12. Chạy thử runner (Develop)

**Ai làm:** AI chạy runner; bạn tạo task thử.

Lệnh (cửa sổ khác, hub vẫn chạy): `npm run runner`. Bạn tạo một task nhỏ ở `/develop`, ví dụ "Đọc README rồi tóm tắt".
Mong đợi: vài chục giây sau task có tin trả lời. Mỗi lượt tốn hạn mức Claude của bạn. Dừng runner (Ctrl+C) trước bước 13:
mỗi lúc chỉ một runner chạy.

## 13. Chạy nền

**Ai làm:** AI chạy `npm run setup`; **bạn tự dán** các lệnh cài nó in ra.

`npm run setup` kiểm lại mọi thứ ở trên, điền mẫu service cho hệ điều hành này (`deploy/<os>/`) vào `data/deploy/`, rồi
in lệnh cài, lệnh kiểm, lệnh khởi động lại và chỗ xem log. Nó không tự cài gì.

| | Chạy bằng | Ghi chú |
|---|---|---|
| macOS | launchd (`~/Library/LaunchAgents`) | Chạy khi bạn đã đăng nhập vào máy. Hub giữ máy không tự ngủ khi rảnh (`caffeinate -i`); không muốn thì bỏ phần đó trong file plist đã điền |
| Ubuntu | systemd `--user` | `loginctl enable-linger` để chạy cả khi bạn chưa đăng nhập |
| Windows | Task Scheduler, lúc đăng nhập | **Chưa thử trên máy Windows nào:** cửa sổ console có ẩn không, tự chạy lại khi lỗi có chạy không. Thấy lạ thì báo trong PR |

Dừng hub và runner chạy tay (bước 11, 12) trước khi cài. Kiểm: lệnh kiểm `npm run setup` in ra, mong đợi `200`.

**Sau mỗi lần `git pull`** phải khởi động lại cả hub lẫn runner: `npm run setup` in sẵn lệnh. Đổi `data/config.json` hay
`.env` thì cũng khởi động lại.

## 14. Kiểm tra code (khi bạn sửa code)

**Ai làm:** AI.

Lệnh: `npm run check` (tsc và test). Mong đợi: không lỗi. Test dùng `test/fixtures/config.json`, không gọi nguồn nào.
Phải đạt trước khi mở PR.

## An toàn

- **Chỉ trên máy này theo mặc định:** hub nghe `127.0.0.1`, từ chối Host lạ. Ra tailnet chỉ khi có `access.tailnetHost`,
  và chỉ các máy trong `access.devices`.
- **Task Develop có full quyền trong repo của bạn:** auto mode của Claude Code, mọi MCP, mọi lệnh. Luật deny chặn: `git push`,
  lệnh git xoá việc chưa commit (`stash`, `reset --hard`, `clean`…), đọc file bí mật và `data/` của hub; lượt trao đổi
  không sửa được file. Chữ lấy từ Jira hay mail là dữ liệu không tin cậy: đọc kỹ trước khi bấm duyệt.
- **Bí mật:** token ở `.env` và khoá hub tự tạo trong `data/` (`bridge.key`, `csrf.secret`, `vapid.json`) không bao giờ vào git,
  không chép đi chỗ khác.
- **Module chưa cấu hình** hiện "chưa cấu hình", không báo lỗi và không gửi thông báo lỗi.
