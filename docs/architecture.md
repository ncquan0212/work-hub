# work-hub: kiến trúc

Tài liệu này dành cho agent (hoặc người) cần thêm, sửa hay xoá một phần của hub. Quyết định kỹ thuật (`Dxx`):
[decisions.md](decisions.md). Nguồn dữ liệu: [sources.md](sources.md). Config riêng: [config.md](config.md).

## Hai service, một file dữ liệu

| Service | Chạy | Việc | Mẫu chạy nền (macOS, Ubuntu, Windows) |
|---|---|---|---|
| **hub** | `node src/main.ts` | Lấy số theo lịch, phục vụ trang web (127.0.0.1:8787) và cầu nối cho extension (127.0.0.1:8788) | `deploy/macos/com.work-hub.plist`, `deploy/linux/work-hub.service`, `deploy/windows/work-hub.xml` |
| **runner** | `node src/runner/main.ts` | Chạy các lượt AI của bảng Develop (`claude -p`) | `deploy/macos/com.work-hub.runner.plist`, `deploy/linux/work-hub-runner.service`, `deploy/windows/work-hub-runner.xml` |

`npm run setup` (`deploy/setup.ts`) điền đường dẫn của máy vào các mẫu đó, ghi ra `data/deploy/` và in lệnh cài; người
dùng tự dán lệnh. Runner không nạp `.env`, nên token của hub không tới được task.

Hai service chỉ nói chuyện với nhau qua `data/hub.db` (SQLite, chế độ WAL) và các file ảnh trong `data/develop-files/` mà bảng `develop_files` trỏ tới (hub ghi, runner đọc). Vì vậy khởi động lại hub
không làm đứt lượt Claude đang chạy.

Chỉ cổng 8787 được đưa ra tailnet qua `tailscale serve`. Cổng 8788 chỉ cho extension trên chính máy
này dùng.

## Config riêng của từng bản

Mỗi người chạy bản hub của mình. Những gì khác nhau giữa các bản nằm trong `data/config.json` (gitignore; `HUB_CONFIG`
đổi đường dẫn), đọc **một lần** lúc khởi động bởi `src/config.ts`, chỗ duy nhất module đọc config. Các trường:
[config.md](config.md).
- **Module bật:** `ENABLED` (trường `modules`, không có thì `DEFAULT_MODULES`). `main.ts` lọc một lần, trước `init`, lịch
  chạy, `once` và server, nên module tắt không tạo bảng, không chạy, không có route. Runner tự thoát khi `develop` tắt.
  Module tắt giữ slot cũ trong snapshot, nên bật lại không chạy ngay collector theo ngày.
- **Chưa cấu hình:** collector thiếu thứ nó cần (không có app, chưa đăng nhập, thiếu file key, thiếu profile Chrome cho
  vai trò) thì ném `NotConfigured` (`src/core/types.ts`) với lời nói rõ cần làm gì. Panel hiện "chưa cấu hình"; bộ lập
  lịch không tính là lỗi, nên không có thông báo "lỗi hai lần liền".
- **Chỉ số theo app** (Report, Theo dõi) nằm trong code, theo khoá app. `idol`, `brain`, `xremote`, `xcast` là khoá cố định;
  app khác có chỉ số chung, thêm chỉ số riêng qua PR.
- **Giá trị cấp công ty** để chung trong code: host Jira, bảng domain → vai trò profile của extension, danh sách URL extension
  được đọc. Dataset Databuckets là mặc định, config ghi đè được.

## Module

Mỗi phần của hub là **một module**. Một module là một object `Module` (xem `src/core/types.ts`), nằm
trong `src/modules/<id>.ts` hoặc thư mục `src/modules/<id>/`, và có **một dòng** đăng ký trong
`src/registry.ts`. Core (bộ lập lịch, server, các trang) không biết gì về từng module cụ thể.

Một module khai báo những gì nó cần:

| Trường | Dùng để |
|---|---|
| `id`, `title`, `group` | Khoá trong snapshot, tiêu đề panel, nhóm menu (develop, report, track, ops, feedback) |
| `every` hoặc `daily` + `collect(ctx)` | Lấy số theo lịch. `ctx.signal` bị huỷ khi quá `timeout`; truyền nó vào `fetch` và `execFile` |
| `init(db)` | Tạo bảng riêng, đặt tên `<id>_…` |
| `start(db)` | Chỉ chạy khi serve: dịch vụ riêng của module (ví dụ cổng cầu nối 8788) |
| `panel(slot, view)` | Phần hiện trên trang của nhóm |
| `today`, `alerts`, `waiting` | Góp vào trang Hôm nay: khối tóm tắt, mục "Cần để ý", mục "Đang chờ bạn" |
| `routes` | Trang chi tiết và form. Đường dẫn phải bắt đầu bằng `/<group>/` |
| `css` | CSS riêng của module, selector bắt đầu bằng class mang id module; xem [ui.md](ui.md) |

