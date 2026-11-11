# Nguồn dữ liệu

Hub chỉ dùng credential đã có trên máy (AGENTS.md luật 1), đọc tại chỗ, không chép, và chỉ đọc mọi nguồn (luật 2).
Trang này ghi từng nguồn dùng gì, giới hạn và chỗ dễ sai đã gặp. Cách điền config: [config.md](config.md).

## Tóm tắt

| Nguồn | Module | Credential, đọc tại chỗ | Khả thi |
|---|---|---|---|
| git | `repos`, `develop` | File trên máy | Cao |
| Transcript Claude Code | `agents` | `~/.claude/projects/` | Cao, chỉ khi dùng Claude Code |
| Remote Config | `rc`, mốc của `report`, gợi ý của `track` | File key service account trong `rcKeyDir` | Cao |
| Crashlytics | `crash`, `report`, `track` | Đăng nhập firebase-tools của bạn | Trung bình: API v1alpha không công khai |
| Databuckets | `report`, `track` | Token tĩnh của MCP: `~/.claude.json` hoặc `DATABUCKETS_URL`/`DATABUCKETS_TOKEN` trong `.env` | Cao về dữ liệu, trung bình về vận hành |
| Trang Play công khai | `listing` | Không cần | Cao |
| Jira Server | `jira` | `JIRA_PAT` trong `.env`, hoặc phiên Chrome qua extension | Cao |
| Play Console | `consoles`, rollout của `track` | Phiên Chrome, profile `falcon`, qua extension | Trung bình đến thấp: trang SPA hay đổi |
| AdMob | `consoles` | Phiên Chrome, profile `publisher`, qua extension | Thấp đến trung bình |
| Gmail | `gmail` | Phiên Chrome, profile `publisher`, qua extension | Trung bình |

Không làm được:
- **Firebase A/B Testing:** không có API công khai. Thay bằng nhãn `experiment_group` trong dữ liệu và điều kiện trong
  Remote Config.
- **Thời lượng session (GA4):** không có export BigQuery, và không được tạo mới.
- **OAuth client hay service account mới cho Play, AdMob, Gmail:** luật 1 không cho. Token của firebase-tools cũng không
  dùng lại được cho Play Reporting (thiếu scope, trả 403).

## Databuckets

Đi qua MCP `chat_with_agent`: một agent LLM chạy câu EQL hub đưa. Đã đo khi xây hub:
- **Mỗi lần gọi khoảng 100 giây** (58–175 giây). Bản thân query chỉ 1–44 giây, phần còn lại là LLM trung gian. Một lần
  gọi có thể chứa nhiều EQL (7 EQL mất khoảng 276 giây).
- **Mỗi lần gọi được lưu thành một cuộc chat**, và trả về "kiến thức dataset" cấp tổ chức, có điều sai. Dùng hằng ngày
  vì vậy không hoàn toàn chỉ đọc, và có thể làm bẩn kiến thức chung của team. N người theo cùng app thì số lần gọi nhân N.
- **Không bao giờ tự gọi lại:** lần gọi hết giờ vẫn có thể đã chạy xong bên họ.
- Lời đáp bằng chữ không ổn định (có lần ra tiếng nước khác). Hub chỉ đọc khối JSON "Query results" (`eql`, `data`).
- Hub so EQL thật sự chạy với EQL của mình. Agent chỉ được đổi phần hình thức (alias trùng tên, `desc`, `opt_skip_save`).
  Đổi gì khác, ví dụ bỏ `bucket 1 day`, thì cả kết quả bị bỏ.
- Đừng dặn agent "không chạy nguyên văn được thì từ chối": nó sẽ từ chối hết.
- Mỗi kết quả tối đa 1.000 dòng.
- Ngày cắt theo UTC; bucket đầu và cuối luôn thiếu nên bị bỏ. Engine tự đẩy mốc `to` tuyệt đối thêm một ngày.
- Không dùng `event_date` (kiểu dữ liệu khác nhau giữa các app). `max(ts)` bị engine bỏ âm thầm. Query nhóm theo một
  trường thì bỏ các dòng thiếu trường đó.
- Định nghĩa chỉ số: DAU theo `session_start`, quảng cáo theo `ad_revenue`, retention theo `retention_day` (decisions.md D12).
- Ngày UTC nên không khớp từng ngày với AdMob (múi giờ của tài khoản AdMob).

## Remote Config

- Service account JSON có sẵn của team, mỗi app một file trong `rcKeyDir`, ghi tên ở `rcKey`. Không tạo service account mới.
- Chỉ GET: `listVersions`, và tải template chỉ khi số version đổi. 503 được thử lại một lần sau 2 giây, 429 sau một phút
  (GET nên an toàn).
- Template lộ một phần A/B: thí nghiệm `abt_N` trên `experiment_group`, điều kiện `AB_*`.

## Crashlytics

- Token: refresh token trong configstore của firebase-tools (`npx firebase-tools login`), đổi lấy access token bằng OAuth
  client của chính firebase-tools (công khai trong mã nguồn của nó, hub đọc từ bản trong cache của npx; `FT_CLIENT_ID`,
  `FT_CLIENT_SECRET` ghi đè).
