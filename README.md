# News247US Studio

Ứng dụng biến **video YouTube** thành **bài báo** rồi đăng thẳng lên website **https://news247us.cfx.bz**.

Luồng xử lý bài báo: `Link video → Transcript → Gemini viết bài → Biên tập → Đăng bài`.

Luồng Facebook Reels: `AI chọn highlight → tải video → cắt clip dọc 9:16 → viết title/mô tả + hashtag → tự đăng lên các Page`.

- **Node.js + Express**: giao diện web, cấu hình, lịch sử, upload ảnh, gọi API website và Facebook Graph API.
- **Python + FastAPI**: lấy metadata/phụ đề bằng `yt-dlp`, gọi Gemini, chuẩn hoá HTML, cắt clip bằng `ffmpeg`.
- **Giao diện tiếng Việt**, xem trước bài viết trước khi đăng; clip Facebook tự đăng ngay sau khi tạo.

---

## 1. Yêu cầu

| Thành phần | Phiên bản |
|---|---|
| Node.js | 18+ (đã kiểm tra với 24) |
| Python | 3.10+ (đã kiểm tra với 3.12) |
| yt-dlp | Tự cài trong `setup.bat` |
| ffmpeg | `imageio-ffmpeg` (cài qua `requirements.txt`) |

`ffmpeg` bắt buộc cho tính năng cắt clip Facebook Reels; `imageio-ffmpeg` tự tải binary nên không cần cài thủ công. `faster-whisper` được cài sẵn để tự phiên âm video không có phụ đề.

## 2. Cài đặt và chạy

Lấy code từ GitHub:

```bat
git clone https://github.com/vzetiZero/quanly_page_web.git
cd quanly_page_web
setup.bat
start.bat
```

Hoặc chạy trực tiếp trong thư mục dự án:

```bat
setup.bat
start.bat
```

`setup.bat` tạo `.venv`, cài thư viện Python, cài npm và tạo `.env` từ `.env.example` nếu chưa có.

`start.bat` chạy `node server.js`; server tự khởi động Python worker và mở trình duyệt tại **http://localhost:4300**.

Chạy thủ công:

```bat
.venv\Scripts\python.exe -m uvicorn worker:app --host 127.0.0.1 --port 8000
node server.js
```

> Cổng mặc định là **4300** (cổng 3000 thường bị VS Code Live Preview chiếm). Đổi bằng `PORT` trong `.env`.

## 3. Cấu hình

Mở nút **Cài đặt** trên giao diện cho AI/website. Key được che dạng `••••1234`; để trống ô key nếu muốn giữ key cũ.

Cấu hình AI/website và Facebook được lưu cục bộ trong `data/config.json` và `data/facebook.json`. Hai file này **không** đưa lên GitHub, nên máy đang chạy không phải nhập lại key sau mỗi lần khởi động. Khi chuyển sang máy khác hoặc người dùng khác, chỉ cần mở **Cài đặt** / tab **Facebook Page** và nhập lại API key, token.

Cấu hình Facebook nằm trong tab **Facebook Page** ở đầu trang (hoặc nút **Cấu hình Page** trong thẻ Đăng Facebook Reels sẽ mở thẳng tab này), không còn nằm trong hộp Cài đặt chung. Tab này hiển thị đầy đủ danh sách Page kèm ô tìm kiếm theo tên, ID và danh mục; tick chọn xong bấm **Lưu cấu hình Page**. Hashtag được nhập ngay trong thẻ tạo clip.

### 3.1 LLM (Vilao AI / Gemini)

Ứng dụng đã cấu hình sẵn cho **Vilao AI**:

| Trường | Giá trị |
|---|---|
| Base URL | `https://api.vilao.ai/v1` |
| API key | Key `sk-...` tạo tại Vilao Console |
| Model | `chib/gemini-3.8-flash` |
| Kiểu API | `openai` (OpenAI-compatible) |

Vilao xác thực bằng header `Authorization: Bearer <key>` và dùng chung format `/chat/completions`, nên có thể thay bằng bất kỳ nhà cung cấp OpenAI-compatible nào.

