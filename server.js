const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const express = require('express');
const multer = require('multer');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const config = require('./lib/config');
const fbConfig = require('./lib/facebook-config');
const fbHistory = require('./lib/fb-history');
const history = require('./lib/history');
const site = require('./lib/site-api');
const { slugify, parseYouTubeId, buildContent, normalizeTags } = require('./lib/content');

const PORT = Number(process.env.PORT) || 4300;
const HOST = process.env.HOST || '127.0.0.1';
const PY_PORT = Number(process.env.PYTHON_PORT) || 8000;
const PY_URL = `http://127.0.0.1:${PY_PORT}`;
const AUTO_START = process.env.AUTO_START_PYTHON !== '0';
const OPEN_BROWSER = process.env.OPEN_BROWSER !== '0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' }));
app.use('/api/app', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      const error = new Error('Chỉ chấp nhận file ảnh.');
      error.status = 400;
      cb(error);
      return;
    }
    cb(null, true);
  }
});

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeUrlList(value) {
  const parts = Array.isArray(value)
    ? value
    : String(value || '').split(/[\s,;]+/);
  const urls = [];
  const invalid = [];
  const seen = new Set();
  for (const part of parts) {
    const url = String(part || '').trim();
    if (!url) continue;
    if (!isHttpUrl(url)) {
      invalid.push(url);
      continue;
    }
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return { urls, invalid };
}

function analyzeOptions(body, cfg) {
  return {
    language: ['en', 'vi'].includes(body.language) ? body.language : cfg.language,
    tone: ['neutral', 'dramatic', 'analytical'].includes(body.tone) ? body.tone : cfg.tone,
    length: ['short', 'standard', 'long'].includes(body.length) ? body.length : cfg.length,
    instructions: String(body.instructions || '').slice(0, 1000)
  };
}

function siteOrigin() {
  return new URL(site.baseUrl()).origin;
}

async function fetchPublic(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'User-Agent': 'News247US-Studio/1.0',
      ...headers
    },
    signal: AbortSignal.timeout(15000)
  });
  return { ok: response.ok, status: response.status, text: await response.text() };
}

function buildPostPayload(body) {
  const title = String(body.title || '').trim();
  const contentHtml = String(body.content_html || '').trim();
  if (!title) throw httpError(400, 'Thiếu tiêu đề bài viết.');
  if (!contentHtml) throw httpError(400, 'Thiếu nội dung bài viết.');

  const permalink = slugify(body.permalink || title) || `news-${Date.now()}`;

  const youtubeId = parseYouTubeId(body.video_url);
  const featureImage =
    String(body.thumbnail_url || '').trim() ||
    (youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg` : '');
  if (!featureImage) {
    throw httpError(400, 'Bài viết cần có ảnh bìa. Hãy tải ảnh lên hoặc dùng thumbnail YouTube.');
  }

  const { content, warnings } = buildContent({
    contentHtml,
    videoUrl: body.video_url,
    thumbnailUrl: featureImage,
    title
  });

  const tags = normalizeTags(body.tags);
  return {
    title,
    content,
    permalink,
    seoTitle: String(body.seo_title || title).trim().slice(0, 160),
    seoDescription: String(body.seo_description || '').trim().slice(0, 160),
    seoKeyword: String(body.seokeyword || tags.join(', ')).trim().slice(0, 255),
    tags,
    categoryId: Number(body.category_id) || undefined,
    featureImage,
    warnings
  };
}

// API site nhận tags là mảng ID (integer[]), còn UI cho nhập tên tag -> tra ID theo tên.
async function withTagIds(payload) {
  if (!payload.tags.length) return payload;
  const items = await site.getTags().catch(() => []);
  const byName = new Map(
    items.map((item) => [String(item.name || '').trim().toLowerCase(), Number(item.id)])
  );
  const ids = [];
  const missing = [];
  for (const name of payload.tags) {
    const id = byName.get(name.toLowerCase());
    if (id) ids.push(id);
    else missing.push(name);
  }
  if (!missing.length) return { ...payload, tags: ids };
  return {
    ...payload,
    tags: ids,
    warnings: [...payload.warnings, `Tag chưa có trên website nên bị bỏ qua: ${missing.join(', ')}.`]
  };
}

async function pyRequest(endpoint, { method = 'GET', body, timeout = 20000 } = {}) {
  let response;
  try {
    response = await fetch(`${PY_URL}${endpoint}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (err) {
    throw httpError(
      502,
      'Python worker chưa sẵn sàng. Chạy start.bat hoặc kiểm tra cửa sổ log.'
    );
  }

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    let message = data.detail || data.message || `Python worker lỗi HTTP ${response.status}`;
    if (typeof message !== 'string') message = JSON.stringify(message);
    throw httpError(response.status >= 400 && response.status < 500 ? response.status : 502, message);
  }
  return data;
}