Core bảo đảm:
- Một module lỗi hoặc treo không ảnh hưởng module khác.
- Lần chạy lỗi vẫn giữ số cũ và ghi rõ số đó từ lúc nào.
- Một lỗi khi render chỉ làm hỏng đúng panel đó.

**Thêm một phần:**
1. Viết file module.
2. Thêm một dòng vào `registry.ts`.
3. Viết test cho phần logic thuần (parser, công thức).

**Xoá một phần:**
1. Xoá dòng trong `registry.ts` và file module.
2. Dữ liệu cũ trong snapshot tự bị bỏ.
3. Bảng `<id>_…` trong SQLite còn đó nhưng không ai dùng; xoá tay nếu muốn.

**Phụ thuộc giữa các module** chỉ được ở dạng "mềm": đọc kết quả của module khác qua `view.slot('<id>')`,
và vẫn phải chạy đúng khi module kia không có. Hiện có 2 chỗ:
- Report lấy mốc release từ `track`.
- market-tool lấy số file chưa commit từ `repos`.

Không module nào import file của module khác. Code mà hai module cùng dùng phải nằm trong `src/lib/`.

Phụ thuộc lúc chạy duy nhất: `gmail`, `consoles` và `jira` (khi không có PAT) cần module `bridge`, vì cổng
8788 cho extension do module này mở. Bỏ `bridge` thì ba module kia báo "extension chưa kết nối".

Code dùng chung nằm trong `src/lib/`:

| File | Nội dung |
|---|---|
| `google.ts` | Token từ credential có sẵn |
| `crashlytics.ts` | Gọi Crashlytics |
| `databuckets.ts` | Client MCP và kiểm EQL |
| `bridge.ts` | Hàng đợi việc gửi cho extension |
| `days.ts` | Ngày UTC, đọc nhãn bucket của Databuckets |
| `stats.ts` | MA, kiểm định thống kê |
| `svg.ts` | Biểu đồ |

## Danh sách module

| Nhóm | Module | Nguồn | Lịch | Mặc định |
|---|---|---|---|---|
| Develop | `develop` | Bảng task (SQLite), runner | Theo thao tác của người dùng | Bật |
| Develop | `jira` | Jira REST, qua PAT (`JIRA_PAT`) hoặc qua extension | 5 phút | Tắt |
| Report | `report` | Databuckets (4 lần gọi), Crashlytics theo ngày, các mốc RC | 07:05 (ngày UTC trọn lúc 07:00 giờ VN) | Bật |
| Theo dõi | `track` | Databuckets, điều kiện RC, Crashlytics theo version, Play Console qua extension | 30 phút, mỗi phần một đồng hồ | Bật |
| Vận hành | `agents` | Transcript Claude Code | 60 giây | Bật |
| Vận hành | `repos` | git (`--no-optional-locks`) | 60 giây | Bật |
| Vận hành | `crash` | Crashlytics 24h | 30 phút | Bật |
| Vận hành | `rc` | Remote Config: version và tham số vừa đổi | 15 phút | Bật |
| Vận hành | `market` | Log, state.db và launchd của market-tool (chỉ máy owner) | 60 giây | Tắt |
| Vận hành | `consoles` | Play Console vitals và AdMob, đọc trang qua extension | 07:05, cùng giờ Report | Tắt |
| Vận hành | `bridge` | Trạng thái extension, cổng 8788 | — | Tắt |
| Vận hành | `notify` | Thông báo, Web Push (mục dưới) | Gửi 5 giây một lần | Bật |
| Phản hồi | `gmail` | Feed Atom của hộp thư publisher qua extension | 30 phút | Tắt |
| Phản hồi | `listing` | Trang Play công khai | 6 giờ | Bật |

Cột "Mặc định" là `DEFAULT_MODULES` trong `src/config.ts`; module nào cần gì: [config.md](config.md).

## Develop: một task đi qua những bước nào