- API v1alpha, không công khai: có thể đổi không báo. Có test parse.
- Đổi mật khẩu Google là mất token: `npx firebase-tools login --reauth`.
- Crash-free users chỉ tính FATAL, khớp số trên console.

## Trang Play công khai

- `fetch` thẳng, 0,1–0,4 giây mỗi trang, không cần đăng nhập.
- **Bắt buộc đọc JSON-LD** cho rating: đọc chữ trên trang từng lấy nhầm rating của app khác. Lượt cài và ngày cập nhật
  đọc cạnh nhãn và kiểm; không đọc được thì hiện "—", không bao giờ hiện số sai.

## Jira Server

- Host Jira của công ty ghi trong code. Đọc issue giao cho bạn: `assignee = currentUser()`, Done trong 14 ngày.
- Cách 1: PAT của chính bạn, `Authorization: Bearer`, trong `JIRA_PAT`. PAT có từ Jira 8.14; admin có thể giới hạn số
  lượng và thời hạn.
- Cách 2: extension gọi REST của Jira bằng phiên Chrome đang đăng nhập (ra JSON, không đọc giao diện).
- **PAT sai hay hết hạn vẫn trả 200 với danh sách rỗng**, kèm header `X-AUSERNAME: anonymous`. `/rest/api/2/serverInfo` cũng
  trả 200 khi không đăng nhập. Nên mọi lần đọc đều kiểm header này và báo lỗi (PAT sai, hay profile Chrome chưa đăng nhập Jira) thay vì hiện bảng rỗng.

## Đọc trang qua extension (Play Console, AdMob, Gmail)

Không có API được phép dùng, nên hub đọc trang bằng một extension Chrome nhỏ (MV3) cài dạng unpacked vào profile Chrome
sẵn có của bạn:
- Extension hỏi hub ở `127.0.0.1:8788` mỗi phút (khoá bí mật riêng mỗi bản), làm việc trong profile đó rồi gửi kết quả.
- Một việc là một lần GET bằng cookie của profile, hoặc mở một URL trong cửa sổ thu nhỏ, đọc chữ rồi đóng. Không bấm, không
  gõ, không `chrome.debugger`, chỉ URL trong danh sách cho phép.
- Vai trò của profile lấy theo tài khoản đăng nhập Chrome: tài khoản công ty là `falcon`, hộp thư publisher là
  `publisher` (config.md).
- Dùng chính phiên bạn dùng hằng ngày nên phiên tự được giữ sống, Chrome thật nên ít bị Google gắn cờ.

Luật đọc:
- Đọc theo mốc có cấu trúc: JSON-LD, aria-label trong đúng khu vực của app, tiêu đề bảng.
- Kiểm hình dạng và khoảng giá trị. **Đọc không ra thì báo lỗi, không bao giờ ghi 0.**
- Bị đẩy về trang đăng nhập thì báo "cần đăng nhập lại" và giữ số cũ. Không tự gõ mật khẩu. Dấu hiệu: AdMob chuyển về
  `accounts.google.com`, Play Console về `google.play/business`.
- Chữ của trang được lưu làm mẫu trong `data/bridge-samples/` (chmod 600) để hiệu chỉnh bộ đọc khi Google đổi giao diện.

Từng trang:
- **Play Console** (profile `falcon`): trang SPA, giao diện hay đổi, có lúc bắt xác minh lại. Trang tổng quan vitals có
  khi thu gọn mục số liệu (không theo app cố định), nên tỷ lệ thiếu được đọc ở trang chi tiết của từng chỉ số.
- **AdMob** (profile `publisher`): trang cần khoảng 60 giây mới đủ số. Doanh thu theo ngày đã có từ Databuckets
  `ad_revenue` (ước tính của SDK); AdMob để đối chiếu và tách theo network.
- **Gmail** (profile `publisher`): feed Atom `mail.google.com/mail/u/N/feed/atom`. Feed chỉ trả mail **chưa đọc** trong
  inbox, 20 mail mới nhất. Mail được gán app theo `feedbackSubject`.

Đã cân nhắc và bỏ:
- Profile riêng chạy headless: phải đăng nhập mới (Workspace bắt đăng nhập lại khoảng 14 ngày một lần), lộ dấu automation
  (`HeadlessChrome`, `navigator.webdriver`).
- Công cụ duyệt web của AI (Claude in Chrome, computer use): mỗi lần đọc tốn một lượt AI, chỉ hợp để hỏi đột xuất khi bạn
  có mặt.
- Cài OpenClaw: cả một nền tảng agent quyền rộng. Hub chỉ học cách "extension cộng relay trên 127.0.0.1" của nó.

## An toàn chung

- Hub nghe `127.0.0.1`, từ chối Host lạ (chống DNS rebinding). Qua tailnet: `tailscale serve` ghi đè `X-Forwarded-For`
  bằng IP thật của máy gọi, nên hub lọc thiết bị theo IP (`access.devices`).
- Mọi POST kiểm `Origin` và token của form (chống CSRF).
- Token mới (PAT Jira, token Databuckets) để trong `.env`, chmod 600. Runner không đọc `.env`, nên task Develop không thấy
  token của hub.