app.get('/api/app/health', asyncRoute(async (req, res) => {
  let python = { ok: false };
  try {
    python = await pyRequest('/health', { timeout: 1800 });
  } catch (err) {
    python = { ok: false, error: err.message };
  }
  const cfg = config.publicConfig();
  res.json({
    ok: true,
    python,
    aiConfigured: cfg.hasGeminiKey,
    siteConfigured: cfg.hasSiteKey,
    config: cfg
  });
}));

app.get('/api/app/config', (req, res) => {
  res.json({ config: config.publicConfig() });
});

app.put('/api/app/config', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const patch = {};
  const allowed = [
    'geminiBaseUrl',
    'geminiApiKey',
    'geminiModel',
    'geminiApiStyle',
    'siteBaseUrl',
    'siteApiKey',
    'language',
    'tone',
    'length'
  ];
  for (const key of allowed) {
    if (typeof body[key] === 'string') patch[key] = body[key].trim();
  }

  if (patch.geminiBaseUrl && !isHttpUrl(patch.geminiBaseUrl)) {
    throw httpError(400, 'Gemini Base URL không hợp lệ.');
  }
  if (patch.siteBaseUrl && !isHttpUrl(patch.siteBaseUrl)) {
    throw httpError(400, 'Địa chỉ API website không hợp lệ.');
  }
  if (patch.geminiApiStyle && !['auto', 'google', 'openai'].includes(patch.geminiApiStyle)) {
    throw httpError(400, 'Kiểu API AI không hợp lệ.');
  }
  if (patch.language && !['en', 'vi'].includes(patch.language)) {
    throw httpError(400, 'Ngôn ngữ không hợp lệ.');
  }
  if (patch.tone && !['neutral', 'dramatic', 'analytical'].includes(patch.tone)) {
    throw httpError(400, 'Giọng văn không hợp lệ.');
  }
  if (patch.length && !['short', 'standard', 'long'].includes(patch.length)) {
    throw httpError(400, 'Độ dài không hợp lệ.');
  }

  config.save(patch);
  res.json({ ok: true, config: config.publicConfig() });
}));

app.post('/api/app/ai/test', asyncRoute(async (req, res) => {
  const cfg = config.get();
  if (!cfg.geminiApiKey) {
    throw httpError(400, 'Chưa cấu hình Gemini API key.');
  }
  const result = await pyRequest('/ai/test', {
    method: 'POST',
    body: { ai: config.aiConfig() },
    timeout: 120000
  });
  res.json(result);
}));

app.post('/api/app/site/test', asyncRoute(async (req, res) => {
  const user = await site.getUser();
  res.json({
    ok: true,
    baseUrl: site.baseUrl(),
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role
    }
  });
}));

function facebookToken(body) {
  const token = String((body && body.accessToken) || fbConfig.get().accessToken || '').trim();
  if (!token) throw httpError(400, 'Chưa nhập Facebook user access token.');
  return token;
}

function validateApiVersion(value) {
  const version = String(value || '').trim();
  if (!/^v\d+\.\d+$/.test(version)) {
    throw httpError(400, 'Graph API version không hợp lệ (ví dụ v25.0).');
  }
  return version;
}

app.get('/api/app/facebook/config', (req, res) => {
  res.json({ ok: true, config: fbConfig.publicConfig() });
});

