# Config riêng: `data/config.json`

Mỗi bản hub đọc config riêng **một lần lúc khởi động**: sửa xong thì khởi động lại hub và runner. File nằm trong `data/`,
không vào git. Mẫu: `config.example.json`. Code đọc nó ở một chỗ duy nhất, `src/config.ts`.

Mọi trường đều tuỳ chọn. Không có file: hub chỉ mở ở `127.0.0.1`, không theo app nào, chế độ Chrome của Develop tắt,
module bật theo mặc định ở bảng cuối. Biến `HUB_CONFIG` đổi đường dẫn file (test dùng `test/fixtures/config.json`).

**Không bao giờ ghi token, mật khẩu hay khoá vào file này.** Token để trong `.env` hoặc ở chỗ công cụ của nó đã cất
(`docs/sources.md`).

## Các trường

| Trường | Nghĩa | Mặc định | Lấy giá trị ở đâu |
|---|---|---|---|
| `modules` | Danh sách module bật | Bảng module bên dưới | Chọn theo trang bạn cần. Id lạ chỉ bị ghi cảnh báo trong log |
| `codeDir` | Thư mục gốc chứa các repo. Đường dẫn `repo` tương đối tính từ đây. Worktree riêng của task Develop nằm ở `<codeDir>/.hub-worktrees` | `~/Code` | |
| `rcKeyDir` | Thư mục chứa file key service account Remote Config, đọc tại chỗ | `<codeDir>/tv-rc` | Thư mục bạn đã cất key (bước 6 của `docs/setup.md`) |
| `apps` | Các app hub theo dõi (bảng dưới) | `[]` | |
| `repos` | Repo ngoài app mà task Develop chạy được và trang Repo hiện: mỗi mục `key`, `name`, `repo` | `[]` | Hỏi người dùng |
| `access.tailnetHost` | Tên máy này trên tailnet. Trống = hub chỉ mở trên chính máy này | `""` | `tailscale status --json`, trường `Self.DNSName`, **bỏ dấu chấm cuối** |
| `access.devices` | Máy được mở hub qua tailnet: `{ "Tên máy": ["<IPv4>", "<IPv6>"] }`. Tên hiện trên trang và trong thông báo | `{}` | `tailscale status` (cột đầu là IP), hoặc `tailscale ip -4 <máy>` và `tailscale ip -6 <máy>`. Ghi cả hai IP. Máy vào lại tailnet có thể đổi IP |
| `chromeBrowsers` | Trình duyệt task Develop được điều khiển khi bật Chrome: `[{ "id", "name" }]`, theo thứ tự ưu tiên. Rỗng = ẩn ô Chrome | `[]` | Chỉ cho người dùng Claude Code: `deviceId` từ tool `list_connected_browsers` của Claude in Chrome. Seat Claude dùng chung thấy trình duyệt của mọi người: **chỉ ghi trình duyệt của bạn**. Kết nối lại có thể ra id mới |
| `chromeNote` | Một dòng cho task: trình duyệt nào đăng nhập gì, ví dụ "Play Console ở trình duyệt đầu" | `""` | Người dùng |
| `chromeProfiles` | Profile Chrome có extension của hub, theo vai trò: `{ "falcon": "nhãn", "publisher": "nhãn" }`. Nhãn hiện trên trang. Thiếu vai trò nào thì module cần vai trò đó báo "chưa cấu hình" | `{}` | Xem "Vai trò profile" bên dưới |
| `databucketsDataset` | Dataset Databuckets mà Report và Theo dõi đọc | `""` (chưa có thì không gọi Databuckets, Report và Theo dõi báo "chưa cấu hình") | Hỏi người quản lý Databuckets, hoặc lấy tên dataset trong một câu EQL trên Databuckets |
| `jiraHost` | Địa chỉ Jira Server/DC của công ty, dạng `https://jira.cong-ty.com` | `""` (module `jira` báo "chưa cấu hình") | Thanh địa chỉ khi mở Jira |
| `chromeDomains` | Domain của tài khoản đăng nhập Chrome → vai trò: `{ "cong-ty.com": "falcon", "publisher.com": "publisher" }`. Ghi vào extension lúc build | `{}` (extension không nhận vai trò nào) | Phần sau `@` của email đăng nhập Chrome ở mỗi profile |
| `companyDomains` | Domain của chính công ty: mail từ đó không tính là phản hồi của người dùng (Gmail) | Các domain trong `chromeDomains` | Thêm domain của đối tác gửi mail vào hộp publisher |
| `ai` | AI chạy task Develop | `"claude"` | Hiện chỉ có `claude` (`docs/architecture.md` mục "Đổi AI") |

### Mỗi app trong `apps`

`key`, `name`, `pkg` bắt buộc. `key` không được trùng giữa các app và repo.