1. **Bạn tạo task trên web.** Hub ghi `develop_tasks`, rồi xếp một lượt `discuss` vào `develop_turns`.
2. **Runner nhận lượt.** Nó chạy `claude -p --input-format stream-json … --permission-mode auto --permission-prompts none`
   trong working tree của repo (tham số do adapter `src/lib/claude.ts` dựng, mục "Đổi AI"). Lượt đầu dùng `--session-id <uuid của task>`, các lượt sau dùng `--resume`.
   - Prompt đi qua stdin (một dòng stream-json), và runner giữ stdin mở. Lượt nào khởi chạy việc nền (workflow khi
     bật ultracode, Bash chạy nền) thì kết thúc bằng câu "đang chạy". Khi việc nền xong, CLI tự chạy một lượt nữa để
     báo kết quả. Mỗi `result` thành một tin trong luồng. Runner đóng stdin khi một `result` đến mà
     `background_tasks_changed` gần nhất rỗng, và lượt đó có tin `assistant` (hoặc lỗi). `-p <prompt>` thì thoát ngay
     và mất việc nền (probe 09/11).
   - Vì sao cần "có tin `assistant`": phiên `--resume` sau khi bấm Dừng lúc việc nền đang chạy, CLI báo việc nền cũ
     "stopped" bằng một `result` rỗng trước khi đọc prompt mới. Đóng stdin ở đó thì lượt thật chạy tiếp với stdin đã
     đóng, và `claude -p` giết mọi việc nền lượt đó mở sau 600 giây (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, chỉ tính
     từ lúc stdin đóng). Task #5 mất workflow thứ hai như vậy (09/11, đã probe và có test).
   - Bấm Dừng khi việc nền đang chạy thì giết luôn việc nền, và workflow thành "mồ côi" ở trang Vận hành. Vì vậy (D18)
     khi Claude đang chờ việc nền (`develop_turns.waiting = 1`: một `result` đến mà việc nền còn chạy), trang task
     mở ô trả lời (chỉ "Gửi trao đổi"). Tin gửi lúc đó là một lượt `queued`; runner viết nó vào stdin của phiên đang chạy
     và đánh dấu `merged`. `--replay-user-messages` cho biết CLI đã nhận từng tin, và runner chỉ đóng stdin khi mọi tin đã
     viết đều đã được nhận (tin gửi đúng lúc việc nền xong vẫn được trả lời). Viết không kịp (stdin đã đóng) thì tin vẫn
     là lượt `queued` và chạy sau như thường.
   - Từ D20 ô trả lời mở suốt lượt (không chỉ khi chờ việc nền): tin gửi lúc Claude đang làm cũng vào phiên, CLI nhận nó
     ngay sau bước đang chạy. Runner viết tin theo loại phiên: lượt trao đổi dùng `replyPrompt`, lượt "Duyệt và làm" dùng
     `executeNote` (cột `develop_turns.said` giữ chữ gốc). Tin đã viết mà CLI chưa nhận khi tiến trình kết thúc thì quay
     về `queued`. Dừng chỉ dừng lượt đang chạy; tin gửi trong lúc đó chạy tiếp sau.
   - Lượt treo bị giết khi im lặng 45 phút (không có dòng stream nào; workflow đang chạy vẫn in `task_progress`) hoặc
     chạy quá 4 giờ (`TURN_TIMEOUT_MS`, `TURN_MAX_MS` trong `prompts.ts`). Trước 09/11 là 45 phút tính từ đầu lượt.
   - Chi phí của lượt là `total_cost_usd` của `result` cuối, vì đó là tổng cộng dồn của phiên, gồm cả agent chạy nền.
   - Chế độ của task (`model`, `effort`, `ultracode`, `chrome`; `isolated` ở bước 4) thành `--model`, `--effort`,
     `--settings {"ultracode":true,"workflowSizeGuideline":"small"}`, `--chrome` kèm `--append-system-prompt` (trình duyệt
     trong `chromeBrowsers` của config, theo deviceId), truyền lại ở mọi lượt. Form chỉ hiện ô mà AI có (`features`).
     `chromeBrowsers` rỗng thì không có ô Chrome. Kèm hook `src/runner/chrome-guard.ts`
     (PreToolUse, cả subagent): tool trình duyệt bị từ chối cho tới khi chọn được một id được phép; runner xoá dấu đã chọn
     trước mỗi lượt.
   - Ảnh bạn gửi nằm ở `data/develop-files/<task>/`, bảng `develop_files`; mỗi lượt mang id ảnh của nó
     (`develop_turns.files`), runner đọc file và gửi thành khối `image` base64 trong dòng stdin. Task không cần quyền
     đọc `data/` (vẫn bị chặn).

   Quyền của mọi lượt (D14; task còn là phân tích, báo cáo, không chỉ code):
   - Full quyền như phiên thường của bạn: mọi MCP (Databuckets không giới hạn), mọi lệnh, không trần chi phí.
     Bộ phân loại của auto mode chặn việc rủi ro; việc nào nó muốn hỏi thì bị từ chối.
   - Nạp settings và CLAUDE.md của bạn lẫn của repo (`--setting-sources user,project,local`), nên task theo
     cùng quy chuẩn với phiên thường của bạn (ví dụ `git status` trước khi sửa).
   - Luật deny, thắng mọi thứ: không `git push` (cả sau `-C`, `-c`); không lệnh git xoá thay đổi chưa commit của người
     khác (`stash`, `reset --hard`, `clean`, `checkout .`, `restore .`, `add -A`/`.`, D15); không đọc file bí mật
     (key RC là `*-access.json` trong `rcKeyDir`) và `data/` của bản hub này (đường dẫn tuyệt đối dựng từ `DATA`, nên
     đúng ở mọi chỗ clone); không publish RC (`rc.py … --yes`, `rc.py api`);
     lượt trao đổi có thêm `Edit(./**)` và `Edit(//<worktree>/**)` nên không sửa được working tree chính lẫn worktree.
   - Khi `rcKeyDir` có `rc.py`, mọi lượt có `--append-system-prompt` nói cách đọc RC bằng nó (`RC_RULE`), kể cả phiên `--resume`.
   - Env của tiến trình con chỉ có PATH, HOME… (`childEnv`), không có `.env` của hub, và có `GIT_OPTIONAL_LOCKS=0`.
   - Đã kiểm với Claude thật (09/11, env giống runner): thấy tool Databuckets, nạp cả hai CLAUDE.md, ghi trong
     cwd bị từ chối, ghi ngoài cwd được, `git push` bị từ chối.
   - Còn hở: luật Read chặn cả `cat` file đó (kiểm 09/11), nhưng một script tự mở file thì không bị chặn. Chữ trong task (nhất là task nhập
     từ Jira) có thể chứa lệnh cài cắm; lớp chặn là bộ phân loại auto mode và việc bạn đọc trước khi bấm tạo.