app.put('/api/app/facebook/config', (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (typeof body.accessToken === 'string') patch.accessToken = body.accessToken.trim();
  if (typeof body.hashtags === 'string') patch.hashtags = body.hashtags.trim();
  if (body.clipCount !== undefined) patch.clipCount = body.clipCount;
  if (body.minSeconds !== undefined) patch.minSeconds = body.minSeconds;
  if (body.maxSeconds !== undefined) patch.maxSeconds = body.maxSeconds;
  if (body.vertical !== undefined) patch.vertical = Boolean(body.vertical);
  if (Array.isArray(body.selectedPageIds)) patch.selectedPageIds = body.selectedPageIds;
  if (typeof body.apiVersion === 'string') patch.apiVersion = validateApiVersion(body.apiVersion);

  fbConfig.save(patch);
  res.json({ ok: true, config: fbConfig.publicConfig() });
});

app.post('/api/app/facebook/test', asyncRoute(async (req, res) => {
  const token = facebookToken(req.body);
  const version = validateApiVersion(
    (req.body && req.body.apiVersion) || fbConfig.get().apiVersion
  );
  const result = await pyRequest('/facebook/test', {
    method: 'POST',
    body: { accessToken: token, apiVersion: version },
    timeout: 60000
  });
  res.json(result);
}));

app.post('/api/app/facebook/pages', asyncRoute(async (req, res) => {
  const token = facebookToken(req.body);
  const version = validateApiVersion(
    (req.body && req.body.apiVersion) || fbConfig.get().apiVersion
  );
  const result = await pyRequest('/facebook/pages', {
    method: 'POST',
    body: { accessToken: token, apiVersion: version },
    timeout: 120000
  });
  fbConfig.save({ accessToken: token, apiVersion: version });
  fbConfig.setPages(result.pages || []);
  res.json({
    ok: true,
    count: (result.pages || []).length,
    config: fbConfig.publicConfig()
  });
}));

app.post('/api/app/facebook/jobs', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const url = String(body.url || '').trim();
  if (!isHttpUrl(url)) throw httpError(400, 'Link video không hợp lệ.');

  let cfg = fbConfig.get();
  if (!cfg.accessToken) {
    throw httpError(400, 'Chưa cấu hình Facebook access token. Mở Cài đặt.');
  }
  const pages = fbConfig.selectedPages();
  if (!pages.length) {
    throw httpError(400, 'Chưa chọn Page nào. Mở Cài đặt, tải danh sách và chọn Page.');
  }
  if (typeof body.hashtags === 'string') {
    cfg = fbConfig.save({ hashtags: body.hashtags.trim() });
  }

  const appCfg = config.get();
  const result = await pyRequest('/facebook/jobs', {
    method: 'POST',
    body: {
      url,
      pages: pages.map((page) => ({
        id: page.id,
        name: page.name,
        accessToken: page.accessToken
      })),
      hashtags: cfg.hashtags,
      clipCount: cfg.clipCount,
      minSeconds: cfg.minSeconds,
      maxSeconds: cfg.maxSeconds,
      vertical: cfg.vertical,
      language: appCfg.language,
      apiVersion: cfg.apiVersion,
      ai: config.aiConfig()
    },
    timeout: 30000
  });

  res.json({
    ok: true,
    jobId: result.jobId,
    pages: pages.map((page) => ({ id: page.id, name: page.name })),
    clipCount: cfg.clipCount
  });
}));

app.get('/api/app/facebook/jobs/:id', asyncRoute(async (req, res) => {
  const job = await pyRequest(`/jobs/${encodeURIComponent(req.params.id)}`, {
    timeout: 12000
  });
  if (
    job.type === 'facebook' &&
    (job.status === 'done' || job.status === 'error') &&
    job.result
  ) {
    const result = job.result;
    const posts = result.posts || [];
    fbHistory.upsert({
      id: job.id,
      at: new Date().toISOString(),
      videoUrl: (result.metadata && result.metadata.webpage_url) || '',
      videoTitle: (result.metadata && result.metadata.title) || '',
      pages: result.pages || [],
      clipCount: (result.clips || []).length,
      postedCount: result.postedCount || 0,
      failedCount: result.failedCount || 0,
      clips: (result.clips || []).map((clip) => ({
        index: clip.index,
        start: clip.start,
        end: clip.end,
        duration: clip.duration,
        title: clip.title
      })),
      links: posts
        .filter((post) => post.ok)
        .map((post) => ({
          pageId: post.pageId,
          pageName: post.pageName,
          clipIndex: post.clipIndex,
          url: post.permalinkUrl
        })),
      errors: posts
        .filter((post) => !post.ok)
        .map((post) => ({ pageName: post.pageName, error: post.error }))
    });
  }
  res.json(job);
}));

