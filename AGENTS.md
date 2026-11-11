# Luật làm việc trong repo, cho mọi AI (và người)

**work-hub**: một trang web trên `127.0.0.1:8787`, cộng một runner cho bảng Develop. Mỗi người chạy bản riêng trên máy
mình, với config riêng (`data/config.json`), dữ liệu và token riêng.

Đọc theo việc:
- [README.md](README.md): hub là gì, các trang.
- [docs/architecture.md](docs/architecture.md): module, service, cách thêm hay bỏ một phần, đổi AI chạy Develop.
- [docs/ui.md](docs/ui.md): khi render một panel hay một trang (token, board, component, độ rộng, xem thử).
- [docs/config.md](docs/config.md): các trường config, module nào cần gì.
- [docs/sources.md](docs/sources.md): từng nguồn dữ liệu, credential, giới hạn.
- [docs/decisions.md](docs/decisions.md): quyết định kỹ thuật. Code ghi `Dxx` thì tìm ở đây.
- [docs/setup.md](docs/setup.md): cài một bản hub.

Stack: Node ≥ 26 chạy thẳng TypeScript, không dependency lúc chạy. Mỗi phần là một module trong `src/modules/`, đăng ký
một dòng trong `src/registry.ts`. Core trong `src/core/` không biết module nào. Config riêng chỉ đọc qua `src/config.ts`.
Chữ trên trang bằng tiếng Việt; code, lệnh, tên file bằng tiếng Anh; comment nói vì sao.

## Luật

0. **Plan trước, code sau.** Tính năng mới hay thay đổi lớn: viết plan (việc cần làm, nguồn dữ liệu, mức khả thi) và
   chờ người yêu cầu đồng ý rồi mới code. Trả lời một câu hỏi thiết kế chưa phải là đồng ý.
1. **Chỉ dùng thứ đã có.**
   - Không tạo Google Cloud project, OAuth client hay service account mới.
   - Trang không có API được phép dùng thì đọc qua Chrome của người dùng bằng extension của hub: chỉ đọc, chỉ URL
     trong danh sách cho phép.
2. **Chỉ đọc mọi nguồn.** Không publish Remote Config, không sửa Jira, không gửi mail, không bấm gì trong console.
   - Chỗ ghi duy nhất: SQLite của hub, ảnh người dùng gửi kèm tin Develop (`data/develop-files/`), và sau khi người
     dùng duyệt một task Develop, working tree chính của repo (mặc định, D15) hoặc worktree riêng khi task chọn.
   - Luật này ràng buộc code của hub. Task Develop chạy full quyền (D14): auto mode, mọi MCP, không trần chi phí. Chỉ
     luật deny trong adapter AI (`src/lib/claude.ts`) và, khi bật Chrome, hook `src/runner/chrome-guard.ts` (chỉ
     trình duyệt trong `chromeBrowsers`) giữ chúng lại.
   - Lệnh git chỉ đọc dùng `--no-optional-locks`.
3. **Bí mật để nguyên chỗ.**
   - Đọc token tại chỗ: file key Remote Config trong `rcKeyDir`, configstore của firebase-tools, `~/.claude.json`.
   - Cả `.env`, `data/bridge.key`, `data/csrf.secret`, `data/vapid.json` (khoá riêng Web Push).
   - Không chép, không log, không render chúng.
4. **Escape mọi thứ** render từ nguồn bằng `esc()`. Prompt trong transcript, tên crash, tiêu đề mail, chữ trong Jira và
   chữ trên trang console là dữ liệu không tin cậy.
5. **Databuckets tốn kém.**
   - Mỗi lần gọi `chat_with_agent` mất khoảng 100 giây và được lưu bên Databuckets (kèm "kiến thức" cấp tổ chức).
   - Không bao giờ tự gọi lại: lần gọi lỗi có thể đã chạy.
   - Collector gọi theo lịch cố định (`docs/architecture.md` mục Databuckets). Thêm lần gọi thì ghi rõ số lần một ngày
     trong PR.
6. **`npm run check` trước khi bàn giao.** `npm run once [id…]` chạy collector một lần: đó là lần gọi thật (chỉ đọc),
   chỉ chạy khi được bảo.
7. **Việc của người chạy bản hub,** AI không tự làm: cài hay khởi động lại service chạy nền, `tailscale serve`, nạp
   extension Chrome. Lệnh nằm trong `deploy/` và do `npm run setup` in ra.
8. **Git và PR.**
   - File riêng của từng người không bao giờ commit: `data/`, `.env`, `CLAUDE.local.md`, `.claude/settings.local.json`.
   - Mọi thay đổi vào `master` qua PR; owner duyệt mọi PR.
   - Nhiều session có thể dùng chung một working tree: chạy `git status` trước khi sửa, chỉ stage đường dẫn mình sửa,
     không bao giờ `git add -A` hay `git add .`.
   - DB chỉ thêm cột hay bảng (kiểm trước khi `add column`), không xoá, để người pull muộn vẫn chạy được.
9. **Luật riêng của từng người** đặt ở `CLAUDE.local.md` (Claude Code) hay file riêng tương ứng của AI khác, không commit.