3. **Runner ghi tiến độ.** Từng dòng stream-json được ghi vào `develop_activity`. Mỗi `result` (một lượt bên trong phiên) thành một tin trong `develop_messages`.
4. **Bạn bấm "Duyệt và làm".** Hub xếp một lượt `execute`. Runner chạy với cùng quyền như bước 2, trừ luật
   `Edit(./**)`, và được build, test khi cần (D15):
   - Mặc định trong working tree chính của repo, như phiên thường của bạn. Lời dặn: `git status` trước khi sửa,
     không push, chỉ commit khi bạn bảo và chỉ stage file mình sửa.
   - Task bật "Worktree riêng" (`isolated`): runner tạo worktree `<codeDir>/.hub-worktrees/<repo>-task<id>` (branch
     `hub/task-<id>`, từ HEAD) và chạy trong đó. Lời dặn: chỉ sửa trong worktree, không commit (diff so với HEAD là
     thứ bạn xem), không push.
5. **Xong lượt làm.** Runner ghi diff stat vào luồng trao đổi: cả worktree, hoặc trong working tree chính chỉ các
   file lượt đó sửa qua Edit/Write (runner gom từ stream). Task chuyển sang "Chờ bạn xem".

## Đổi AI chạy Develop

Develop là phần duy nhất cần AI; collector, trang web, extension và thông báo không cần. Mọi thứ riêng của Claude Code
trong Develop nằm ở một file adapter, `src/lib/claude.ts` (config `ai: "claude"`). Runner (`src/runner/runner.ts`) giữ
phần chung: hàng đợi, giờ treo, ghi luồng chat, diff, thông báo, và chỉ thấy output của AI qua `NeutralEvent`.
Đổi AI = viết một file adapter khác export cùng các tên, đăng ký nó trong `AIS` ở `src/modules/develop/prompts.ts`, cho
config `ai` chọn nó, và qua đủ 6 probe bên dưới.

**Adapter export:**