app.get('/api/app/facebook/history', (req, res) => {
  res.json({ ok: true, items: fbHistory.list() });
});

app.post('/api/app/jobs/:id/cancel', asyncRoute(async (req, res) => {
  const result = await pyRequest(`/jobs/${encodeURIComponent(req.params.id)}/cancel`, {
    method: 'POST',
    timeout: 12000
  });
  res.json(result);
}));

app.get('/api/app/categories', asyncRoute(async (req, res) => {
  res.json(await site.getCategories(req.query.refresh === '1'));
}));

app.get('/api/app/tags', asyncRoute(async (req, res) => {
  res.json(await site.getTags(req.query.refresh === '1'));
}));

app.post('/api/app/analyze', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const url = String(body.url || '').trim();
  if (!url) throw httpError(400, 'Chưa nhập link video.');
  if (!isHttpUrl(url)) throw httpError(400, 'Link video không hợp lệ.');

  const cfg = config.get();
  if (!cfg.geminiApiKey) {
    throw httpError(400, 'Chưa cấu hình Gemini API key. Mở Cài đặt để nhập.');
  }

  let categories = [];
  try {
    categories = await site.getCategories();
  } catch (err) {
    console.warn('[site] Không tải được danh mục:', err.message);
  }

  // Site chỉ nhận tag ID đã tồn tại, nên đưa từ vựng tag vào prompt để AI chọn đúng.
  let siteTags = [];
  try {
    siteTags = await site.getTags();
  } catch (err) {
    console.warn('[site] Không tải được tag:', err.message);
  }

  const result = await pyRequest('/analyze', {
    method: 'POST',
    body: {
      url,
      language: ['en', 'vi'].includes(body.language) ? body.language : cfg.language,
      tone: ['neutral', 'dramatic', 'analytical'].includes(body.tone)
        ? body.tone
        : cfg.tone,
      length: ['short', 'standard', 'long'].includes(body.length)
        ? body.length
        : cfg.length,
      instructions: String(body.instructions || '').slice(0, 1000),
      categories: categories.map((item) => ({ id: item.id, name: item.name })),
      tags: siteTags.map((item) => item.name).filter(Boolean).slice(0, 200),
      ai: config.aiConfig()
    },
    timeout: 25000
  });
  res.json(result);
}));

app.post('/api/app/batch', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const { urls, invalid } = normalizeUrlList(body.urls !== undefined ? body.urls : body.url);
  if (!urls.length) {
    throw httpError(
      400,
      invalid.length
        ? 'Không có link hợp lệ. Mỗi dòng cần một URL bắt đầu bằng http:// hoặc https://.'
        : 'Chưa nhập link video nào.'
    );
  }
  if (urls.length > 40) {
    throw httpError(400, `Mỗi lần chỉ chạy tối đa 40 link (đang có ${urls.length}).`);
  }

  const cfg = config.get();
  if (!cfg.geminiApiKey) {
    throw httpError(400, 'Chưa cấu hình Gemini API key. Mở Cài đặt để nhập.');
  }

  let categories = [];
  let siteTags = [];
  try {
    categories = await site.getCategories();
  } catch (err) {
    console.warn('[site] Không tải được danh mục:', err.message);
  }
  try {
    siteTags = await site.getTags();
  } catch (err) {
    console.warn('[site] Không tải được tag:', err.message);
  }

  const result = await pyRequest('/batch', {
    method: 'POST',
    body: {
      urls,
      ...analyzeOptions(body, cfg),
      categories: categories.map((item) => ({ id: item.id, name: item.name })),
      tags: siteTags.map((item) => item.name).filter(Boolean).slice(0, 200),
      ai: config.aiConfig()
    },
    timeout: 30000
  });

  res.json({ ok: true, ...result, invalid });
}));

