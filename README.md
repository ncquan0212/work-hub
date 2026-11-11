# work-hub

**Người mới:** bảo AI của bạn *"Đọc `docs/setup.md` rồi cài work-hub cho tôi"*. Tài liệu viết cho cả người lẫn AI
làm theo, và ghi rõ bước nào bạn phải tự làm.

Một trang web chạy trên máy của bạn, gom việc hằng ngày về một chỗ: task giao cho AI, số liệu các app,
A/B test, tình trạng repo và phản hồi của user.

## Các trang

| Trang | Đường dẫn | Bạn thấy gì |
|---|---|---|
| Hôm nay | `/` | Việc cần để ý (gom từ mọi trang), việc đang chờ bạn, số chính hôm qua của từng app |
| Develop | `/develop` | Bảng task giữa bạn và AI: tạo task, trao đổi, bấm duyệt thì AI sửa repo. Issue Jira giao cho bạn |
| Report | `/report` | Số hằng ngày theo app (Databuckets, Crashlytics): biểu đồ, MA7/MA28, cờ bất thường |
| Theo dõi | `/track` | So 2 version, A/B test theo nhóm user cài mới, kiểm SRM, kết luận |
| Vận hành | `/ops` | Phiên AI đang chạy, git các repo, crash 24 giờ, Remote Config, Play Console, AdMob, thông báo |
| Phản hồi | `/feedback` | Mail phản hồi của user, trang Play công khai của từng app |

Trang nào chưa được cấu hình (chưa có app, chưa đăng nhập nguồn) thì hiện "chưa cấu hình", không báo lỗi.

## Mỗi người chạy bản của mình

- Code để chung trên git. Mỗi người có config, dữ liệu, token và extension riêng, nằm trong `data/` và `.env`.
  Hai chỗ này không bao giờ vào git.
- Hub chỉ mở ở `http://127.0.0.1:8787` trên máy bạn. Muốn mở từ điện thoại thì bật `tailscale serve`
  (`docs/setup.md` bước 10).
- Hub có 2 service: **hub** (trang web và lấy số theo lịch) và **runner** (chạy các lượt AI của trang Develop).

## Cần gì

| | Bắt buộc | Ghi chú |
|---|---|---|
| Node ≥ 26 | Có | Chạy thẳng TypeScript, không có dependency lúc chạy |
| git | Có | |
| Claude Code (`claude`, đã đăng nhập) | Cho trang Develop | Develop đổi được AI khác: `docs/architecture.md` mục "Đổi AI" |
| Tailscale | Không | Mở hub từ thiết bị khác |
| Chrome và extension của hub | Không | Đọc Gmail, Play Console, AdMob bằng phiên đăng nhập của bạn |
| macOS, Ubuntu hoặc Windows | | Windows chưa được thử trên máy thật |

## Cập nhật

```
git pull
```

Rồi khởi động lại hub và runner (lệnh cho từng hệ điều hành: `npm run setup` in ra, hoặc `docs/setup.md` bước 13).
Bảng trong `hub.db` chỉ được thêm, không bị xoá, nên pull muộn vẫn chạy.

## Đóng góp

1. Tạo branch, sửa, chạy `npm run check` (phải đạt).
2. Mở PR vào `master`. Owner duyệt mọi PR; `master` được bảo vệ.
3. Không bao giờ commit `data/`, `.env` hay `CLAUDE.local.md`. Luật làm việc trong repo, cho người và mọi AI: [AGENTS.md](AGENTS.md).

## Tài liệu

| File | Nội dung |
|---|---|
| [docs/setup.md](docs/setup.md) | Cài từng bước trên macOS, Ubuntu, Windows |
| [docs/config.md](docs/config.md) | Từng trường của `data/config.json`, lấy giá trị ở đâu; module nào bật sẵn |
| [docs/sources.md](docs/sources.md) | Từng nguồn dữ liệu: dùng credential nào, giới hạn, chỗ dễ sai |
| [docs/architecture.md](docs/architecture.md) | Module, service, cách thêm hay bỏ một phần, đổi AI chạy Develop |
| [docs/ui.md](docs/ui.md) | Hệ thiết kế của các trang |
| [docs/decisions.md](docs/decisions.md) | Các quyết định kỹ thuật (D1–D24) và lý do |
| [AGENTS.md](AGENTS.md) | Luật làm việc cho mọi AI |