| Tên | Việc |
|---|---|
| `features` | `{ images, effort, chrome, background, cost: boolean; models: Record<id, nhãn>; efforts: Record<id, nhãn> }`: AI có gì. Form Task chỉ hiện ô AI có |
| `binary()` | Đường dẫn CLI của AI |
| `turnArgs(task, kind, rules)` | Tham số CLI cho lượt `discuss` hay `execute`, gồm quyền và luật deny; `rules` là lời dặn chung của hub cho mọi lượt (system prompt) |
| `message(prompt, images)` | Một dòng stdin mang prompt, kèm ảnh |
| `parse(line)` | Một dòng output → `NeutralEvent[]` (không, một hay nhiều sự kiện) |
| `describeTool(name, input)` | Một dòng ngắn mô tả tool đang chạy, cho trang task |
| `DEFAULT_LABEL` | `{ model, effort }` mặc định của tài khoản, để hiện trên form (`''` = không biết) |
| `projectDir(path)`, `rulePath(path)` | Tên thư mục phiên của AI cho một đường dẫn; một đường dẫn viết theo cú pháp luật quyền của AI |

**`NeutralEvent`** (kiểu chuẩn nằm trong `src/lib/claude.ts`):

| Sự kiện | Nghĩa | Runner dùng để |
|---|---|---|
| `{ kind: 'model', model }` | Model thật của lượt | Ghi `develop_turns.model_used` (D23) |
| `{ kind: 'session' }` | Đã thấy id phiên: phiên đã có | Lượt sau tiếp phiên đó |
| `{ kind: 'text', text }` | AI nói (`''` = một bước không có gì để hiện, ví dụ đang nghĩ) | Tiến độ, tin trả lời |
| `{ kind: 'tool', name, input }` | AI gọi tool (`file`: file nó sửa, nếu là lệnh sửa file) | Tiến độ; gom file cho diff cuối lượt làm (D15) |
| `{ kind: 'ack' }` | Một tin viết vào stdin đã được nhận | Đánh dấu tin `merged`; chỉ đóng stdin khi mọi tin đã được nhận (D18, D20) |
| `{ kind: 'jobs', pending }` | Số việc nền còn chạy | `pending > 0`: lượt đang chờ việc nền, giữ stdin mở (D17) |
| `{ kind: 'end', ok, cost, subtype?, text? }` | Một lượt bên trong phiên kết thúc; `cost` là tổng cộng dồn của phiên; `text` là câu trả lời của lượt nếu sự kiện mang nó | Thành một tin trong luồng; đóng stdin khi không còn việc nền và lượt đã có trả lời |

**6 probe, phải qua đủ trước khi cho một AI chạy Develop.** Thiếu điều nào thì không dùng AI đó. Probe bằng CLI thật,
model rẻ, file giả, rồi ghi kết quả vào [decisions.md](decisions.md) như D14, D15 đã làm:
1. Lượt trao đổi không sửa được file: working tree chính, và worktree của task.
2. Không `git push`, không lệnh git phá việc của người khác: `stash`, `reset --hard`, `clean`, `checkout .`,
   `restore .`, `add -A`, `add .`.
3. Không đọc được file bí mật (`~/.claude.json`, `.env`, key RC, `~/.ssh`…) và `data/` của hub.
4. Chạy không người trông: không bao giờ dừng lại hỏi quyền (việc cần hỏi thì bị từ chối).
5. Lượt sau tiếp đúng phiên của lượt trước.
6. Nhận tin qua stdin trong lúc đang chạy. Không được thì ô trả lời chỉ nên mở khi lượt đã xong: chưa làm, vì
   `features.background` và `features.cost` chưa được trang đọc (mới chỉ có Claude Code).

**Còn gắn với Claude Code ngoài adapter:**
- Module `agents` đọc transcript của Claude Code (`~/.claude/projects/`). Dùng AI khác thì tắt module này, hoặc viết module
  tương ứng.
- Chế độ Chrome của Develop là Claude in Chrome (`--chrome`, deviceId trong `chromeBrowsers`, hook
  `src/runner/chrome-guard.ts`). AI khác không có thì `features.chrome = false` và ô Chrome ẩn.
- Token Databuckets: `.env` trước, rồi tới cấu hình MCP của Claude Code (`~/.claude.json`).
- `NOTES_RULE` (prompts.ts, phần lời dặn chung) chỉ tới memory của Claude Code (`~/.claude/projects/…/memory`).
- Chrome trên Windows đang tắt (`features.chrome`): hook chạy trong PowerShell khi máy không có Git Bash và lúc đó
  không chặn được; bật lại khi đã probe trên Windows.