Theo tài liệu Vilao, mỗi key phải **subscribe** model trong Console → LLM → API Keys. Lỗi thường gặp:

| HTTP | Nguyên nhân |
|---|---|
| 401 | Key sai hoặc đã xoá |
| 402 | Hết số dư ví |
| 403 | Chưa subscribe model |
| 429 | Vượt rate limit |

Nếu dùng **Google Gemini chính thức**: Base URL `https://generativelanguage.googleapis.com`, key dạng `AIza...`, kiểu `google`, model `gemini-2.5-flash`. Dùng key `sk-...` với endpoint Google sẽ báo `API key not valid`.

### 3.2 Website đăng bài

```
API Base URL: https://news247us.cfx.bz/api
API key:      <dán key của bạn trong Cài đặt>
```

Nút **Kiểm tra website** trả về tài khoản đang dùng (ví dụ `Admin / news247us_c1ea24`).

### 3.3 Biến môi trường (`.env`)

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `PORT` | `4300` | Cổng giao diện |
| `PYTHON_PORT` | `8000` | Cổng worker nội bộ |
| `AUTO_START_PYTHON` | `1` | Tự chạy worker từ `.venv` |
| `OPEN_BROWSER` | `1` | Tự mở trình duyệt |
| `WHISPER_ENABLED` | `1` | Tự phiên âm khi video không có phụ đề; đặt `0` để tắt |
| `WHISPER_MODEL` | `small` | `tiny/base/small/medium/large-v3` |
| `YTDLP_COOKIES_FILE` | trống | Đường dẫn `cookies.txt` khi YouTube chặn IP |
| `FB_ACCESS_TOKEN` | trống | Token mặc định, thường dán trong giao diện thay vì `.env` |
| `FB_API_VERSION` | `v25.0` | Graph API version |
| `FB_HASHTAGS` | trống | Hashtag mặc định gắn vào title |
| `FB_CLIP_COUNT` | `5` | Số clip mỗi video (1–10) |
| `FB_MAX_SOURCE_SECONDS` | `7200` | Giới hạn độ dài video gốc (giây) |

`data/config.json` và `data/facebook.json` (sinh ra khi bấm Lưu cài đặt / Lưu cấu hình Page) được ưu tiên hơn `.env`, và đã nằm trong `.gitignore`.

### 3.4 Facebook Page / Reels

Ứng dụng dùng **Facebook Graph API chính thức** (`https://graph.facebook.com/{version}`) với **user access token**, rồi tự đổi sang Page token qua `/me/accounts`.

Quyền bắt buộc:

| Quyền | Dùng để |
|---|---|
| `pages_show_list` | Liệt kê Page |
| `pages_read_engagement` | Đọc thông tin Page |
| `pages_manage_posts` | Đăng Reels lên Page |
| `pages_manage_engagement` | Comment link bài viết dưới Reel |

Cách lấy token:

1. Tạo app tại [Meta for Developers](https://developers.facebook.com/apps/) (loại Business).
2. Mở **Graph API Explorer**, chọn app, thêm 3 quyền trên và tạo **User access token**.
3. Mở tab **Facebook Page** ở đầu trang (hoặc **Cấu hình Page** trong thẻ Facebook), dán token và bấm **Kiểm tra token**.
4. Bấm **Tải danh sách Page**, dùng ô tìm kiếm hoặc **Chọn tất cả**, tick các Page muốn đăng, rồi **Lưu cấu hình Page**.

Token ngắn hạn của Graph API Explorer hết hạn sau khoảng 1–2 giờ. Để chạy lâu dài, đổi sang long-lived token (khoảng 60 ngày) theo hướng dẫn **Access Tokens** của Graph API, hoặc dùng System User token nếu có Business Manager.

Cấu hình dùng chung cho mọi Page:

| Trường | Ý nghĩa |
|---|---|
| Graph API version | Mặc định `v25.0` |
| Số clip mỗi video | 1–10; AI có thể trả ít hơn nếu video ngắn |
| Độ dài clip | Đặt khoảng tối thiểu/tối đa (giây) trong tab **Facebook Page** |
| Số luồng | Đặt từ 1–8 trong tab **Facebook Page**; thay đổi áp dụng ngay khi lưu |
| Page đã chọn | Mỗi Page nhận **1 clip ngẫu nhiên** trong số clip đã tạo |

Độ dài mặc định **45–75 giây** (có thể chỉnh trong giao diện), xuất **Reels dọc 9:16** với nền mờ. Hashtag do AI chọn cho từng clip.

## 4. Sử dụng

1. Dán link YouTube (hỗ trợ `watch?v=`, `youtu.be`, `shorts`, `embed`, `live`).
2. Chọn ngôn ngữ bài, giọng văn, độ dài, danh mục gợi ý (tùy chọn).
3. Bấm **Phân tích & viết bài** và theo dõi 3 bước: lấy phụ đề → Gemini viết → hoàn tất.
4. Kiểm tra **Nội dung HTML** / **Xem trước**, sửa tiêu đề, SEO, tags, danh mục.
5. Chọn ảnh đại diện: tải ảnh mới (lên R2) hoặc dùng thumbnail YouTube.
6. Bấm **Đăng lên news247us**. Link bài viết hiện ra sau khi đăng thành công, kèm trạng thái có trên trang chủ.

Nếu bước AI lỗi, transcript vẫn được giữ lại và có nút **Thử lại** — không phải tải video lại từ đầu.

### 4.1 Chạy hàng loạt

Dán danh sách link vào ô **Danh sách link YouTube** (mỗi dòng một link, tối đa 40) rồi bấm **Phân tích hàng loạt**.

- Số luồng mặc định là 4, chỉnh từ 1–8 ngay trong cấu hình Facebook Page; thay đổi được áp dụng khi lưu.
- Mỗi video có một card riêng: tiến độ, số lần AI thử lại, **Mở bài**, **Thử lại riêng**, **Huỷ**.
- Khi có bài xong, nút **Đăng hàng loạt** đăng lần lượt tất cả bài chưa đăng lên website, lưu lịch sử và gắn link bài vào từng card. Bài đã đăng trước đó (cùng link video) được bỏ qua để tránh tạo bài trùng.
- AI tự thử lại khi lỗi mạng, timeout hoặc trả JSON không hợp lệ cho tới khi có bài đạt yêu cầu. Lỗi cấu hình (sai API key, sai model) dừng ngay để tránh chờ vô ích.
- Tag do AI chọn được lọc theo đúng danh sách tag đang có trên website; tag không tồn tại bị loại bỏ.

### 4.2 Sửa hoặc xoá bài đã đăng

Bài đã đăng được lưu trong **Lịch sử** kèm `post_id` của website.

- **Sửa:** bấm **Mở** ở bài đã đăng → chỉnh nội dung → nút đổi thành **Cập nhật bài đăng**. Ứng dụng gọi `PUT /posts` và giữ nguyên permalink/link.
- **Xoá:** bấm **Xoá** ở bài đã đăng → xác nhận → ứng dụng gọi `DELETE /posts` để xoá trên website, sau đó xoá mục lịch sử.
- Bài cũ không có `post_id` (tạo trước khi bật tính năng này) chỉ xoá được khỏi lịch sử cục bộ; cần xoá trên admin website.

### 4.3 Đăng Facebook Reels

Có thể dán nhiều URL YouTube (mỗi dòng một URL) vào danh sách nguồn. Ứng dụng chạy từng nguồn thành một job và dùng số luồng `JOB_WORKERS`; mỗi nguồn tự tìm link bài đã đăng theo YouTube ID trong lịch sử. Có thể ghi `URL video | URL bài viết` để ghi đè link tự ghép. Mỗi nhóm kết quả hiển thị clip và trạng thái comment riêng cho nguồn đó.

Danh sách nguồn nằm trong tab **Facebook Page**. Nếu để trống, ứng dụng lấy danh sách URL YouTube ở tab **Bài viết**. Link comment được tự ghép theo YouTube ID từ lịch sử bài đã đăng; nguồn chưa có bài khớp vẫn được xử lý nhưng Reel sẽ không có comment link. Có thể chỉ định thủ công bằng định dạng `URL video | URL bài viết`.

1. Kiểm tra số Page, số clip mỗi nguồn, khoảng độ dài clip và số luồng.
2. Xem trước URL nguồn và link bài viết được ghép cho từng dòng.
3. Bấm **Tạo clip & đăng Facebook**. Các nguồn chạy song song theo giới hạn luồng đã cấu hình. Mỗi nguồn tự chạy:
   `lấy metadata → transcript có timestamp → AI chọn highlight → tải video 720p → cắt clip dọc 9:16 → viết title/mô tả/hashtag → đăng Reels → comment link bài viết`.
4. Theo dõi tiến trình và log của từng URL. Reel được đăng ngay khi clip cắt xong.
5. Bấm **HUỶ** để gửi yêu cầu huỷ các job đang chạy.
6. Kết quả được nhóm theo URL nguồn, gồm clip, link Reel và trạng thái comment. **Copy caption** sao chép title + hashtag + mô tả.
7. Các lần đăng gần đây nằm trong **Lần đăng gần đây** (tối đa 30 mục, lưu ở `data/facebook-history.json`).

Lưu ý:

- Mỗi Page chỉ đăng **1 clip ngẫu nhiên** trong số clip đã tạo; 5 clip × 3 Page = 3 lần đăng. Clip được xáo trộn để các Page nhận clip khác nhau khi số clip đủ.
- Nếu số Page nhiều hơn số clip, clip được dùng lại cho Page dư; **mọi Page vẫn đăng đúng 1 clip** kèm title, mô tả, hashtag đầy đủ.
- Sau khi Reel đăng xong, ứng dụng comment `There’s more to this story than it seems 👇` kèm link bài viết. Comment lỗi không làm hỏng Reel; lỗi hiện trong kết quả và cảnh báo của job.
- Nếu một Page lỗi, các Page còn lại vẫn tiếp tục; job chỉ báo lỗi hoàn toàn khi tất cả lần đăng đều thất bại.
- Video không có phụ đề được tự phiên âm bằng `faster-whisper` (`WHISPER_ENABLED=1`), không cần thao tác thêm. Video phải dài hơn độ dài clip tối thiểu; giới hạn mặc định 2 giờ/video.
- Clip đã cắt được giữ trong `downloads/fb-<id>/clips/` và có nút **Mở video** ở từng thẻ kết quả. File nguồn và dữ liệu tạm khác được dọn sau khi job kết thúc.
- Facebook có thể cần thời gian xử lý video sau khi `finish`; ứng dụng chờ tối đa 4 phút cho mỗi Reels trước khi báo lỗi.

## 5. Những gì API website nhận và không nhận

Đã kiểm tra trực tiếp với `https://news247us.cfx.bz/api`:

| Trường | Hỗ trợ |
|---|---|
| `title` | Có |
| `content` (HTML) | Có |
| `permalink` | Có |
| `seo_description` | Có |
| `tags` | Có |
| `category_id` | **Không** (bị bỏ qua) |
| `featured_image` | **Không** (bài mới dùng ảnh mặc định) |
| `author` | Không gửi — API tự thêm hậu tố `-admin` vào permalink |

Vì vậy ứng dụng:

- Chèn **ảnh đại diện** vào đầu bài dưới dạng `<p><img src="..."></p>` (ảnh đã upload lên R2).
- Chèn **iframe YouTube** (`youtube-nocookie.com`) ngay sau đoạn mở đầu.
- Không gửi `author` để permalink sạch.
- Danh mục chỉ dùng làm gợi ý cho AI; muốn đổi danh mục/ảnh đại diện phải vào admin website.

### Quản lý bài viết qua API

| Thao tác | Request | Ghi chú |
|---|---|---|
| Đăng bài | `POST /posts` | Trả `postId`, `slug`, `link` |
| Sửa bài | `PUT /posts` | Body bắt buộc: `id`, `title`, `content`, `permalink`; tùy chọn `seo_description`, `tags` |
| Xoá bài | `DELETE /posts` | Body: `{"id": <postId>}` |
| Danh sách / chi tiết | **Không có** | `GET /posts` và `GET /posts/{id}` trả 404/405 |

Vì không có endpoint danh sách, ứng dụng quản lý các bài do chính nó đăng thông qua `data/history.json`. Bài đăng từ công cụ khác phải sửa/xoá trong admin website.

Lưu ý: website có cache Cloudflare theo đường dẫn (khoảng 4 giờ). Sau khi sửa, trang public có thể còn nội dung cũ dù API đã cập nhật; đổi permalink hoặc chờ cache hết hạn. Kiểm tra bài mới nên dùng permalink mới.

### Kiểm tra sau khi đăng

Trang chủ render bài mới trong HTML, nhưng theme sau đó gọi `/ajax/theme/lasted-new` và thay danh sách Latest News bằng dữ liệu từ cache phía server. Ứng dụng chỉ kiểm tra bài đã có trong trang chủ hay chưa và không hiển thị cảnh báo về cache Latest News.

Sau khi đăng, ứng dụng tự kiểm tra và hiển thị một trong hai trạng thái:

- **Bài đã có trên trang chủ** — không cần làm gì.
- **Chưa thấy bài trên trang chủ** — mở link bài để kiểm tra; có thể bài chưa được duyệt hoặc trang chủ đang cache.

Nút **Kiểm tra trang chủ** gọi `GET /api/app/visibility?slug=<permalink>&id=<postId>`, đối chiếu HTML trang chủ và AJAX Latest News.

## 6. Cấu trúc dự án

```
server.js               Express: UI, proxy Python, publish, upload, history
lib/
  config.js             Đọc/ghi cấu hình, che key
  site-api.js           Client API website + upload R2
  content.js            Slug, tags, ghép ảnh + iframe vào HTML
  history.js            Lịch sử bài viết (data/history.json)
  facebook-config.js    Token, Page, hashtag, số clip (data/facebook.json)
  fb-history.js         Lịch sử đăng Reels (data/facebook-history.json)
python/
  worker.py             FastAPI worker, job queue, tiến trình
  transcript.py         yt-dlp metadata/phụ đề, Whisper fallback
  ai.py                 Gemini (Google & OpenAI-compatible)
  article.py            Chuẩn hoá JSON, sanitize HTML, slug
  clips.py              Tải video, cắt clip dọc 9:16 bằng ffmpeg
  facebook.py           Graph API: token, Page, upload Reels
  prompts.py            Prompt biên tập + prompt chọn highlight
public/                 Giao diện (index.html, styles.css, app.js)
data/                   config.json, facebook.json, history.json (tự sinh)
downloads/              File tạm của yt-dlp và clip
```

## 7. API nội bộ

| Method | Đường dẫn | Chức năng |
|---|---|---|
| GET | `/api/app/health` | Trạng thái Node, Python, cấu hình |
| GET/PUT | `/api/app/config` | Đọc/lưu cấu hình |
| POST | `/api/app/ai/test` | Kiểm tra Gemini |
| POST | `/api/app/site/test` | Kiểm tra API website |
| GET | `/api/app/categories`, `/tags` | Danh mục, tag từ website |
| POST | `/api/app/analyze` | Tạo job phân tích |
| GET | `/api/app/jobs/:id` | Tiến trình, transcript, kết quả (`status`: `queued`, `running`, `done`, `error`, `cancelled`) |
| POST | `/api/app/jobs/:id/cancel` | Huỷ job đang chạy (dùng chung cho job bài viết và job Facebook) |
| POST | `/api/app/preview` | Render HTML xem trước |
| POST | `/api/app/upload-image` | Upload ảnh lên R2 |
| POST | `/api/app/publish` | Đăng bài mới |
| PUT | `/api/app/posts/:id` | Cập nhật bài đã đăng |
| DELETE | `/api/app/posts/:id` | Xoá bài trên website |
| GET | `/api/app/visibility` | Kiểm tra bài có trên trang chủ / Latest News |
| GET/POST/DELETE | `/api/app/history` | Lịch sử cục bộ |
| GET/PUT | `/api/app/facebook/config` | Cấu hình Facebook (token được che) |
| POST | `/api/app/facebook/test` | Kiểm tra token và quyền |
| POST | `/api/app/facebook/pages` | Tải danh sách Page, lưu token |
| POST | `/api/app/facebook/jobs` | Tạo job cắt clip + đăng Reels |
| POST | `/api/app/facebook/batches` | Tạo nhiều job Facebook; tự ghép link bài viết theo YouTube ID |
| GET | `/api/app/facebook/jobs/:id` | Tiến trình, clip, lỗi từng Page |
| GET | `/api/app/facebook/history` | Lịch sử đăng Reels |

## 8. Xử lý sự cố

**`Cổng 4300 đang bị chiếm`** — đổi `PORT` trong `.env`, hoặc tắt tiến trình đang dùng cổng.

**`ModuleNotFoundError: No module named 'tinycss2'`** — chạy lại `setup.bat`, hoặc:

```bat
.venv\Scripts\python.exe -m pip install -r python\requirements.txt
```

**`Sign in to confirm you're not a bot`** — YouTube chặn IP. Xuất `cookies.txt` từ trình duyệt, đặt đường dẫn vào `YTDLP_COOKIES_FILE` trong `.env`.

**Video không có phụ đề** — ứng dụng tự phiên âm bằng `faster-whisper` (mặc định `WHISPER_ENABLED=1`). Nếu log báo thiếu thư viện, cài lại:

```bat
.venv\Scripts\python.exe -m pip install -r python\requirements.txt
```

Nếu máy yếu và muốn tắt fallback, đặt `WHISPER_ENABLED=0` (khi đó video không có phụ đề sẽ báo lỗi).

**`API key not valid`** — key `sk-...` đang gọi nhầm endpoint Google; xem mục 3.1.

**Bài đăng không thấy thay đổi** — cache Cloudflare ~4 giờ; dùng permalink mới hoặc chờ cache hết hạn.

**Bài mới chưa hiện ở Latest News** — cache AJAX của theme có thể trả danh sách cũ 1–4 giờ. Ứng dụng không cảnh báo trường hợp này; bài vẫn có trên trang chủ và truy cập được bằng link.

**Facebook báo `Invalid OAuth access token` (code 190)** — token sai hoặc đã hết hạn. Tạo token mới trong Graph API Explorer, dán vào tab **Facebook Page**, bấm **Kiểm tra token** rồi **Tải danh sách Page**.

**Facebook báo thiếu quyền** — token chưa có `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_engagement` (cần cho comment link bài viết), hoặc tài khoản không có quyền đăng trên Page. Kiểm tra lại app và vai trò trên Page.

**Không tải được Page** — `/me/accounts` không trả Page. Ứng dụng tự thử qua Business Manager (`/me/businesses` → `owned_pages`/`client_pages`); nếu vẫn trống, thêm tài khoản vào Page hoặc cấp quyền trong Business Manager.

**`ffmpeg` không tìm thấy** — chạy `.venv\Scripts\python.exe -m pip install -r python\requirements.txt` để cài `imageio-ffmpeg`, rồi kiểm tra `/api/app/health` có `"ffmpeg": true`.

**Video quá dài / không đủ ngắn để cắt clip** — giới hạn mặc định 2 giờ, video phải dài hơn độ dài clip tối thiểu (45 giây). Đổi `FB_MAX_SOURCE_SECONDS` hoặc dùng video ngắn hơn.

**Job Facebook dừng ở "AI chọn highlight"** — AI không trả JSON hợp lệ hoặc transcript không có timestamp. Thử lại, giảm số clip; video không có phụ đề sẽ tự chuyển sang Whisper nên không cần bật tay.

## 9. Hướng phát triển tiếp

- Hàng đợi nhiều video, chạy nền và thông báo khi xong.
- Lưu nháp vào website thay vì chỉ lưu cục bộ.
- Tự tạo ảnh thumbnail bằng AI.
- Chọn nhiều giọng văn / template theo từng danh mục.
- Tự động retry khi Gemini quá tải (429).