app.get('/api/app/batch/:id', asyncRoute(async (req, res) => {
  const batch = await pyRequest(`/batch/${encodeURIComponent(req.params.id)}`, {
    timeout: 20000
  });
  res.json(batch);
}));

app.post('/api/app/batch/:id/cancel', asyncRoute(async (req, res) => {
  const result = await pyRequest(`/batch/${encodeURIComponent(req.params.id)}/cancel`, {
    method: 'POST',
    timeout: 12000
  });
  res.json(result);
}));

app.get('/api/app/jobs/:id', asyncRoute(async (req, res) => {
  const job = await pyRequest(`/jobs/${encodeURIComponent(req.params.id)}`, {
    timeout: 12000
  });
  res.json(job);
}));

app.post('/api/app/preview', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const { content, warnings } = buildContent({
    contentHtml: body.content_html,
    videoUrl: body.video_url,
    thumbnailUrl: body.thumbnail_url,
    title: body.title
  });
  res.json({ ok: true, content, warnings });
}));

app.post('/api/app/publish', asyncRoute(async (req, res) => {
  const payload = await withTagIds(buildPostPayload(req.body || {}));
  const result = await site.publishPost(payload);

  res.json({
    ok: true,
    postId: result.postId,
    slug: result.slug,
    link: result.link,
    warnings: payload.warnings
  });
}));

app.put('/api/app/posts/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'ID bài viết không hợp lệ.');

  const payload = await withTagIds(buildPostPayload(req.body || {}));
  const result = await site.updatePost({ id, ...payload });

  res.json({
    ok: true,
    postId: result.postId || id,
    slug: result.slug || payload.permalink,
    link: result.link,
    warnings: payload.warnings
  });
}));

app.delete('/api/app/posts/:id', asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, 'ID bài viết không hợp lệ.');

  await site.deletePost(id);
  res.json({ ok: true, postId: id });
}));

app.get('/api/app/visibility', asyncRoute(async (req, res) => {
  const slug = String(req.query.slug || '').trim().replace(/^\/+|\/+$/g, '');
  const id = Number(req.query.id) || null;
  if (!slug && !id) throw httpError(400, 'Thiếu slug hoặc ID bài viết.');

  const origin = siteOrigin();
  const stamp = Date.now();
  const homeUrl = `${origin}/?t=${stamp}`;
  const feedUrl =
    `${origin}/ajax/theme/lasted-new?page=1&per_page=8&sub_count=2&from_home=1&t=${stamp}`;

  const [home, feedResponse] = await Promise.all([
    fetchPublic(homeUrl).catch((err) => ({ ok: false, status: 0, text: '', error: err.message })),
    fetchPublic(feedUrl, {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest'
    }).catch((err) => ({ ok: false, status: 0, text: '', error: err.message }))
  ]);

  let feed = { items: [] };
  try {
    const parsed = JSON.parse(feedResponse.text || '{}');
    if (Array.isArray(parsed.items)) feed = parsed;
  } catch {
    feed = { items: [] };
  }
  const items = feed.items;

  const onHome = Boolean(
    slug && home.ok && home.text.includes(`/blog/${encodeURIComponent(slug)}`)
  );

  const inLatest = items.some((item) => {
    if (id && Number(item.id) === id) return true;
    if (!slug) return false;
    if (String(item.slug || '') === slug) return true;
    const itemUrl = String(item.url || '');
    return itemUrl.includes(`/blog/${slug}`) || itemUrl.includes(encodeURIComponent(slug));
  });

  res.json({
    ok: true,
    checkedAt: new Date().toISOString(),
    slug,
    postId: id,
    origin,
    homeUrl: `${origin}/`,
    adminUrl: `${origin}/admin`,
    homeReachable: Boolean(home.ok),
    feedReachable: Boolean(feedResponse.ok),
    onHome,
    inLatest,
    latest: items.slice(0, 8).map((item) => ({
      id: item.id,
      title: item.title,
      url: item.url
    }))
  });
}));