- Luật deny cho lệnh shell được viết cả dạng `Bash(…)` lẫn `PowerShell(…)` (Claude Code trên Windows dùng tool
  PowerShell khi không có Git Bash); file bí mật bị chặn cả dưới `codeDir`, các repo và bản clone này khi chúng nằm
  ngoài home.

## Thông báo (module `notify`)

- **Ghi:** ai cũng gọi `notify(db, { key, title, body, url, tone })` trong `src/lib/notify.ts`; mỗi `key` một lần một
  ngày (giờ VN), bảng `notify_items`. Đang ghi:
  - runner: AI trả lời (task chờ bạn), "Duyệt và làm" xong, việc chạy nền xong, lượt lỗi, hub dừng lượt, lượt bị
    ngắt; key `develop:turn:<id>:end` hoặc `…:job:<n>`. Bạn bấm Dừng thì không báo;
  - scheduler: dòng "Gấp" (alert tone `bad`) của module vừa chạy, key `alert:<module>:<href>:<chữ, số thành #>` nên
    số nhảy không báo lại mà hai cảnh báo khác link vẫn báo riêng; collector lỗi hai lần liền (`collector:<id>`).
- **Gửi:** `start` của module, 5 giây một lần, chỉ trong hub thật (`HUB_PAUSE=*` không gửi). Mỗi thông báo mới tới
  mọi máy trong `notify_subs` (mỗi máy một dòng, tên lấy theo IP tailnet); 23:00–07:00 chỉ tone `bad`, và chỉ khi key
  đó không có ở ngày VN trước (cảnh báo còn nguyên không reo lại mỗi đêm sau 00:00). Một lượt có hai thông báo cùng
  `url` thì chỉ đẩy cái mới nhất, cái kia `merged`. Ghi sau 6 giờ mới tới lượt (hub tắt) thì chỉ nằm trong danh sách.
  Dịch vụ đẩy trả 404/410 thì xoá máy đó. Không máy nào nhận và mọi lỗi đều tạm (mạng, 429, 5xx): trả lại hàng
  (`tries`, `next_at`), thử lại sau 1, 2, 4 phút, tối đa 3 lần, không quá 6 giờ. Lúc hub khởi động, hàng bị lấy quá
  2 phút mà chưa xong (hub chết giữa lượt) cũng được trả lại như thế. Lỗi gửi chỉ ghi log khi thông báo lỗi đổi.
- **Web Push, không thư viện:** `src/lib/webpush.ts` (VAPID RFC 8292, mã hoá aes128gcm RFC 8291); khoá VAPID tự tạo
  ở `data/vapid.json` (600, bí mật như các khoá khác). Chỉ nhận endpoint của dịch vụ đẩy thật (FCM, Mozilla, WNS,
  Apple; `PUSH_HOSTS`).
- **Trình duyệt:** `/sw.js` (core, `src/core/sw.js`) hiện thông báo; bấm vào mở `/ops/notify/go/<id>` (đánh dấu đã
  đọc rồi chuyển tới trang của thông báo). Trang `/ops/notify` có danh sách, nút bật và gửi thử (`push.js`).
  Chuông trên thanh trên: module đặt `bell.href` trong `lib/notify.ts`, core đếm thông báo chưa đọc.

## Theo dõi: đợt so sánh (module `track`)

- **File:** `runs.ts` (logic thuần, có test: tóm tắt template RC, gợi ý, EQL, thống kê), `store.ts` (bảng và các phần của
  collector), `view.ts` (trang), `play.ts` (T3, Play Console qua extension), `version.ts` (trang so 2 version của bản 1).
- **Bảng:** `track_runs` (một đợt: app, `kind` version/ab, `arms` JSON với A trước, `weights`, `start_at`/`end_at` UTC ms,
  `source` rc/data/play/manual, `status` suggested/active/ended/dismissed, `skey` chống gợi ý trùng, `horizon` số ngày cài
  trước khi kết luận, `decided_at`/`decision` kết luận đã lưu), `track_run_facts`
  (nhánh × ngày cài × ngày từ lúc cài × khoá; ngày cài `*` là tổng cả khoảng), `track_run_hours`, `track_rcv` (tóm tắt
  template RC theo app và số version: nhãn mặc định `experiment_group`, các thí nghiệm `abt_N`), `track_play`, `track_state`
  (đồng hồ của từng phần). `track_tests` của bản 1 được chép thành đợt một lần (`skey test:<id>`), bảng cũ để nguyên.
