# work-hub: giao diện

Hướng dẫn cho agent (hoặc owner) viết hay sửa phần hiển thị của một module. Hệ màu, chữ và bố cục nằm ở
`src/core/style.ts`; khung trang ở `src/core/layout.ts`; các hàm dựng HTML dùng chung ở `src/core/html.ts`.
Thiết kế theo skill [hallmark](https://github.com/nutlope/hallmark), theme Ultraviolet, kiểu "app screen"
(09/11/2026).

## Nguyên tắc

- **Không có script, trừ hai file của trang Develop.** CSP chỉ cho script của chính hub (`script-src 'self'`, không inline;
  `connect-src 'self'` cho `fetch`): `src/modules/develop/paste.js` (dán và kéo thả ảnh) và `src/modules/develop/chat.js`
  (trang task như chat: Enter gửi, gửi không tải lại, tin mới tự hiện), owner 09/11. Trang phải chạy đủ khi không có chúng
  (form vẫn gửi, trang tải lại), và mọi trạng thái khác vẫn là CSS (`details/summary`, `:hover`, `:focus-visible`,
  `aria-current`). Thêm script khác cần owner đồng ý. Script chỉ đưa vào trang HTML do hub dựng và đã escape, hoặc chữ đặt
  bằng `textContent`.
  Trang tự tải lại mỗi 60 giây, trừ trang có form (`noRefresh`). Vì trang nhóm luôn tự tải lại,
  panel không chứa ô nhập chữ: đặt form ở trang riêng rồi để link tới (gõ dở sẽ mất sau một phút).
- **Màu và chữ chỉ qua token** ở `:root` trong `style.ts`. Không viết mã màu hay `font-family` trực tiếp.
- **Hai chế độ màu** theo cài đặt máy: sáng (lavender) và tối (night). Token tự đổi, module không cần làm gì.
- **Một màu nhấn tím** cho thứ đang chọn, nút chính, focus, đường MA7. Xanh, vàng, đỏ chỉ để báo trạng thái
  (tốt, cần xem, xấu), luôn đi kèm chữ hoặc ký hiệu (▲▼, "Gấp", "lỗi"), không bao giờ chỉ có màu.
- **Escape mọi thứ lấy từ nguồn** bằng `esc()`.
- **Tràn hết màn hình,** dừng ở 2560px. Bảng panel tự chia 1, 2, 3 hay 4 cột theo chiều rộng.

Mấy điều skill cấm:
- Nhãn viết hoa toàn bộ hoặc giãn chữ.
- Nối các mẩu thông tin bằng dấu chấm giữa ("4 giờ trước · fetch 3 ngày trước"). Tách thành từng `<span>`,
  hoặc nối bằng dấu phẩy, hoặc xuống dòng.
- Emoji làm icon.
- Card nằm trong card.
- `transition: all`.
- Bỏ viền focus mà không có viền thay thế.

## Chiều rộng cần đẹp

| Máy | Chiều rộng CSS | Bố cục |
|---|---|---|
| Điện thoại, màn ngoài Fold | 360–412 | 1 cột, menu là thanh dưới đáy (dock) |
| Fold mở | ~700 | 1 cột, menu trên đầu thành hàng thứ hai |
| Tablet dọc | 800 | 2 cột |
| Tablet ngang, laptop | 1280–1512 | 3 cột, menu cùng hàng với logo |
| PC | 1920 trở lên | 4 cột |

Điểm ngắt (rem): 40 (dock thành tab), 48 (2 cột), 60 (tab lên hàng logo), 80 (3 cột), 120 (4 cột).

## Thành phần

**Trang nhóm.** `groupPage` bọc panel của mọi module trong `board()`. Một module trả về một hoặc vài
`section(...)`; chúng tự xếp vào lưới. Trang chi tiết (route riêng) tự gọi `board(...)`.

**Trang không khung.** Route trả `{ …, bare: true }` thì layout bỏ thanh trên, tab, dock và tiêu đề trang: module tự
viết `h1` và link quay về. Dùng cho chế độ xem toàn màn hình (biểu đồ Report).

**Icon.** `src/core/icon.svg` (tab trình duyệt) và `icon.png` 180px (màn hình chính, `apple-touch-icon`, cũng trả cho
`/favicon.ico`), wordmark trong thanh trên vẽ cùng hình: hub ở giữa, 4 app quanh. Sửa svg thì vẽ lại png bằng Chrome
headless (`--screenshot --window-size=180,180` một trang chỉ có ảnh svg, bỏ `rx` cho ảnh vuông kín).

**Panel.** `section(title, body, note?, id?, { span?, act?, cls? })`:
- `span: 2 | 3 | 'all'`: rộng 2 hay 3 cột (khi lưới có đủ cột), hoặc cả hàng. Dùng cho bảng nhiều cột.
- `act`: HTML đã tin cậy ở bên phải tiêu đề, ví dụ link "Xem chi tiết".
- `cls`: class riêng của module, đặt tên bắt đầu bằng id module (`report-…`) để CSS của module không đụng ai.

Panel là một mặt `--paper-2` bo 16px, không viền. Không đặt panel hay thẻ có nền trong panel. Bên trong
chia bằng đường kẻ mảnh (`--rule`), tiêu đề `h3`, hoặc `.kv`.

**Hàng tiêu đề giữa các nhóm panel:** `boardHead(title, note?)`, chiếm cả hàng.

**Ô số (tile):** `<a class="tile">` hoặc `<div class="tile">` đặt trong `<div class="tiles">` (1, 2 rồi 4
cột). Bên trong:
- `.tile-name` là tên app, cùng ngày trong một `<span>`;
- `.tile-fig` gồm `.fig` (số lớn, chữ mảnh), `.unit` và `delta()`;
- `sparkline(values, ma7, title)` từ `lib/svg.ts`;
- `<dl class="kv">` là các cặp nhãn và giá trị.

**Số và thay đổi:**
- `.fig` là số lớn (36px, weight 300), `.big` là số vừa (23px, 600).
- `delta(x, upIsGood?, label?)` trong `html.ts` tô màu theo tốt hay xấu và có sẵn ▲▼. Report có hàm `delta`
  riêng cho các chỉ số mà giảm mới là tốt.

**Bảng:**
- Bọc bảng trong `<div class="scroll">` để bảng cuộn ngang trên điện thoại. Cột đầu tự giữ lại khi cuộn
  dưới 48rem.
- Cột số dùng `class="num"`.
- Ô văn bản dài dùng `td.wrap`.
- Không có viền ngoài. Tiêu đề cột viết hoa chữ đầu, nhỏ, màu `--muted`.

**Danh sách:** `<ul class="list">`, các dòng ngăn bằng đường kẻ mảnh. Trong một dòng:
- `.row` là hàng flex có xuống dòng;
- `.sub` là dòng phụ nhỏ hơn, thêm `.muted` để làm mờ.

**Cảnh báo:** `<ul class="alerts">`, mỗi `li` gồm một `pill(tone, chữ)` và nội dung.

**Chip và thẻ:**
- `pill(tone, text)`, với tone là `ok | warn | bad | info | mute`, là chip trạng thái có nền nhạt.
- `.tag` là mã, version hay tên tham số, chữ đơn cách, viền mảnh.

**Lưới chỉ số nhỏ:**
- `.facts` tự chia cột.
- Bên trong, mỗi mục là `<div><span class="label">nhãn</span>giá trị</div>`.

**Form:**
- Ô nhập là viên thuốc cao 44px; `textarea` bo 10px.
- Nút: `button` là nút chính tím đặc (mỗi trang chỉ một), `.ghost` là nút viền, `.danger` là nút viền đỏ.
- Nhóm nút đặt trong `.inline`.
- Mỗi ô nhập cần `<label>` hoặc `aria-label`.
- Form có file: `enctype="multipart/form-data"`, `<input type="file">` trong `<label>`. Server đọc các trường như cũ
  (`req.form`, token CSRF vẫn kiểm) và đưa file vào `req.files`; route tự kiểm file là gì (develop: theo byte đầu).
  `develop/paste.js` thêm dán và kéo thả cho ô `input[type=file][name=images]` đầu tiên trên trang (chữ gợi ý cũng do
  script thêm, nên không có script thì không hứa); ô cần `data-max` là số ảnh tối đa.
  Ô có thể thêm `data-preview="<id>"` (chỗ đặt hình xem trước) và `data-hint="<id textarea>"` (gợi ý thêm vào placeholder
  thay vì một dòng chữ), như khung trả lời của trang task.

**Khung trả lời của trang task** (owner 09/11): dính ở đáy màn hình khi cuộn tin (`position: sticky`, trên dock ở điện
thoại), nền cùng màu panel. Trong một khung bo tròn: hình xem trước, ô chữ tự cao theo nội dung (`field-sizing: content`,
tối đa 40% màn hình), rồi một thanh: nút Ảnh, chip chế độ chạy (icon và nhãn rút gọn, mở ra thì chiếm một hàng), hai nút.
Link vào trang task kết thúc bằng `#latest` (id của tin mới nhất), nên trang mở ở tin mới nhất mà không cần script.
Ô mở suốt lượt chạy: tin gửi lúc Claude đang làm hay đang chờ việc nền đi thẳng vào phiên (`data-state` của form:
`reply`, `queued`, `live`, `waiting`, `cancel`; chế độ chạy và "Duyệt và làm" chỉ hiện ở `reply`). `chat.js`: Enter gửi trên
máy có bàn phím (Shift+Enter xuống dòng; bàn phím cảm ứng thì Enter xuống dòng, Ctrl/⌘+Enter gửi; không gửi khi bộ gõ đang
soạn dấu), gửi bằng `fetch` (`/send?js=1` trả `{ok, why}`), hỏi `/develop/task/:id/live?after=<id>` mỗi 2 giây khi có lượt
(15 giây khi không) để thêm tin mới, bong bóng "Claude đang…" (`#typing`), thay panel `#live`, `#status`, `#steps`; theo tin
mới khi đang ở cuối, không thì hiện nút "Tin mới bên dưới"; giữ nháp trong `localStorage`; nút "Chép" trên tin của Claude.

**Hội thoại:** `.msg` cho tin của Claude, `.msg.me` cho tin của bạn (căn phải, nền tím nhạt), `.who` là dòng
người gửi.

**Markdown Claude viết:** `md(text)` trong `core/md.ts` trả về `<div class="md">…</div>`. Nó escape mọi đoạn trước,
chỉ tạo link `https`, dựng bảng bằng `.scroll`/`.num`/`.wrap` sẵn có. Chữ nhiều dòng do Claude viết (trả lời, báo
cáo) thì dùng hàm này; chữ người gõ thì giữ nguyên bằng `esc()`.

**Biểu đồ:**
- `lineChart(...)` vẽ đường theo ngày, MA7 tím, MA28 tím nhạt nét đứt.
- `bigChart(...)` là bản toàn màn hình: vùng vẽ giãn theo khung CSS cho (`preserveAspectRatio="none"`, nét không giãn),
  nhãn trục, số cuối và vạch mốc là HTML đặt theo %, nên giữ cỡ chữ dù điện thoại cầm dọc hay ngang hay màn 2560px.
  Đặt nó trong một khung có chiều cao (Report: `.report-zoom-chart`).
- Report: mỗi thẻ biểu đồ có link "Phóng to", và bấm vào chính biểu đồ cũng mở trang
  `/report/app/<app>/chart/<id>?d=14|30|90|180|all`. Trang đó là trang `bare`, màn đầu chỉ có biểu đồ, bảng số ở dưới.
- `sparkline(...)` là biểu đồ nhỏ không trục.
- `.charts` là lưới cho các thẻ biểu đồ.

**Ẩn bớt:** `<details><summary>…</summary>…</details>`.

**Trống, lỗi:**
- `empty(text)` cho chỗ chưa có gì.
- `stale(slot, now)` cho lỗi của lần chạy cuối, giữ số cũ bên dưới.

## CSS riêng của module

Một module có thể có `css: string` (xem `Module` trong `src/core/types.ts`); hub nối nó vào sau stylesheet
chung. Mọi selector phải bắt đầu bằng class riêng của module (`.develop-board …`), chỉ dùng token, và viết
mobile trước với các điểm ngắt ở trên.

## Xem thử

Chạy một hub xem thử cạnh hub thật. Nó không chạy bộ lấy số nào và không mở cổng của extension:

```
PORT=8790 HUB_PAUSE='*' node src/main.ts                                # đọc data/ thật, chỉ để xem
PORT=8791 HUB_PAUSE='*' HUB_DATA=/đường/dẫn/bản-sao node src/main.ts    # dùng một bản sao của data/
```

Trên Windows (PowerShell, một cửa sổ mới vì biến còn lại tới khi đóng): `$env:PORT=8790; $env:HUB_PAUSE='*'; node src/main.ts`

Trang chỉ đọc lại code khi khởi động lại tiến trình. Cần dữ liệu mẫu (ví dụ task Develop) thì dùng
`HUB_DATA` trỏ vào một bản sao, đừng ghi vào `data/hub.db` thật.

## Trang Thông báo và chuông (module `notify`)

- **Chuông:** trên thanh trên, trước đồng hồ (`.top-end`), ô bấm 44px, số chưa đọc màu nhấn tím (tin mới, không phải lỗi;
  số đỏ của "Hôm nay" vẫn là việc cần để ý). Chỉ hiện khi một module đặt `bell.href`; trang `bare` không có.
- **Trang `/ops/notify`:** panel "Thông báo đẩy" đứng trước (trên điện thoại nút bật không bị đẩy xuống dưới 100 thông báo),
  rồi "Đã báo" (mới nhất trước, chip "Mới" và vạch tím bên trái cho thông báo chưa đọc). Mở trang là đã đọc hết; trang
  không tự tải lại. Tablet: hai panel cạnh nhau; từ 80rem danh sách rộng 2 cột.
- **Script `push.js`** (owner duyệt Web Push 09/11, cần script để đăng ký): không có nó thì trang vẫn liệt kê, chỉ không
  bật được thông báo đẩy. Chữ đặt bằng `textContent`. Không gọi `subscribe()` thật khi kiểm thử (nó đăng ký với dịch vụ
  đẩy của Google): xem thử bằng cách thay `PushManager.prototype.subscribe` trong trang.

## Trang Theo dõi (module `track`)

- **Bảng:** mỗi đợt đang chạy một panel (`.track-card`): A và B, từ lúc nào (giờ VN), thanh tỉ lệ user mới mỗi nhánh
  (`.track-split`, vạch là tỉ lệ kỳ vọng, số ghi bằng chữ bên dưới), chip SRM, 3–4 chỉ số với mức chênh và khoảng 95%, dòng
  ngày kết luận. Chỉ chỉ số chính có chip kết luận (trước điểm quyết định chữ nhạt "Tạm thời: …", không màu); chỉ số khác
  màu trung tính, cột kết luận ghi "Tham khảo". Rồi panel gợi ý (có tỉ lệ kỳ vọng) (nút, không ô chữ, vì trang nhóm tự tải lại), dòng thời gian 30 ngày (một hàng mỗi app, mốc là
  hình CSS kèm `title`, đợt là thanh bấm được, danh sách "Các mốc gần đây" cho điện thoại), panel "Khác".
- **Hai nhánh:** A là `--ink-2` nét đứt (nhánh gốc), B là `--accent`; luôn có chú thích và nhãn cuối đường, không chỉ màu.
  Hub chưa có cặp token màu phân loại thứ hai: kiểm bằng validator của skill dataviz, xám/tím trượt ngưỡng chroma, tím/tím
  nhạt trượt ngưỡng phân biệt, nên dùng nét đứt làm mã hoá phụ.
- **Biểu đồ `xyChart`** (`lib/svg.ts`): trục x là số (giờ, ngày từ lúc cài), dựng như `bigChart` (vùng vẽ giãn, chữ HTML
  giữ cỡ), nên cần một khung có chiều cao (`.track-xy { height: 13rem }`); màu nét do class của module.
- **Mức chênh:** `.track-forest`, trục đối xứng quanh 0 theo các chỉ số đủ mẫu; điểm vượt trục rỗng ruột, số bên cạnh là giá trị.
  Chỉ chỉ số chính có màu xanh/đỏ, và chỉ khi đã kết luận.
- **Form đợt:** `input[type=datetime-local]` theo giờ VN (stylesheet chung chưa có kiểu cho loại ô này: module tự thêm), ô
  "Số ngày trước khi kết luận" (1–28, mặc định 7). Lưu form giữ giờ RC chính xác tới giây khi phút không đổi.
- **Tổng quan của đợt:** `.kv` và `.tag` trong `.track-aside` được xuống dòng (condition RC dài như
  `AB_NativeCollap_Close_1103` không kéo rộng panel ở 360 px).