app.post('/api/app/upload-image', upload.single('image'), asyncRoute(async (req, res) => {
  if (!req.file) throw httpError(400, 'Chưa chọn file ảnh.');
  const safeName = String(req.file.originalname || 'image.jpg').replace(/[^\w.\-]+/g, '-');
  const result = await site.uploadImage(req.file.buffer, safeName, req.file.mimetype);
  res.json({ ok: true, ...result });
}));

app.get('/api/app/history', (req, res) => {
  res.json({ items: history.list() });
});

app.post('/api/app/history', (req, res, next) => {
  try {
    const entry = history.upsert(req.body);
    res.json({ ok: true, entry });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/app/history/:id', (req, res) => {
  res.json({ ok: true, ...history.remove(req.params.id) });
});

app.use('/api', (req, res) => {
  res.status(404).json({ message: 'API không tồn tại.' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof site.SiteError) {
    return res.status(err.status || 500).json({ message: err.message, fields: err.fields });
  }
  if (err && err.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Ảnh vượt quá 15MB.' : err.message;
    return res.status(400).json({ message });
  }
  const status = Number(err.status) || 500;
  if (status >= 500) console.error('[server]', err);
  return res.status(status).json({ message: err.message || 'Lỗi server.' });
});

let pyProc = null;

async function pythonHealthy(timeout = 1500) {
  try {
    const response = await fetch(`${PY_URL}/health`, {
      signal: AbortSignal.timeout(timeout)
    });
    return response.ok;
  } catch {
    return false;
  }
}

function startPython() {
  const winVenv = path.join(__dirname, '.venv', 'Scripts', 'python.exe');
  const nixVenv = path.join(__dirname, '.venv', 'bin', 'python');
  let python = process.platform === 'win32' ? 'python' : 'python3';
  if (fs.existsSync(winVenv)) python = winVenv;
  else if (fs.existsSync(nixVenv)) python = nixVenv;

  console.log(`[python] Khởi động worker: ${python}`);
  pyProc = spawn(
    python,
    [
      '-m',
      'uvicorn',
      'worker:app',
      '--host',
      '127.0.0.1',
      '--port',
      String(PY_PORT),
      '--log-level',
      'warning'
    ],
    {
      cwd: path.join(__dirname, 'python'),
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true
    }
  );

  pyProc.stdout.on('data', (data) => process.stdout.write(`[python] ${data}`));
  pyProc.stderr.on('data', (data) => process.stderr.write(`[python] ${data}`));
  pyProc.on('error', (err) => {
    console.error('[python] Không chạy được worker:', err.message);
  });
  pyProc.on('exit', (code, signal) => {
    console.log(`[python] Worker đã dừng (code=${code}${signal ? `, signal=${signal}` : ''})`);
    pyProc = null;
  });
}

function openBrowser(url) {
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, { windowsHide: true }, (err) => {
    if (err) console.warn('[browser] Không mở được trình duyệt:', err.message);
  });
}

function stopPython() {
  if (pyProc) {
    try {
      pyProc.kill();
    } catch {
      // ignore
    }
    pyProc = null;
  }
}

process.on('exit', stopPython);
process.on('SIGINT', () => {
  stopPython();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopPython();
  process.exit(0);
});

async function main() {
  if (AUTO_START) {
    const running = await pythonHealthy();
    if (running) {
      console.log('[python] Worker đang chạy sẵn trên cổng ' + PY_PORT);
    } else {
      startPython();
    }
  }

  const server = app.listen(PORT, HOST, () => {
    const url = `http://localhost:${PORT}`;
    console.log('');
    console.log('  News247US Studio');
    console.log(`  Mở: ${url}`);
    console.log('  Nhấn Ctrl+C để dừng.');
    console.log('');
    if (OPEN_BROWSER) setTimeout(() => openBrowser(url), 900);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[server] Cổng ${PORT} đang bị chiếm. Đổi PORT trong .env rồi chạy lại.`);
    } else {
      console.error('[server]', err);
    }
    stopPython();
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('[server] Không khởi động được:', err);
  stopPython();
  process.exit(1);
});