- **Collector 30 phút một lần** (`every`), mỗi phần một đồng hồ trong `track_state` nên khởi động lại không gọi lại:
  lịch sử RC mỗi lần (đọc hết các trang `listVersions`, chỉ tải template version mới; thiếu trang thì app đó không có gợi ý
  RC lần này); D0 theo version (1 lần gọi; theo nhãn chỉ còn trong `npm run track:backfill`) và crash theo version mỗi ngày
  sau 08:30; mỗi đợt làm mới 6 giờ một lần (đang chạy; đã dừng trong 9 ngày; gợi ý trong 3 ngày chỉ lấy số theo giờ); Play
  Console mỗi ngày sau 08:30. Mỗi phần ghi lần thử TRƯỚC khi gọi (`refreshed_at` của mọi đợt trong lần gọi, đồng hồ `d0`,
  `crash`, `play`), nên khởi động lại hay quá 50 phút giữa lần gọi không gọi lại. Lần đầu khởi động, `d0` và `play` được
  ghi giờ hiện tại: Play chỉ mở trang trong Chrome từ 08:30 kế tiếp. `pulled_to` chỉ đặt khi truy vấn nhóm user đã chạy.
- **Nhóm user của đợt** (truy vấn hai bước, `include $0.user_pseudo_id`): bước 1 chọn user của nhánh, bước 2 đếm sự kiện
  của họ. Đợt version: `first_open` có `app_version` đó trong khoảng. Đợt A/B: user có sự kiện mang nhãn nhánh ở
  `retention_day 0` trong khoảng (probe 09/11: `first_open` chỉ mang nhãn nhánh với khoảng 9% user, vì Firebase gán nhánh
  sau khi app tải RC). Nhóm tính đến 00:00 UTC hôm nay, tối đa 28 ngày cài. Mỗi nhánh 2 truy vấn (D0 tổng; session_start
  và ad_revenue theo ngày từ lúc cài, chia theo ngày UTC), Idol thêm 1 (mode cuộc gọi, vì nhóm theo một trường thì bỏ
  sự kiện không có trường đó), cộng 1 truy vấn theo giờ. Một lần gọi tối đa 7 EQL (probe: 7 EQL mất 276 giây).
- **Engine đẩy mốc `to` tuyệt đối thêm 1 ngày, cả khi có giờ** (probe 09/11, cả khi `to` lùi một ngày rơi trước `from`):
  hub gửi `to` sớm một ngày và kiểm EQL chạy thật với bản đã đẩy (`askAll` trong `store.ts`, bản sao của `runEql` thêm
  trường `ran`).
- **Gợi ý:** RC (thí nghiệm `abt_N` mới trên `experiment_group`, giờ chính xác đến giây; đổi nhãn mặc định, nhánh lấy từ
  số theo giờ: 2 version nhiều user mới nhất, mỗi cái từ 5%), số liệu (version mới từ 5% user mới trong ngày, app không có
  nhãn; tỉ lệ kỳ vọng theo tỉ lệ user mới của hai version ngày bắt đầu, làm tròn %), Play (bước rollout có giờ). Thí
  nghiệm đổi nhánh (sự kiện `ab_arms`, Brain abt_35: Set1/Set2 2,5 giờ rồi Set3/Set4): đợt nhánh cũ dừng lúc đổi, gợi ý
  đợt mới từ lúc đó (`skey rc:<app>:<abt>:<nhánh>`), có mốc trên dòng thời gian. Gợi ý chưa xác nhận theo RC (giờ dừng,
  ghi chú). Giờ "theo dữ liệu": 6 giờ liền mỗi nhánh đều có user, lượng từ 1/4 giờ thường, tỉ lệ ổn định. Bạn bấm Xác
  nhận, Dùng giờ dữ liệu, Sửa hay Bỏ. "Dùng giờ RC" chỉ lấy giờ của đoạn thí nghiệm có đúng các nhánh của đợt, và không
  đổi trạng thái gợi ý hay đã bỏ.
- **Thông báo** (`notify`): gợi ý mới (`track:suggest:<id>`), kết luận của chỉ số chính, một lần ở điểm quyết định, kể cả
  "chưa thấy khác biệt" (`track:verdict:<id>`), SRM (`track:srm:<id>`, tone warn, báo lại chỉ sau khi đã hết SRM; dòng
  `alerts` của SRM cũng là warn, không thành "Gấp").