| Trường | Nghĩa | Lấy ở đâu |
|---|---|---|
| `key` | Khoá ngắn, chữ thường | `idol`, `brain`, `xremote`, `xcast` là khoá cố định: Report và Theo dõi có chỉ số riêng cho các app này theo khoá. App khác chỉ có chỉ số chung; thêm chỉ số riêng qua PR |
| `name` | Tên hiện trên trang | Tên app |
| `pkg` | Android applicationId, cũng là `app_id` trong Databuckets và package trên Play | `applicationId` trong `defaultConfig` của `app/build.gradle` hoặc `app/build.gradle.kts` |
| `repo` | Repo của app: `~/…`, tương đối với `codeDir`, hoặc tuyệt đối | Người dùng chỉ ra |
| `gradle` | File gradle có `versionCode`/`versionName`, tương đối với `repo` | Thường là `app/build.gradle.kts` |
| `pbxproj` | `project.pbxproj` của bản iOS, tương đối với `repo` | `ios/<Tên>.xcodeproj/project.pbxproj` |
| `infoPlist` | `INFOPLIST_FILE` của target app, đúng như ghi trong `project.pbxproj` | `grep INFOPLIST_FILE <pbxproj>` |
| `rcKey` | Tên file key Remote Config trong `rcKeyDir` | Người dùng |
| `appId` | Firebase Android app id, cho Crashlytics | `mobilesdk_app_id` trong `google-services.json`, ở mục `client` có `package_name` bằng `pkg` |
| `playDev` | Id tài khoản developer Play Console | Con số trong URL Play Console: `…/developers/<id>/…` |
| `playAccount` | Tên tài khoản developer đó, hiện trên trang | Play Console |
| `storeTitle` | Tên app trong danh sách app của Play Console | Play Console. Mặc định bằng `name` |
| `feedbackSubject` | Regex, không phân biệt hoa thường, khớp tiêu đề mail phản hồi của app | Chuỗi tiêu đề mail trong code phần "feedback" của app (tìm `mailto`, `EXTRA_SUBJECT`, `Feedback`) |

### Vai trò profile Chrome (`chromeProfiles`)

Extension tự nhận vai trò theo domain của tài khoản đang đăng nhập Chrome ở profile đó (`chromeDomains`). Đổi
`chromeDomains` hay `jiraHost` thì chạy lại `npm run bridge:extension` rồi bấm Reload extension trong Chrome.

| Vai trò | Profile đăng nhập Chrome bằng | Mở ra |
|---|---|---|
| `falcon` | Tài khoản công ty | Play Console (`consoles`: vitals; `track`: các bước rollout), Jira khi không có `JIRA_PAT` |
| `publisher` | Hộp thư publisher | Gmail (`gmail`: mail phản hồi), AdMob (`consoles`) |

## Module

| Module | Trang | Hiện gì | Cần gì | Mặc định |
|---|---|---|---|---|
| `develop` | Develop | Bảng task giữa bạn và AI | `claude` đã đăng nhập, runner chạy, repo trong `apps` hoặc `repos` | Bật |
| `jira` | Develop | Issue Jira giao cho bạn | `JIRA_PAT` trong `.env`, hoặc `bridge` và profile `falcon` | Tắt |
| `report` | Report | Số hằng ngày theo app, MA7/MA28, cờ | `apps` và Databuckets. Thêm Crashlytics (`appId`) và mốc RC (`rcKey`) nếu có | Bật |
| `track` | Theo dõi | So version, A/B | `apps` và Databuckets. Gợi ý A/B cần `rcKey`; crash theo version cần `appId`; rollout cần profile `falcon` và `playDev` | Bật |
| `agents` | Vận hành | Phiên Claude Code và workflow 24 giờ qua | Transcript Claude Code (`~/.claude/projects`). Dùng AI khác thì tắt | Bật |
| `repos` | Vận hành | Trạng thái git các repo, số version | git, `repo` của app và `repos` | Bật |
| `crash` | Vận hành | Crashlytics 24 giờ | `appId` và `npx firebase-tools login` | Bật |
| `rc` | Vận hành | Remote Config: version, tham số vừa đổi | `rcKey` và file key trong `rcKeyDir` | Bật |
| `market` | Vận hành | market-tool | market-tool chạy trên macOS của owner; người khác để tắt | Tắt |
| `consoles` | Vận hành | Play Console vitals, AdMob | `bridge`, profile `falcon` (`playDev`) và `publisher` | Tắt |
| `bridge` | Vận hành | Trạng thái extension; mở cổng 8788 cho extension | Extension đã nạp (`docs/setup.md` bước 8) | Tắt |
| `notify` | Vận hành | Thông báo, Web Push | Không. Đẩy tới điện thoại cần HTTPS qua Tailscale | Bật |
| `gmail` | Phản hồi | Mail phản hồi của user | `bridge`, profile `publisher`, `feedbackSubject` | Tắt |
| `listing` | Phản hồi | Trang Play công khai: rating, lượt cài | `pkg` | Bật |

Mặc định là `DEFAULT_MODULES` trong `src/config.ts`, dùng khi file không có `modules`. Module bật mà thiếu thứ nó cần
thì hiện "chưa cấu hình", không gọi nguồn và không gửi thông báo lỗi.

## Dành cho AI: đề xuất config

1. Hỏi người dùng: repo nào là app cần theo dõi, repo nào khác cho Develop, cần những trang nào.
2. Với mỗi repo app, đọc file (không chạy build) để lấy: `pkg`, `gradle`, `appId`, `pbxproj`, `infoPlist`,
   `feedbackSubject` theo bảng trên. `key` dùng khoá cố định nếu app là một trong `idol`, `brain`, `xremote`, `xcast`.
3. Trường không có trong repo (`rcKey`, `playDev`, `playAccount`, `storeTitle`, `access`, `chromeProfiles`, `chromeDomains`,
   `jiraHost`, `databucketsDataset`): hỏi người dùng,
   không biết thì bỏ trống.
4. Chọn `modules` theo bảng module và những gì người dùng có. Bỏ app mẫu `myapp` và repo mẫu `tools`.
5. **Cho người dùng xem nguyên JSON sẽ ghi. Chỉ ghi khi người dùng đồng ý.**
6. Không ghi token, mật khẩu, khoá vào config. Không chép file key.
7. Kiểm: `npm run setup` hiện `[ok] data/config.json: …`.