- **Thống kê:** tỉ lệ: khoảng 95% của tỉ số hai tỉ lệ (log, Katz), p cùng z đó; trung bình (LTV, ads/user): mỗi ngày cài là
  một lần đo, khoảng t trên log tỉ số từng ngày quanh tỉ số gộp, cần 4 ngày, mỗi ngày mỗi nhánh có từ 5% user của nhánh
  hoặc 100 user (ngày lẻ tẻ vẫn ở số gộp); VideoRate chỉ có số gộp nên không có khoảng. Mẫu nhỏ (< 100 user một
  nhánh; tỉ lệ thêm < 10 user có hay không có sự kiện) không kết luận. SRM: χ² so với `weights`, p < 0,001, từ 100 user
  mỗi nhánh. Retention/LTV Dn chỉ tính ngày cài đã qua n + 1 ngày (retention_day theo giờ máy user), và chờ tới khi các
  ngày đó chiếm 1/10 nhánh.
- **Điểm quyết định** (`decideDay` trong `runs.ts`): xem 6 giờ một lần rồi kết luận ngay khi khoảng vừa qua 0 thì một
  đợt A/A bị báo khác nhau khoảng 27% số lần. Nên mỗi đợt kết luận đúng một lần: lần làm mới đầu tiên có `horizon` ngày cài
  (mặc định 7; cả khoảng nếu đợt dừng sớm hơn) và chỉ số chính đủ tuổi trên ngày cài cuối (Dn: n + 1 ngày). Lưu
  `decided_at` và `decision` (một từ mỗi nhánh sau A: better/worse/none), báo một lần. Trước đó trang ghi "Tạm thời: …"
  màu nhạt; sau đó số vẫn cập nhật nhưng kết luận là bản đã lưu. Chỉ chỉ số chính có kết luận; chỉ số khác "Tham khảo".

## Databuckets

- Chỉ đi qua MCP `chat_with_agent`, với token tĩnh: `DATABUCKETS_URL` và `DATABUCKETS_TOKEN` trong `.env`, không có thì
  MCP `databuckets` trong `~/.claude.json`. Giới hạn và chỗ dễ sai: [sources.md](sources.md).
- Một lần gọi mất khoảng 100 giây. Nhiều câu EQL nhỏ có thể chung một lần gọi.
- Agent của Databuckets không chạy EQL thô: nó dịch câu sang "QueryModel" của họ. Đừng dặn nó "không
  chạy nguyên văn được thì từ chối", vì nó sẽ từ chối hết (đã xảy ra 08/11).
- Hub so câu EQL thật sự chạy (nằm trong khối "Query results") với câu của mình. Agent chỉ được đổi
  phần hình thức: alias trùng tên, `desc`, `opt_skip_save`. Đổi gì khác, ví dụ bỏ `bucket 1 day` (đã gặp
  vài lần với khoảng 36 ngày), thì cả kết quả bị bỏ.
- Mỗi kết quả tối đa 1.000 dòng.
- Ngày tính theo UTC. Bucket đầu (thiếu) và bucket hôm nay (đang chạy) luôn bị bỏ.
- Report: 4 lần gọi mỗi ngày, và 4 lần ngay ở lần chạy đầu khi có app. Theo dõi: 1 lần gọi D0 mỗi ngày (cũng ngay ở lần chạy đầu), 1 lần gọi (tối đa 7 EQL) cho mỗi đợt đang chạy mỗi 6 giờ, và truy vấn theo giờ của đề xuất trong vài ngày đầu. Không bao giờ tự gọi lại.

## Lệnh

```
npm run check              # tsc + test (node --test), chạy trước khi bàn giao
npm run once [id …]        # chạy collector một lần, in ok/ERR (lệnh đọc thật)
npm start                  # hub (cổng PORT, mặc định 8787)
npm run runner             # runner Develop
npm run report:backfill    # nạp 35 ngày cho Report (khoảng 10 lần gọi Databuckets)
npm run track:backfill     # nạp 5 ngày cho Theo dõi (2 lần gọi; `-- ver` hoặc `-- exp` để chạy một phần)
npm run bridge:extension   # build extension vào data/extension/ (có khoá, không chia sẻ)
npm run setup              # kiểm máy, điền mẫu service vào data/deploy/, in lệnh cài (không tự cài)
PORT=8790 HUB_PAUSE='*' node src/main.ts   # hub xem thử cạnh hub thật: không lấy số, không mở cổng 8788 (ui.md)
```
