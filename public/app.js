const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  config: null,
  categories: [],
  history: [],
  jobId: null,
  jobTimer: null,
  pollFailures: 0,
  lastPayload: null,
  result: null,
  article: null,
  source: null,
  videoUrl: '',
  thumbnailUrl: '',
  thumbYoutube: '',
  draftId: null,
  postId: null,
  status: 'draft',
  publishedLink: '',
  slugTouched: false,
  activeTab: 'content',
  stage: 'queued',
  previewTimer: null,
  batchId: null,
  batchTimer: null,
  batchItems: [],
  batchPolls: 0,
  batchRunning: false,
  batchTotal: 0,
  batchCollapsed: false,
  batchActiveIndex: null,
  batchPublished: {},
  batchPublishErrors: {},
  batchPublishing: false,
  fbConfig: null,
  fbHistory: [],
  fbJobId: null,
  fbJobIds: [],
  fbTimer: null,
  fbPolls: 0,
  fbRunning: false,
  fbResult: null,
  fbLastStage: ''
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindEvents();
  await Promise.allSettled([
    loadHealth(),
    loadCategories(),
    loadTags(),
    loadHistory(),
    loadFacebookConfig(),
    loadFbHistory()
  ]);
  if (location.hash === '#facebook') switchView('facebook');
}

/* ---------- API ---------- */

async function api(path, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  if (opts.body !== undefined && !isForm) {
    opts.headers['Content-Type'] = 'application/json';
    if (typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  }

  let response;
  try {
    response = await fetch(`/api/app${path}`, opts);
  } catch (err) {
    throw new Error('Không kết nối được ứng dụng. Kiểm tra cửa sổ server.');
  }

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (!response.ok) {
    const error = new Error(data.message || data.detail || `Lỗi HTTP ${response.status}`);
    error.status = response.status;
    error.fields = data.fields;
    throw error;
  }
  return data;
}

/* ---------- Boot ---------- */

/* Server Express nghe cổng trước khi uvicorn nạp xong fastapi/yt-dlp,
   nên python.ok=false lúc boot thường là worker chưa kịp dậy, không phải lỗi. */
async function waitForWorker(attempts = 8, delayMs = 1500) {
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const health = await api('/health');
      if (health.python && health.python.ok) return true;
    } catch {
      // worker chưa nhận kết nối, thử lại
    }
  }
  return false;
}

async function loadHealth() {
  try {
    const health = await api('/health');
    state.config = health.config;
    applyConfigToForm();
    if (state.fbConfig) renderFbSettings();
    if (health.python && !health.python.ok) {
      if (!(await waitForWorker())) {
        toast('Python worker chưa chạy. Phân tích video sẽ không hoạt động.', 'bad');
      }
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}

/* API site chỉ nhận tag ID đã có, nên gợi ý đúng các tag đang tồn tại. */
async function loadTags() {
  try {
    const items = await api('/tags');
    const picker = $('#tag-picker');
    if (!picker) return;
    const options = (Array.isArray(items) ? items : [])
      .filter((tag) => tag && tag.name)
      .map((tag) => `<option value="${escapeHtml(tag.name)}">${escapeHtml(tag.name)}</option>`);
    picker.innerHTML = '<option value="">+ Thêm tag có sẵn trên site</option>' + options.join('');
  } catch (err) {
    console.warn('[tags]', err);
  }
}

async function loadCategories() {
  try {
    const items = await api('/categories');
    state.categories = Array.isArray(items) ? items : [];
    fillCategorySelects();
  } catch (err) {
    console.warn('[categories]', err);
  }
}

async function loadHistory() {
  try {
    const data = await api('/history');
    state.history = data.items || [];
    renderHistory();
    renderFacebookSourceMapping();
  } catch (err) {
    console.warn('[history]', err);
  }
}

function youtubeIdFromUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be') return parsed.pathname.split('/').filter(Boolean)[0] || '';
    if (!['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) return '';
    const queryId = parsed.searchParams.get('v');
    if (queryId) return queryId;
    const parts = parsed.pathname.split('/').filter(Boolean);
    return ['shorts', 'embed', 'live'].includes(parts[0]) ? (parts[1] || '') : '';
  } catch {
    return '';
  }
}

function getFacebookSources() {
  const textarea = $('#fb-source-list');
  const lines = String(textarea ? textarea.value : '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const analyzeList = extractUrlList($('#input-urls')?.value || '');
  const completedBatch = (state.batchItems || [])
    .filter((item) => item.status === 'done' && item.url)
    .map((item) => item.url);
  const rows = lines.length
    ? lines
    : analyzeList.length
      ? analyzeList
      : completedBatch.length
        ? completedBatch
        : (state.videoUrl ? [state.videoUrl] : []);
  const publishedById = new Map();
  for (const entry of state.history || []) {
    if (entry.status !== 'published' || !entry.link || !entry.source_url) continue;
    const id = youtubeIdFromUrl(entry.source_url);
    if (id && !publishedById.has(id)) publishedById.set(id, entry.link);
  }
  const seen = new Set();
  return rows.map((line) => {
    const [rawUrl, rawArticleUrl] = line.split('|', 2).map((part) => part.trim());
    const url = rawUrl || '';
    const videoId = youtubeIdFromUrl(url);
    if (!videoId || seen.has(videoId)) return null;
    seen.add(videoId);
    const articleUrl = rawArticleUrl || publishedById.get(videoId) ||
      (rows.length === 1 && url === state.videoUrl ? state.publishedLink : '');
    return { url, videoId, articleUrl, autoMapped: !rawArticleUrl && Boolean(articleUrl) };
  }).filter(Boolean);
}

function renderFacebookSourceMapping() {
  const container = $('#fb-source-mapping');
  if (!container) return;
  container.innerHTML = '';
  const sources = getFacebookSources();
  if (!sources.length) {
    container.textContent = 'Chưa có URL YouTube hợp lệ.';
    return;
  }
  for (const [index, source] of sources.entries()) {
    const row = document.createElement('div');
    row.className = 'fb-source-map-row';
    const sourceLink = document.createElement('a');
    sourceLink.href = source.url;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener';
    sourceLink.textContent = `Nguồn ${index + 1} · ${source.videoId}`;
    const mapping = document.createElement('span');
    mapping.className = source.articleUrl ? 'fb-source-mapped' : 'fb-source-unmapped';
    mapping.textContent = source.articleUrl
      ? `${source.autoMapped ? 'Tự ghép' : 'Link chỉ định'}: ${source.articleUrl}`
      : 'Chưa có bài đã đăng khớp; Reel không comment link.';
    row.append(sourceLink, mapping);
    container.appendChild(row);
  }
}

async function loadFacebookConfig() {
  try {
    const data = await api('/facebook/config');
    state.fbConfig = data.config;
    updateFacebookUi();
    renderFbSettings();
  } catch (err) {
    console.warn('[facebook]', err);
    const status = $('#facebook-status');
    if (status) status.textContent = `Không tải được cấu hình Facebook: ${err.message}`;
  }
}

function updateFacebookUi() {
  const cfg = state.fbConfig || {};
  const usable = new Set(
    (cfg.pages || []).filter((page) => page.hasToken).map((page) => String(page.id))
  );
  const selected = (cfg.selectedPageIds || []).filter((id) => usable.has(String(id))).length;
  const ready = Boolean(cfg.hasAccessToken && selected);
  const badge = $('#fb-badge');
  const configBadge = $('#fb-config-badge');
  const summary = $('#fb-summary');
  const runButton = $('#btn-fb-run');

  let badgeText = 'Chưa cấu hình';
  let configText = 'Chưa cấu hình';
  if (!cfg.hasAccessToken) {
    if (summary) {
      summary.textContent =
        'Chưa có Facebook access token. Mở tab Facebook Page để dán token và chọn Page.';
    }
  } else if (!selected) {
    badgeText = 'Chưa chọn Page';
    configText = 'Chưa chọn Page';
    if (summary) {
      summary.textContent =
        'Đã có token nhưng chưa chọn Page. Mở tab Facebook Page, tải danh sách và tick Page muốn đăng.';
    }
  } else {
    badgeText = 'Sẵn sàng';
    configText = `Sẵn sàng · ${selected} Page`;
    if (summary) {
      const clipCount = Number(cfg.clipCount) || 0;
      const reuse =
        selected > clipCount ? ' · Page dư sẽ dùng lại clip' : '';
      summary.textContent =
        `${selected} Page · ${clipCount} clip mỗi video · mỗi Page nhận 1 clip ngẫu nhiên${reuse} · ${cfg.minSeconds}–${cfg.maxSeconds}s · ${(state.config && state.config.jobWorkers) || 4} luồng`;
    }
  }

  if (state.fbRunning) {
    badgeText = 'Đang chạy...';
    configText = 'Đang chạy...';
  }

  for (const item of [badge, configBadge]) {
    if (!item) continue;
    item.textContent = item === badge ? badgeText : configText;
    item.classList.toggle('published', ready && !state.fbRunning);
  }

  renderFacebookSourceMapping();

  if (runButton) {
    runButton.disabled = !ready || !getFacebookSources().length || state.fbRunning;
    runButton.textContent = state.fbRunning ? 'Đang chạy các URL...' : 'Tạo clip & đăng Facebook';
  }

  updateCancelButtons();
}

function updateCancelButtons() {
  const jobButton = $('#btn-cancel-job');
  if (jobButton) jobButton.hidden = !state.jobId;
  const fbButton = $('#btn-fb-cancel');
  if (fbButton) fbButton.hidden = !state.fbRunning;
  const saveButton = $('#btn-fb-save');
  if (saveButton) saveButton.disabled = state.fbRunning;
}

async function loadFbHistory() {
  try {
    const data = await api('/facebook/history');
    state.fbHistory = data.items || [];
    renderFbHistory();
  } catch (err) {
    console.warn('[facebook-history]', err);
  }
}

function renderFbHistory() {
  const box = $('#fb-history-box');
  const container = $('#fb-history-list');
  if (!box || !container) return;
  container.innerHTML = '';
  if (!state.fbHistory.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const entry of state.fbHistory.slice(0, 8)) {
    const item = document.createElement('div');
    item.className = 'history-item';

    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = entry.videoTitle || entry.videoUrl || 'Video';
    item.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const time = document.createElement('span');
    time.textContent = formatDate(entry.at || entry.updatedAt);
    meta.appendChild(time);
    const stats = document.createElement('span');
    stats.textContent = `Đã đăng ${entry.postedCount || 0}/${entry.clipCount || 0} clip`;
    meta.appendChild(stats);
    if (entry.failedCount) {
      const failed = document.createElement('span');
      failed.className = 'mini-badge';
      failed.textContent = `${entry.failedCount} lỗi`;
      meta.appendChild(failed);
    }
    item.appendChild(meta);

    const links = (entry.links || []).slice(0, 6);
    if (links.length) {
      const actions = document.createElement('div');
      actions.className = 'history-actions';
      for (const link of links) {
        const anchor = document.createElement('a');
        anchor.className = 'btn btn-mini';
        anchor.href = link.url;
        anchor.target = '_blank';
        anchor.rel = 'noopener';
        anchor.textContent = `Clip ${link.clipIndex} · ${link.pageName}`;
        actions.appendChild(anchor);
      }
      item.appendChild(actions);
    }
    container.appendChild(item);
  }
}

/* ---------- Facebook Reels ---------- */

const FB_STAGE_LABELS = {
  queued: 'Đang xếp hàng',
  metadata: 'Lấy thông tin video',
  transcript: 'Lấy transcript kèm thời gian',
  select: 'AI chọn đoạn highlight',
  download: 'Tải video gốc từ YouTube',
  cut: 'Cắt clip dọc 9:16',
  upload: 'Đăng Reels lên Facebook',
  done: 'Hoàn tất',
  cancelled: 'Đã huỷ',
  error: 'Lỗi'
};

function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function resetFacebookPanel() {
  if (state.fbRunning) return;
  clearTimeout(state.fbTimer);
  state.fbJobId = null;
  state.fbPolls = 0;
  state.fbResult = null;
  state.fbLastStage = '';
  $('#fb-progress').hidden = true;
  $('#fb-error').hidden = true;
  $('#fb-results').hidden = true;
  $('#fb-results').innerHTML = '';
  $('#fb-log').innerHTML = '';
  $('#fb-bar').style.width = '0%';
}

function addFbLog(text) {
  const log = $('#fb-log');
  const item = document.createElement('li');
  const time = new Date().toLocaleTimeString('vi-VN');
  item.textContent = `${time} · ${text}`;
  log.appendChild(item);
  log.scrollTop = log.scrollHeight;
}

function showFbError(message) {
  $('#fb-error-text').textContent = message;
  $('#fb-error').hidden = false;
  $('#fb-dot').className = 'status-dot bad';
}

async function startFacebookJob() {
  const cfg = state.fbConfig || {};
  const sources = getFacebookSources();
  if (!sources.length) {
    toast('Dán ít nhất một URL YouTube hợp lệ vào danh sách nguồn.', 'bad');
    return;
  }
  if (!cfg.hasAccessToken) {
    toast('Chưa cấu hình Facebook access token.', 'bad');
    openSettings();
    return;
  }
  if (!(cfg.selectedPageIds || []).length) {
    toast('Chưa chọn Page nào. Mở Cài đặt để chọn Page.', 'bad');
    openSettings();
    return;
  }
  if (state.fbRunning) return;

  clearTimeout(state.fbTimer);
  state.fbRunning = true;
  state.fbJobId = null;
  state.fbJobIds = [];
  state.fbPolls = 0;
  state.fbResult = null;
  state.fbLastStage = '';

  $('#fb-progress').hidden = false;
  $('#fb-error').hidden = true;
  $('#fb-results').hidden = true;
  $('#fb-results').innerHTML = '';
  $('#fb-log').innerHTML = '';
  $('#fb-bar').style.width = '2%';
  $('#fb-message').textContent = `Đang gửi ${sources.length} URL nguồn...`;
  $('#fb-dot').className = 'status-dot busy';
  updateFacebookUi();
  $('#card-facebook').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });

  try {
    const response = await api('/facebook/batches', {
      method: 'POST',
      body: { sources }
    });
    state.fbJobIds = (response.jobs || []).map((job) => job.jobId).filter(Boolean);
    if (!state.fbJobIds.length) throw new Error('Worker không tạo được job cho các URL nguồn.');
    await pollFacebookBatch(response.jobs || [], response.concurrency || 1, response.errors || []);
  } catch (err) {
    state.fbRunning = false;
    state.fbJobId = null;
    state.fbJobIds = [];
    updateFacebookUi();
    $('#fb-progress').hidden = false;
    showFbError(err.message);
    toast(err.message, 'bad');
  }
}

async function pollFacebookBatch(sources, concurrency, initialErrors = []) {
  const jobs = sources.map((source) => ({ ...source, status: 'queued', lastStage: '' }));
  const total = jobs.length;
  const errors = initialErrors.map((item) => `${item.url}: ${item.error}`);
  const finished = new Set();
  while (state.fbRunning && finished.size < total) {
    const active = jobs.filter((job) => !finished.has(job.jobId));
    const snapshots = await Promise.all(active.map(async (source) => {
      try {
        const job = await api(`/facebook/jobs/${encodeURIComponent(source.jobId)}`);
        source.status = job.status;
        if (job.stage && job.stage !== source.lastStage) {
          source.lastStage = job.stage;
          addFbLog(`Nguồn ${source.index}/${total}: ${FB_STAGE_LABELS[job.stage] || job.stage}`);
        }
        if (['done', 'error', 'cancelled'].includes(job.status)) {
          finished.add(source.jobId);
          if (job.result) {
            renderFbResults({ ...job.result, sourceTitle: job.result.metadata?.title || source.url }, false, { append: true });
          }
          if (job.status === 'error') errors.push(`${source.url}: ${job.error || 'Lỗi không rõ'}`);
          if (job.status === 'cancelled') errors.push(`${source.url}: đã huỷ`);
        }
        return { source, job };
      } catch (error) {
        source.pollFailures = (source.pollFailures || 0) + 1;
        source.pollError = error.message;
        if (source.pollFailures >= 5) {
          finished.add(source.jobId);
          errors.push(`${source.url}: ${error.message}`);
        }
        return { source, job: null };
      }
    }));
    const percent = snapshots.reduce((sum, item) => sum + (Number(item.job?.percent) || 0), 0) / Math.max(1, total);
    $('#fb-bar').style.width = `${Math.min(100, percent)}%`;
    const doneCount = finished.size;
    $('#fb-message').textContent = `Đã xong ${doneCount}/${total} URL · tối đa ${concurrency} luồng song song`;
    if (finished.size < total) await new Promise((resolve) => setTimeout(resolve, 2200));
  }
  state.fbRunning = false;
  state.fbJobId = null;
  state.fbJobIds = [];
  updateFacebookUi();
  $('#fb-bar').style.width = '100%';
  $('#fb-dot').className = errors.length ? 'status-dot bad' : 'status-dot ok';
  $('#fb-message').textContent = errors.length
    ? `Hoàn tất ${total} URL · ${errors.length} URL cần chú ý`
    : `Hoàn tất ${total} URL nguồn`;
  if (errors.length) showFbError(errors.join('\n'));
  toast($('#fb-message').textContent, errors.length ? 'bad' : 'ok');
  loadFbHistory();
}

async function pollFacebookJob() {
  if (!state.fbJobId) return;
  clearTimeout(state.fbTimer);
  const jobId = state.fbJobId;
  try {
    const job = await api(`/facebook/jobs/${encodeURIComponent(jobId)}`);
    state.fbPolls = 0;
    renderFbJob(job);
    if (job.status === 'done') {
      onFbJobDone(job);
      return;
    }
    if (job.status === 'error') {
      onFbJobError(job);
      return;
    }
    if (job.status === 'cancelled') {
      onFbJobCancelled(job);
      return;
    }
    state.fbTimer = setTimeout(pollFacebookJob, 2500);
  } catch (err) {
    state.fbPolls += 1;
    if (state.fbPolls < 3) {
      state.fbTimer = setTimeout(pollFacebookJob, 3000);
    } else {
      state.fbRunning = false;
      state.fbJobId = null;
      updateFacebookUi();
      showFbError(err.message);
      toast(err.message, 'bad');
    }
  }
}

function renderFbJob(job) {
  const percent = Math.min(100, Math.max(0, Number(job.percent) || 0));
  $('#fb-progress').hidden = false;
  $('#fb-bar').style.width = `${percent}%`;
  $('#fb-message').textContent = job.message || 'Đang xử lý...';

  const stage = job.stage || 'queued';
  if (stage !== state.fbLastStage) {
    state.fbLastStage = stage;
    if (FB_STAGE_LABELS[stage]) addFbLog(FB_STAGE_LABELS[stage]);
  }

  if (job.error) {
    $('#fb-error-text').textContent = job.error;
    $('#fb-error').hidden = false;
  }

  if ((job.clips || []).length) {
    const posts = job.posts || [];
    renderFbResults({
      clips: job.clips,
      posts,
      postedCount: posts.filter((post) => post.ok).length,
      failedCount: posts.filter((post) => !post.ok).length
    }, job.status === 'running' || job.status === 'queued');
  }
}

function onFbJobDone(job) {
  clearTimeout(state.fbTimer);
  state.fbRunning = false;
  state.fbJobId = null;
  state.fbResult = job.result || null;
  updateFacebookUi();

  $('#fb-progress').hidden = false;
  $('#fb-bar').style.width = '100%';
  $('#fb-message').textContent = job.message || 'Hoàn tất';
  $('#fb-dot').className = 'status-dot ok';
  addFbLog(job.message || 'Hoàn tất');

  if (job.result) renderFbResults(job.result, false);
  if ((job.warnings || []).length) {
    showFbError(`Một số video lỗi:\n${job.warnings.join('\n')}`);
    $('#fb-dot').className = 'status-dot ok';
  }
  toast(job.message || 'Đã đăng Facebook.', 'ok');
  loadFbHistory();
}

function onFbJobError(job) {
  clearTimeout(state.fbTimer);
  state.fbRunning = false;
  state.fbJobId = null;
  updateFacebookUi();

  if (job.result) {
    state.fbResult = job.result;
    renderFbResults(job.result, false);
  }
  showFbError(job.error || 'Đăng Facebook thất bại.');
  addFbLog(FB_STAGE_LABELS.error);
  toast(job.error || 'Đăng Facebook thất bại.', 'bad');
  loadFbHistory();
}

function onFbJobCancelled(job) {
  clearTimeout(state.fbTimer);
  state.fbRunning = false;
  state.fbJobId = null;
  updateFacebookUi();

  if (job.result) {
    state.fbResult = job.result;
    renderFbResults(job.result, false);
  }
  $('#fb-progress').hidden = false;
  $('#fb-bar').style.width = '100%';
  $('#fb-message').textContent = job.message || 'Đã huỷ';
  $('#fb-dot').className = 'status-dot';
  addFbLog(FB_STAGE_LABELS.cancelled);
  toast('Đã huỷ tiến trình Facebook.', 'ok');
  loadFbHistory();
}

function renderFbResults(result, running, { append = false } = {}) {
  const container = $('#fb-results');
  const clips = Array.isArray(result.clips) ? result.clips : [];
  const posts = Array.isArray(result.posts) ? result.posts : [];
  if (!clips.length) {
    if (!append) container.hidden = true;
    return;
  }

  container.hidden = false;
  if (!append) container.innerHTML = '';
  const box = document.createElement('section');
  box.className = 'fb-source-result';
  if (result.sourceTitle) {
    const sourceTitle = document.createElement('h3');
    sourceTitle.className = 'fb-source-title';
    sourceTitle.textContent = result.sourceTitle;
    box.appendChild(sourceTitle);
  }

  const posted = posts.filter((post) => post.ok).length;
  const failed = posts.filter((post) => !post.ok).length;
  const commented = posts.filter((post) => post.comment).length;
  const commentFailed = posts.filter((post) => post.commentError).length;
  const summary = document.createElement('div');
  summary.className = 'fb-config-line';
  const parts = [`${clips.length} clip`, `${posted} video đã đăng`];
  if (commented) parts.push(`${commented} comment link bài`);
  if (commentFailed) parts.push(`${commentFailed} comment lỗi`);
  if (failed) parts.push(`${failed} lỗi`);
  if (running) parts.push('đang xử lý...');
  summary.textContent = parts.join(' · ');
  box.appendChild(summary);

  for (const clip of clips) {
    const item = document.createElement('div');
    item.className = 'fb-clip';

    const head = document.createElement('div');
    head.className = 'fb-clip-head';
    const index = document.createElement('span');
    index.textContent = `Clip ${clip.index}`;
    const timing = document.createElement('span');
    timing.textContent = `${formatDuration(clip.duration)} · ${formatClock(clip.start)}–${formatClock(clip.end)}`;
    head.appendChild(index);
    head.appendChild(timing);
    item.appendChild(head);

    const title = document.createElement('p');
    title.className = 'fb-clip-title';
    title.textContent = clip.title || `Clip ${clip.index}`;
    item.appendChild(title);

    if (clip.description) {
      const desc = document.createElement('p');
      desc.className = 'fb-clip-desc';
      desc.textContent = clip.description;
      item.appendChild(desc);
    }

    if (clip.hashtags) {
      const tags = document.createElement('p');
      tags.className = 'muted small';
      tags.textContent = clip.hashtags;
      item.appendChild(tags);
    }

    const links = document.createElement('div');
    links.className = 'fb-clip-links';
    if (clip.fileUrl) {
      const open = document.createElement('a');
      open.className = 'btn btn-mini btn-primary';
      open.href = clip.fileUrl;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'Mở video';
      links.appendChild(open);
    }
    const related = posts.filter((post) => Number(post.clipIndex) === Number(clip.index));
    if (!related.length) {
      const pending = document.createElement('span');
      pending.className = 'muted small';
      pending.textContent = running
        ? 'Đang chờ chọn Page...'
        : 'Clip không được chọn đăng lần này.';
      links.appendChild(pending);
    } else {
      for (const post of related) {
        if (post.ok && post.permalinkUrl) {
          const anchor = document.createElement('a');
          anchor.className = 'btn btn-mini';
          anchor.href = post.permalinkUrl;
          anchor.target = '_blank';
          anchor.rel = 'noopener';
          anchor.textContent = `${post.pageName || 'Facebook'} · Reel`;
          links.appendChild(anchor);

          if (post.comment) {
            const note = document.createElement('span');
            note.className = 'muted small';
            note.textContent = 'Đã comment link bài viết';
            links.appendChild(note);
          } else if (post.commentError) {
            const error = document.createElement('span');
            error.className = 'fb-clip-error';
            error.textContent = `Comment lỗi: ${post.commentError}`;
            links.appendChild(error);
          }
        } else {
          const error = document.createElement('span');
          error.className = 'fb-clip-error';
          error.textContent = `${post.pageName || 'Facebook'}: ${post.error || 'lỗi không rõ'}`;
          links.appendChild(error);
        }
      }
    }

    if (clip.caption) {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn btn-mini';
      copy.textContent = 'Copy caption';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(clip.caption);
          toast('Đã copy caption.', 'ok');
        } catch {
          toast('Không copy được caption.', 'bad');
        }
      });
      links.appendChild(copy);
    }

    item.appendChild(links);
    box.appendChild(item);
  }
  container.appendChild(box);
}

/* ---------- Facebook settings ---------- */

function normalizeSearch(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function renderFbSettings() {
  const cfg = state.fbConfig || {};
  const tokenInput = $('#set-fb-token');
  if (tokenInput) {
    tokenInput.value = '';
    tokenInput.placeholder = cfg.hasAccessToken
      ? 'Để trống nếu giữ token hiện tại'
      : 'Dán user access token';
  }
  const hint = $('#set-fb-token-hint');
  if (hint) {
    hint.textContent = cfg.hasAccessToken
      ? `Đã lưu token ${cfg.accessTokenHint || ''} trên máy này.`
      : 'Chưa có token.';
  }
  $('#set-fb-version').value = cfg.apiVersion || 'v25.0';
  $('#set-fb-clip-count').value = cfg.clipCount || 5;
  $('#set-fb-min-seconds').value = cfg.minSeconds || 45;
  $('#set-fb-max-seconds').value = cfg.maxSeconds || 75;
  $('#set-job-workers').value = (state.config && state.config.jobWorkers) || 4;
  renderFbPages(cfg.pages || [], cfg.selectedPageIds || []);
}

function renderFbPages(pages, selectedIds) {
  const container = $('#fb-pages');
  if (!container) return;
  container.innerHTML = '';
  if (!pages.length) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = 'Chưa có Page nào. Dán token rồi bấm "Tải danh sách Page".';
    container.appendChild(empty);
    updateFbSelectionCount();
    filterFbPages();
    return;
  }

  const selected = new Set((selectedIds || []).map(String));
  for (const page of pages) {
    const label = document.createElement('label');
    label.className = 'fb-page-option';
    label.dataset.search = normalizeSearch(
      [page.name, page.id, page.category, (page.tasks || []).join(' ')].filter(Boolean).join(' ')
    );

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = page.id;
    checkbox.checked = selected.has(String(page.id));
    label.appendChild(checkbox);

    const text = document.createElement('span');
    text.className = 'fb-page-name';
    text.textContent = page.name || page.id;

    if (page.category) {
      const small = document.createElement('small');
      small.textContent = page.category;
      text.appendChild(small);
    }

    if (!page.hasToken) {
      const warn = document.createElement('em');
      warn.className = 'page-token';
      warn.textContent = 'Thiếu token';
      text.appendChild(warn);
    }

    label.appendChild(text);
    container.appendChild(label);
  }

  updateFbSelectionCount();
  filterFbPages();
}

function filterFbPages() {
  const input = $('#fb-page-search');
  const query = normalizeSearch(input ? input.value.trim() : '');
  const rows = $$('#fb-pages .fb-page-option');
  let visible = 0;

  for (const row of rows) {
    const match = !query || (row.dataset.search || '').includes(query);
    row.hidden = !match;
    if (match) visible += 1;
  }

  const empty = $('#fb-pages-empty');
  if (empty) {
    if (query && rows.length && !visible) {
      empty.hidden = false;
      empty.textContent = `Không có Page nào khớp “${input.value.trim()}”.`;
    } else {
      empty.hidden = true;
      empty.textContent = '';
    }
  }
}

function updateFbSelectionCount() {
  const boxes = $$('#fb-pages input[type="checkbox"]');
  const selected = boxes.filter((box) => box.checked).length;
  const badge = $('#fb-selected-count');
  if (badge) {
    badge.textContent = boxes.length ? `${selected}/${boxes.length} Page đã chọn` : 'Chưa có Page';
    badge.classList.toggle('published', boxes.length > 0 && selected === boxes.length);
  }

  const search = $('#fb-page-search');
  if (search) search.disabled = !boxes.length;
  for (const id of ['#btn-fb-select-all', '#btn-fb-clear-pages']) {
    const button = $(id);
    if (button) button.disabled = !boxes.length;
  }
}

function setVisibleFbPages(checked) {
  for (const row of $$('#fb-pages .fb-page-option')) {
    if (row.hidden) continue;
    const box = $('input[type="checkbox"]', row);
    if (box) box.checked = checked;
  }
  updateFbSelectionCount();
}

function collectFbSelectedPageIds() {
  const boxes = $$('#fb-pages input[type="checkbox"]');
  if (!boxes.length) return ((state.fbConfig && state.fbConfig.selectedPageIds) || []).map(String);
  return boxes.filter((box) => box.checked).map((box) => box.value);
}

async function testFacebookToken() {
  const button = $('#btn-fb-test');
  const box = $('#test-fb-result');
  const token = $('#set-fb-token').value.trim();
  const version = $('#set-fb-version').value.trim();

  button.disabled = true;
  box.hidden = false;
  box.className = 'test-result';
  box.textContent = 'Đang kiểm tra token...';

  try {
    const result = await api('/facebook/test', {
      method: 'POST',
      body: { accessToken: token || undefined, apiVersion: version || undefined }
    });
    const missing = result.missing || [];
    const name = (result.user && result.user.name) || 'tài khoản Facebook';
    if (missing.length) {
      box.className = 'test-result bad';
      box.textContent = `Token hợp lệ (${name}) nhưng thiếu quyền: ${missing.join(', ')}.`;
    } else {
      box.className = 'test-result ok';
      box.textContent = `Token hợp lệ · ${name} · ${(result.granted || []).length} quyền. Bấm "Tải danh sách Page" để lưu token và lấy Page.`;
    }
  } catch (err) {
    box.className = 'test-result bad';
    box.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

async function loadFacebookPages() {
  const button = $('#btn-fb-load-pages');
  const box = $('#test-fb-result');
  const token = $('#set-fb-token').value.trim();
  const version = $('#set-fb-version').value.trim();

  if (!token && !(state.fbConfig && state.fbConfig.hasAccessToken)) {
    box.hidden = false;
    box.className = 'test-result bad';
    box.textContent = 'Dán user access token trước.';
    return;
  }

  button.disabled = true;
  box.hidden = false;
  box.className = 'test-result';
  box.textContent = 'Đang tải danh sách Page...';

  try {
    const response = await api('/facebook/pages', {
      method: 'POST',
      body: { accessToken: token || undefined, apiVersion: version || undefined }
    });
    state.fbConfig = response.config;
    const search = $('#fb-page-search');
    if (search) search.value = '';
    renderFbSettings();
    updateFacebookUi();
    box.className = 'test-result ok';
    box.textContent = `Đã tải ${response.count} Page. Tick Page muốn đăng rồi bấm "Lưu cấu hình Page".`;
    toast(`Đã tải ${response.count} Page.`, 'ok');
  } catch (err) {
    box.className = 'test-result bad';
    box.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

/* ---------- Views ---------- */

function scrollBehavior() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function switchView(view) {
  const isFacebook = view === 'facebook';
  const workspace = $('#view-workspace');
  const facebook = $('#view-facebook');
  if (!workspace || !facebook) return;

  workspace.hidden = isFacebook;
  facebook.hidden = !isFacebook;

  for (const tab of $$('.view-tab')) {
    const active = tab.dataset.view === view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }

  if (isFacebook && !state.fbConfig) loadFacebookConfig();

  const url = isFacebook ? '#facebook' : location.pathname + location.search;
  history.replaceState(null, '', url);
  window.scrollTo({ top: 0, behavior: scrollBehavior() });
}

function openFacebookView() {
  switchView('facebook');
  const search = $('#fb-page-search');
  const token = $('#set-fb-token');
  const target = search && !search.disabled ? search : token;
  if (target) target.focus({ preventScroll: true });
}

function onViewTabKeydown(event) {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault();
  const tabs = $$('.view-tab');
  const current = tabs.indexOf(document.activeElement);
  if (current < 0) return;
  const step = event.key === 'ArrowRight' ? 1 : -1;
  const next = tabs[(current + step + tabs.length) % tabs.length];
  next.focus();
  switchView(next.dataset.view);
}

/* ---------- Helpers ---------- */

function applyConfigToForm() {
  if (!state.config) return;
  const language = $('#select-language');
  const tone = $('#select-tone');
  const length = $('#select-length');
  if (language && state.config.language) language.value = state.config.language;
  if (tone && state.config.tone) tone.value = state.config.tone;
  if (length && state.config.length) length.value = state.config.length;
}

function fillCategorySelects() {
  fillSelect($('#select-category'), 'Để AI tự chọn');
  fillSelect($('#edit-category'), 'Không chọn');
}

function fillSelect(select, emptyLabel) {
  if (!select) return;
  const current = select.value;
  select.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = emptyLabel;
  select.appendChild(empty);
  for (const category of state.categories) {
    const option = document.createElement('option');
    option.value = String(category.id);
    option.textContent = category.name;
    select.appendChild(option);
  }
  if (current && Array.from(select.options).some((opt) => opt.value === current)) {
    select.value = current;
  }
}

function setCategorySelect(value, name) {
  const select = $('#edit-category');
  if (!select) return;
  if (value && Array.from(select.options).some((opt) => opt.value === String(value))) {
    select.value = String(value);
    return;
  }
  if (name) {
    const match = Array.from(select.options).find(
      (opt) => opt.textContent.toLowerCase() === String(name).toLowerCase()
    );
    if (match) {
      select.value = match.value;
      return;
    }
  }
  select.value = '';
}

function splitTags() {
  return $('#edit-tags')
    .value.split(',')
    .map((tag) => tag.replace(/^#+/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

function htmlToText(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  } catch {
    return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(secs).padStart(2, '0')}s`;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return new Intl.NumberFormat('vi-VN').format(number);
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

function toast(message, type = '') {
  const stack = $('#toasts');
  if (!stack) return;
  const item = document.createElement('div');
  item.className = `toast ${type}`.trim();
  item.textContent = message;
  stack.appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(6px)';
    item.style.transition = 'opacity .2s, transform .2s';
    setTimeout(() => item.remove(), 220);
  }, 4200);
}

/* ---------- Events ---------- */

function bindEvents() {
  $('#form-source').addEventListener('submit', startAnalyze);
  $('#btn-hide-progress').addEventListener('click', () => {
    $('#card-progress').hidden = true;
    if (state.jobId) toast('Đang xử lý nền. Kết quả sẽ tự hiện khi xong.');
  });
  $('#btn-cancel-job').addEventListener('click', cancelAllJobs);
  $('#btn-retry').addEventListener('click', () => startAnalyze());
  $('#btn-batch').addEventListener('click', startBatch);
  $('#btn-batch-publish').addEventListener('click', publishBatch);
  $('#btn-batch-cancel').addEventListener('click', () => cancelBatch());
  $('#btn-batch-hide').addEventListener('click', () => {
    state.batchCollapsed = !state.batchCollapsed;
    renderBatchVisibility();
  });
  $('#btn-batch-clear').addEventListener('click', () => {
    $('#input-urls').value = '';
    updateBatchCount();
    updateFacebookUi();
  });
  $('#input-urls').addEventListener('input', () => {
    updateBatchCount();
    updateFacebookUi();
  });

  $('#edit-title').addEventListener('input', () => {
    if (!state.slugTouched) {
      $('#edit-permalink').value = slugify($('#edit-title').value);
    }
    schedulePreview();
  });
  $('#edit-permalink').addEventListener('input', () => {
    state.slugTouched = true;
  });
  $('#edit-seo').addEventListener('input', updateCounters);
  $('#edit-content').addEventListener('input', () => {
    updateCounters();
    schedulePreview();
  });

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  $('#btn-save-draft').addEventListener('click', () => saveDraft(false));
  $('#btn-publish').addEventListener('click', publish);
  $('#btn-copy-link').addEventListener('click', copyPublishedLink);
  $('#btn-check-visibility').addEventListener('click', () => checkVisibility(true));

  $('#btn-upload-image').addEventListener('click', () => $('#file-image').click());
  $('#tag-picker').addEventListener('change', (event) => {
    const name = event.target.value;
    event.target.value = '';
    if (!name) return;
    const current = splitTags();
    if (current.some((tag) => tag.toLowerCase() === name.toLowerCase())) {
      toast('Tag này đã có trong danh sách.', 'bad');
      return;
    }
    if (current.length >= 8) {
      toast('Tối đa 8 tag.', 'bad');
      return;
    }
    $('#edit-tags').value = [...current, name].join(', ');
  });
  $('#file-image').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (file) uploadImage(file);
  });
  $('#btn-use-youtube').addEventListener('click', () => {
    if (!state.thumbYoutube) {
      toast('Video này không có thumbnail khả dụng.', 'bad');
      return;
    }
    state.thumbnailUrl = state.thumbYoutube;
    setThumbnail(state.thumbnailUrl);
    schedulePreview();
    toast('Đã dùng thumbnail YouTube.', 'ok');
  });

  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-close-settings').addEventListener('click', closeSettings);
  $('#btn-cancel-settings').addEventListener('click', closeSettings);
  $('#btn-save-settings').addEventListener('click', async () => {
    try {
      await saveSettings({ close: true });
    } catch (err) {
      $('#settings-status').textContent = err.message;
      toast(err.message, 'bad');
    }
  });
  $('#btn-test-ai').addEventListener('click', testAI);
  $('#btn-test-site').addEventListener('click', testSite);
  $('#btn-fb-run').addEventListener('click', startFacebookJob);
  $('#btn-fb-cancel').addEventListener('click', cancelAllJobs);
  $('#fb-source-list').addEventListener('input', updateFacebookUi);
  $('#btn-fb-settings').addEventListener('click', openFacebookView);

  $$('.view-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
    tab.addEventListener('keydown', onViewTabKeydown);
  });

  $('#btn-fb-test').addEventListener('click', testFacebookToken);
  $('#btn-fb-load-pages').addEventListener('click', loadFacebookPages);
  $('#btn-fb-save').addEventListener('click', () => saveFacebookSettings());
  $('#fb-page-search').addEventListener('input', filterFbPages);
  $('#btn-fb-select-all').addEventListener('click', () => setVisibleFbPages(true));
  $('#btn-fb-clear-pages').addEventListener('click', () => setVisibleFbPages(false));
  $('#fb-pages').addEventListener('change', updateFbSelectionCount);

  const dialog = $('#dialog-settings');
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeSettings();
  });

  $('#btn-refresh-history').addEventListener('click', loadHistory);
  $('#history-list').addEventListener('click', onHistoryClick);
  $('#source-meta').addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="show-transcript"]');
    if (!button) return;
    $('#card-progress').hidden = false;
    const details = $('#transcript-details');
    if (details) details.open = true;
    $('#card-progress').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  });
}

/* ---------- Analyze flow ---------- */

async function startAnalyze(event) {
  if (event) event.preventDefault();
  const url = $('#input-url').value.trim();
  if (!url) {
    toast('Dán link video trước.', 'bad');
    return;
  }
  if (!state.config || !state.config.hasGeminiKey) {
    toast('Chưa cấu hình Gemini API key.', 'bad');
    openSettings();
    return;
  }

  const preferredOption = $('#select-category').selectedOptions[0];
  let instructions = $('#input-instructions').value.trim();
  if (preferredOption && preferredOption.value) {
    instructions = [instructions, `Preferred site category: ${preferredOption.textContent}`]
      .filter(Boolean)
      .join('\n');
  }

  const payload = {
    url,
    language: $('#select-language').value,
    tone: $('#select-tone').value,
    length: $('#select-length').value,
    instructions
  };
  state.lastPayload = payload;
  resetForNewJob();

  $('#card-progress').hidden = false;
  $('#card-progress').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  setProgress(3, 'Đang gửi yêu cầu...');
  setAnalyzeBusy(true);

  try {
    const response = await api('/analyze', { method: 'POST', body: payload });
    state.jobId = response.jobId;
    state.pollFailures = 0;
    updateCancelButtons();
    pollJob();
  } catch (err) {
    onJobError({ error: err.message });
  }
}

function resetForNewJob() {
  clearTimeout(state.jobTimer);
  state.jobId = null;
  state.pollFailures = 0;
  state.result = null;
  state.article = null;
  state.source = null;
  state.videoUrl = '';
  state.thumbnailUrl = '';
  state.thumbYoutube = '';
  state.draftId = null;
  state.postId = null;
  state.status = 'draft';
  state.publishedLink = '';
  state.slugTouched = false;
  state.stage = 'queued';
  $('#card-result').hidden = true;
  $('#card-facebook').hidden = true;
  resetFacebookPanel();
  $('#publish-result').hidden = true;
  $('#progress-error').hidden = true;
  $('#progress-retry').hidden = true;
  $('#transcript-text').textContent = '';
  $('#transcript-words').textContent = '';
  $('#progress-bar').style.width = '0%';
  setPublishState('', 'Sẵn sàng đăng');
  renderStepper();
  updateCancelButtons();
}

async function pollJob() {
  if (!state.jobId) return;
  clearTimeout(state.jobTimer);
  try {
    const job = await api(`/jobs/${state.jobId}`);
    state.pollFailures = 0;
    renderJob(job);
    if (job.status === 'done') {
      onJobDone(job);
      return;
    }
    if (job.status === 'error') {
      onJobError(job);
      return;
    }
    if (job.status === 'cancelled') {
      onJobCancelled(job);
      return;
    }
    state.jobTimer = setTimeout(pollJob, 1500);
  } catch (err) {
    state.pollFailures += 1;
    if (state.pollFailures < 3) {
      state.jobTimer = setTimeout(pollJob, 2200);
    } else {
      onJobError({ error: err.message });
    }
  }
}

function renderJob(job) {
  state.stage = job.stage || 'queued';
  setProgress(
    Number(job.percent) || 0,
    job.message || 'Đang xử lý...',
    state.stage
  );

  if (job.transcript && job.transcript.text) {
    $('#transcript-text').textContent = job.transcript.text;
    $('#transcript-words').textContent =
      `· ${job.transcript.wordCount || 0} từ · ${job.transcript.source || ''}`;
  }

  if (job.status === 'error' && job.error) {
    showProgressError(job.error);
  }

  const retry = $('#progress-retry');
  if (retry) {
    const attempt = Number(job.attempt) || 0;
    const active = job.status === 'running' || job.status === 'queued';
    retry.hidden = !(active && attempt > 0);
    retry.textContent = retry.hidden
      ? ''
      : `AI đã thử ${attempt} lần — hệ thống tự thử lại cho tới khi có bài hợp lệ.`;
  }
}

function setProgress(percent, message, stage) {
  $('#progress-message').textContent = message;
  $('#progress-bar').style.width = `${Math.min(100, Math.max(0, percent))}%`;
  if (stage) {
    state.stage = stage;
    renderStepper();
  }
}

function renderStepper() {
  const order = ['transcript', 'analyze', 'write'];
  let active = order.indexOf(state.stage);
  if (state.stage === 'metadata' || state.stage === 'queued') active = 0;
  const complete = state.stage === 'done';

  $$('#stepper li').forEach((item, index) => {
    item.classList.toggle('done', complete || (active > -1 && index < active));
    item.classList.toggle('active', !complete && index === active);
  });
}

function showProgressError(message) {
  const box = $('#progress-error');
  $('#progress-error-text').textContent = message;
  box.hidden = false;
  const retry = $('#progress-retry');
  if (retry) retry.hidden = true;
  setAnalyzeBusy(false);
}

function onJobDone(job) {
  clearTimeout(state.jobTimer);
  const result = job.result || {};
  const article = result.article || {};
  state.result = result;
  state.article = article;
  state.source = result.metadata || {};
  state.jobId = null;
  state.thumbYoutube = (result.metadata && result.metadata.thumbnail) || '';
  state.thumbnailUrl = state.thumbYoutube;
  state.videoUrl =
    (result.metadata && (result.metadata.webpage_url || result.metadata.url)) ||
    (state.lastPayload && state.lastPayload.url) ||
    '';
  state.status = 'draft';
  state.publishedLink = '';
  state.draftId = null;
  state.postId = null;

  setProgress(100, 'Hoàn tất', 'done');
  setAnalyzeBusy(false);
  $('#progress-bar').style.width = '100%';

  fillEditor(article, result.metadata || {});
  $('#card-progress').hidden = true;
  $('#card-result').hidden = false;
  $('#card-facebook').hidden = false;
  updateFacebookUi();
  $('#card-result').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  toast('Đã tạo bài viết. Kiểm tra và đăng.', 'ok');
  saveDraft(true);
}

function onJobError(job) {
  clearTimeout(state.jobTimer);
  state.jobId = null;
  setAnalyzeBusy(false);
  updateCancelButtons();
  $('#card-progress').hidden = false;
  showProgressError(job.error || 'Đã xảy ra lỗi.');
  toast(job.error || 'Không xử lý được video.', 'bad');
}

function onJobCancelled(job) {
  clearTimeout(state.jobTimer);
  state.jobId = null;
  setAnalyzeBusy(false);
  updateCancelButtons();
  $('#progress-error').hidden = true;
  setProgress(0, job.message || 'Đã huỷ');
  $('#card-progress').hidden = true;
  toast('Đã huỷ tiến trình.', 'ok');
}

async function cancelAllJobs() {
  const ids = [];
  if (state.jobId) ids.push(state.jobId);
  if (state.fbJobId) ids.push(state.fbJobId);
  ids.push(...(state.fbJobIds || []));
  const unique = [...new Set(ids)];
  const batchId = state.batchRunning ? state.batchId : null;
  if (!unique.length && !batchId) {
    toast('Không có tiến trình nào đang chạy.', 'bad');
    return;
  }

  $('#progress-message').textContent = 'Đang huỷ...';
  $('#fb-message').textContent = 'Đang huỷ...';
  if (batchId) $('#batch-summary').textContent = 'Đang huỷ danh sách...';

  let failed = 0;
  const tasks = unique.map(async (id) => {
    try {
      await api(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    } catch (err) {
      failed += 1;
      console.warn('[cancel]', err);
    }
  });
  if (batchId) {
    tasks.push(
      api(`/batch/${encodeURIComponent(batchId)}/cancel`, { method: 'POST' }).catch((err) => {
        failed += 1;
        console.warn('[cancel]', err);
      })
    );
  }
  await Promise.all(tasks);

  if (failed) toast('Một số tiến trình không huỷ được.', 'bad');
  else toast('Đã gửi yêu cầu huỷ.', 'ok');
}

function setAnalyzeBusy(busy) {
  const button = $('#btn-analyze');
  button.disabled = busy;
  button.textContent = busy ? 'Đang xử lý...' : 'Phân tích & viết bài';
}

/* ---------- Batch analyze ---------- */

const BATCH_STATUS_LABELS = {
  queued: 'Đang chờ',
  running: 'Đang chạy',
  done: 'Đã có bài',
  error: 'Lỗi',
  cancelled: 'Đã huỷ'
};

function extractUrlList(text) {
  const tokens = String(text || '').split(/[\s,;]+/).filter(Boolean);
  const urls = [];
  const seen = new Set();
  for (const token of tokens) {
    let url = token.replace(/^[\s"'<(]+|[\s"'),.;>]+$/g, '');
    if (!/^https?:\/\//i.test(url)) {
      if (/^(www\.)?(youtube\.com|youtu\.be|m\.youtube\.com)\//i.test(url)) {
        url = `https://${url}`;
      } else {
        continue;
      }
    }
    try {
      new URL(url);
    } catch {
      continue;
    }
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}

function youtubeThumb(url) {
  const match = String(url || '').match(
    /(?:youtu\.be\/|v=|shorts\/|embed\/|live\/)([\w-]{11})/
  );
  return match ? `https://i.ytimg.com/vi/${match[1]}/mqdefault.jpg` : '';
}

function updateBatchCount() {
  const counter = $('#batch-count');
  if (!counter) return;
  const count = extractUrlList($('#input-urls').value).length;
  counter.textContent = count ? `${count} link hợp lệ` : '';
}

function setBatchButtonBusy(busy) {
  const button = $('#btn-batch');
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? 'Đang chạy danh sách...' : 'Phân tích hàng loạt';
}

function renderBatchVisibility() {
  const card = $('#card-batch');
  if (!card || card.hidden) return;
  const collapsed = Boolean(state.batchCollapsed);
  $('#batch-grid').hidden = collapsed;
  const track = card.querySelector('.progress-track');
  if (track) track.hidden = collapsed;
  const button = $('#btn-batch-hide');
  if (button) button.textContent = collapsed ? 'Mở rộng' : 'Thu nhỏ';
}

function updateBatchCancelButton() {
  const button = $('#btn-batch-cancel');
  if (button) button.hidden = !state.batchRunning;
}

function showBatchError(message) {
  $('#batch-error-text').textContent = message;
  $('#batch-error').hidden = false;
}

async function startBatch() {
  const urls = extractUrlList($('#input-urls').value);
  if (!urls.length) {
    toast('Dán ít nhất một link YouTube (mỗi dòng một link).', 'bad');
    return;
  }
  if (!state.config || !state.config.hasGeminiKey) {
    toast('Chưa cấu hình Gemini API key.', 'bad');
    openSettings();
    return;
  }
  if (state.batchRunning) {
    const ok = window.confirm(
      'Danh sách trước vẫn đang chạy. Huỷ danh sách đó và bắt đầu danh sách mới?'
    );
    if (!ok) return;
    await cancelBatch({ silent: true });
  }

  const preferredOption = $('#select-category').selectedOptions[0];
  let instructions = $('#input-instructions').value.trim();
  if (preferredOption && preferredOption.value) {
    instructions = [instructions, `Preferred site category: ${preferredOption.textContent}`]
      .filter(Boolean)
      .join('\n');
  }

  clearTimeout(state.batchTimer);
  state.batchId = null;
  state.batchItems = [];
  state.batchPolls = 0;
  state.batchRunning = true;
  state.batchTotal = urls.length;
  state.batchCollapsed = false;
  state.batchActiveIndex = null;
  state.batchPublished = {};
  state.batchPublishErrors = {};
  state.batchPublishing = false;

  const card = $('#card-batch');
  card.hidden = false;
  $('#batch-grid').innerHTML = '';
  $('#batch-error').hidden = true;
  $('#batch-bar').style.width = '0%';
  $('#batch-badge').textContent = `0/${urls.length}`;
  $('#batch-badge').classList.remove('published');
  $('#batch-summary').textContent = `Đang gửi ${urls.length} video tới worker...`;
  setBatchPublishStatus('');
  updateBatchPublishButton();
  updateBatchCancelButton();
  renderBatchVisibility();
  setBatchButtonBusy(true);
  card.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });

  try {
    const data = await api('/batch', {
      method: 'POST',
      body: {
        urls,
        language: $('#select-language').value,
        tone: $('#select-tone').value,
        length: $('#select-length').value,
        instructions
      }
    });
    state.batchId = data.batchId;
    state.batchTotal = data.total || urls.length;
    if ((data.invalid || []).length) {
      toast(`Đã bỏ qua ${data.invalid.length} link không hợp lệ.`, 'bad');
    }
    pollBatch();
  } catch (err) {
    state.batchRunning = false;
    setBatchButtonBusy(false);
    updateBatchCancelButton();
    showBatchError(err.message);
    toast(err.message, 'bad');
  }
}

async function pollBatch() {
  if (!state.batchId) return;
  clearTimeout(state.batchTimer);
  try {
    const data = await api(`/batch/${encodeURIComponent(state.batchId)}`);
    state.batchPolls = 0;
    state.batchItems = data.items || [];
    state.batchTotal = data.total || state.batchItems.length;
    renderBatch(data);
    if (data.status === 'done') {
      onBatchFinished(data);
      return;
    }
    state.batchTimer = setTimeout(pollBatch, 1800);
  } catch (err) {
    state.batchPolls += 1;
    if (state.batchPolls < 4) {
      state.batchTimer = setTimeout(pollBatch, 2600);
    } else {
      state.batchRunning = false;
      setBatchButtonBusy(false);
      updateBatchCancelButton();
      showBatchError(err.message);
      toast(err.message, 'bad');
    }
  }
}

function renderBatch(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  const counts = data.counts || {};
  const done = counts.done || 0;
  const failed = counts.error || 0;
  const cancelled = counts.cancelled || 0;
  const running = counts.running || 0;
  const queued = counts.queued || 0;
  const total = data.total || items.length;
  const finished = done + failed + cancelled;

  seedBatchPublishedFromHistory(items);

  const badge = $('#batch-badge');
  badge.textContent = `${finished}/${total}`;
  badge.classList.toggle('published', total > 0 && finished === total && failed === 0);

  const parts = [`${done} bài xong`];
  if (running) parts.push(`${running} đang chạy`);
  if (queued) parts.push(`${queued} chờ`);
  if (failed) parts.push(`${failed} lỗi`);
  if (cancelled) parts.push(`${cancelled} đã huỷ`);
  $('#batch-summary').textContent =
    `${parts.join(' · ')} · song song ${data.concurrency || '—'} luồng`;

  $('#batch-bar').style.width = `${Math.min(100, Math.max(0, Number(data.percent) || 0))}%`;

  for (const item of items) {
    updateBatchCard(ensureBatchCard(item), item);
  }
  updateBatchPublishButton();
  updateBatchCancelButton();
  renderBatchVisibility();
}

function batchDoneItems() {
  return (state.batchItems || []).filter(
    (item) => item.status === 'done' && item.result && item.result.article
  );
}

function batchPendingItems() {
  return batchDoneItems().filter((item) => !state.batchPublished[item.index]);
}

function seedBatchPublishedFromHistory(items) {
  if (!Array.isArray(state.history) || !state.history.length) return;
  const byUrl = new Map();
  for (const entry of state.history) {
    if (entry.status !== 'published' || !entry.link || !entry.source_url) continue;
    byUrl.set(String(entry.source_url).trim().toLowerCase(), {
      link: entry.link,
      postId: entry.post_id,
      historyId: entry.id
    });
  }
  if (!byUrl.size) return;
  for (const item of items || []) {
    if (state.batchPublished[item.index]) continue;
    const found = byUrl.get(String(item.url || '').trim().toLowerCase());
    if (found) state.batchPublished[item.index] = found;
  }
}

function setBatchPublishStatus(message) {
  const status = $('#batch-publish-status');
  if (status) status.textContent = message || '';
}

function updateBatchPublishButton() {
  const button = $('#btn-batch-publish');
  if (!button) return;
  const pending = batchPendingItems();
  const alreadyPublished = batchDoneItems().length - pending.length;
  button.disabled = state.batchPublishing || pending.length === 0;
  if (state.batchPublishing) {
    button.textContent = 'Đang đăng...';
    return;
  }
  button.textContent = pending.length
    ? `Đăng hàng loạt (${pending.length} bài mới${alreadyPublished ? ` · ${alreadyPublished} đã đăng` : ''})`
    : alreadyPublished
      ? `Đăng hàng loạt (0 bài mới · ${alreadyPublished} đã đăng)`
      : 'Đăng hàng loạt';
}

function updateBatchPublishCard(index) {
  const item = (state.batchItems || []).find(
    (row) => Number(row.index) === Number(index)
  );
  const card = $(`#batch-grid .batch-card[data-index="${index}"]`);
  if (item && card) updateBatchCard(card, item);
}

async function publishBatch() {
  if (state.batchPublishing) return;
  const pending = batchPendingItems();
  if (!pending.length) {
    toast('Không còn bài nào cần đăng.', 'bad');
    return;
  }
  if (!state.config || !state.config.hasSiteKey) {
    toast('Chưa cấu hình API key website.', 'bad');
    openSettings();
    return;
  }

  const ok = window.confirm(
    `Đăng ${pending.length} bài đã phân tích lên website? Mỗi bài dùng đúng permalink và ảnh YouTube của video gốc.`
  );
  if (!ok) return;

  state.batchPublishing = true;
  $('#batch-error').hidden = true;
  setBatchPublishStatus('');
  updateBatchPublishButton();
  let success = 0;
  const failures = [];

  for (let offset = 0; offset < pending.length; offset += 1) {
    const item = pending[offset];
    const article = item.result.article;
    setBatchPublishStatus(
      `Đang đăng ${offset + 1}/${pending.length}: ${article.title || `video #${item.index}`}`
    );

    try {
      const metadata = item.result.metadata || item.metadata || {};
      const thumbnail = metadata.thumbnail || youtubeThumb(item.url);
      const result = await api('/publish', {
        method: 'POST',
        body: {
          title: article.title,
          permalink: article.permalink,
          seo_description: article.seo_description,
          tags: article.tags || [],
          content_html: article.content_html,
          thumbnail_url: thumbnail,
          video_url: item.url,
          category_id: article.category_id || undefined
        }
      });

      const entry = {
        status: 'published',
        title: article.title,
        permalink: article.permalink,
        seo_description: article.seo_description,
        tags: article.tags || [],
        content_html: article.content_html,
        key_points: article.key_points || [],
        quotes: article.quotes || [],
        thumbnail_url: thumbnail,
        video_url: item.url,
        source_url: item.url,
        category_id: article.category_id || '',
        category: article.category || '',
        link: result.link || '',
        post_id: result.postId || undefined,
        metadata: item.metadata || metadata
      };
      let historyId = '';
      try {
        const saved = await api('/history', { method: 'POST', body: entry });
        historyId = saved.entry.id;
      } catch (err) {
        console.warn('Không lưu được lịch sử cho bài đã đăng:', err.message);
      }

      state.batchPublished[item.index] = {
        link: result.link || '',
        postId: result.postId,
        historyId
      };
      delete state.batchPublishErrors[item.index];
      success += 1;
    } catch (err) {
      state.batchPublishErrors[item.index] = err.message;
      failures.push(`#${item.index}: ${err.message}`);
    }

    updateBatchPublishCard(item.index);
    updateBatchPublishButton();
  }

  state.batchPublishing = false;
  await loadHistory();
  updateBatchPublishButton();
  setBatchPublishStatus(
    failures.length
      ? `Đã đăng ${success}/${pending.length} bài. ${failures.length} bài lỗi.`
      : `Đã đăng ${success} bài lên website.`
  );

  if (failures.length) {
    showBatchError(`Đăng lỗi ${failures.length} bài: ${failures.join(' · ')}`);
    toast(`Đăng được ${success}/${pending.length} bài.`, 'bad');
  } else {
    toast(`Đã đăng ${success} bài lên website.`, 'ok');
  }
}

function ensureBatchCard(item) {
  const grid = $('#batch-grid');
  const existing = grid.querySelector(`[data-index="${item.index}"]`);
  if (existing) return existing;

  const card = document.createElement('article');
  card.className = 'batch-card';
  card.dataset.index = String(item.index);

  const thumb = document.createElement('div');
  thumb.className = 'batch-thumb';
  const image = document.createElement('img');
  image.alt = '';
  image.loading = 'lazy';
  const index = document.createElement('span');
  index.className = 'batch-index';
  index.textContent = `#${item.index}`;
  const status = document.createElement('span');
  status.className = 'batch-pill queued';
  status.textContent = BATCH_STATUS_LABELS.queued;
  thumb.append(image, index, status);

  const body = document.createElement('div');
  body.className = 'batch-card-body';
  const title = document.createElement('div');
  title.className = 'batch-card-title';
  const url = document.createElement('div');
  url.className = 'batch-card-url';
  const track = document.createElement('div');
  track.className = 'progress-track';
  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  track.appendChild(bar);
  const message = document.createElement('div');
  message.className = 'batch-card-message';
  const error = document.createElement('div');
  error.className = 'batch-card-error';
  error.hidden = true;
  const foot = document.createElement('div');
  foot.className = 'batch-card-foot';

  body.append(title, url, track, message, error, foot);
  card.append(thumb, body);
  card._refs = { image, status, title, url, bar, message, error, foot };
  grid.appendChild(card);
  return card;
}

function updateBatchCard(card, item) {
  const refs = card._refs;
  if (!refs) return;
  const status = BATCH_STATUS_LABELS[item.status] ? item.status : 'queued';
  const article = item.result && item.result.article;

  card.dataset.status = status;
  card.classList.toggle('active', Number(state.batchActiveIndex) === Number(item.index));

  const thumb = (item.metadata && item.metadata.thumbnail) || youtubeThumb(item.url);
  if (thumb && refs.image.dataset.src !== thumb) {
    refs.image.src = thumb;
    refs.image.dataset.src = thumb;
  }

  refs.status.textContent = BATCH_STATUS_LABELS[status];
  refs.status.className = `batch-pill ${status}`;

  refs.title.textContent =
    (article && article.title) ||
    (item.metadata && item.metadata.title) ||
    `Video ${item.index}`;
  refs.url.textContent = item.url || '';
  refs.url.title = item.url || '';

  const percent = Math.min(100, Math.max(0, Number(item.percent) || 0));
  refs.bar.style.width = `${percent}%`;
  refs.bar.style.background =
    status === 'error'
      ? 'linear-gradient(90deg, #f87171, #dc2626)'
      : status === 'done'
        ? 'linear-gradient(90deg, #22c55e, #0f766e)'
        : '';

  let message = item.message || '';
  const attempt = Number(item.attempt) || 0;
  if (status === 'done' && article) {
    const parts = [`${article.word_count || 0} từ`];
    if (article.category) parts.push(article.category);
    if (attempt > 1) parts.push(`AI thử lại ${attempt - 1} lần`);
    message = parts.join(' · ');
  } else if (status === 'running' && attempt > 0) {
    message = `${message} · AI đã thử ${attempt} lần`;
  } else if (status === 'queued') {
    message = 'Đang chờ tới lượt...';
  }
  refs.message.textContent = message;

  refs.error.hidden = !(status === 'error' && item.error);
  refs.error.textContent = item.error || '';

  const published = state.batchPublished[item.index];
  const publishError = state.batchPublishErrors[item.index];
  const footSignature = `${status}|${published ? published.link || 'published' : ''}|${publishError || ''}`;
  if (card.dataset.footSignature === footSignature) return;
  card.dataset.footSignature = footSignature;

  refs.foot.innerHTML = '';
  if (status === 'done' && article) {
    if (published && published.link) {
      const link = document.createElement('a');
      link.className = 'btn btn-mini btn-primary';
      link.href = published.link;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Bài đã đăng';
      refs.foot.appendChild(link);
    }
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-mini';
    open.textContent = 'Mở bài';
    open.addEventListener('click', () => openBatchItem(item));
    refs.foot.appendChild(open);
    if (publishError) {
      const warn = document.createElement('span');
      warn.className = 'batch-publish-error';
      warn.textContent = `Đăng lỗi: ${publishError}`;
      refs.foot.appendChild(warn);
    }
  } else if (status === 'error') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-mini';
    retry.textContent = 'Thử lại riêng';
    retry.addEventListener('click', () => retryBatchItem(item.url));
    refs.foot.appendChild(retry);
  } else {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-mini btn-danger';
    cancel.textContent = 'Huỷ';
    cancel.addEventListener('click', () => cancelBatchItem(item));
    refs.foot.appendChild(cancel);
  }

  if (item.url) {
    const link = document.createElement('a');
    link.className = 'btn btn-mini';
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Video';
    refs.foot.appendChild(link);
  }
}

function openBatchItem(item) {
  if (!item || !item.result) return;
  state.batchActiveIndex = item.index;
  for (const card of $$('#batch-grid .batch-card')) {
    card.classList.toggle('active', Number(card.dataset.index) === Number(item.index));
  }

  const published = state.batchPublished[item.index];
  if (published && published.link) {
    const entry = (state.history || []).find(
      (row) => published.historyId && row.id === published.historyId
    );
    if (entry) {
      openHistoryItem(entry);
      toast(`Đã mở bài #${item.index} (đã đăng).`, 'ok');
      return;
    }
  }

  state.lastPayload = { url: item.url || '' };
  onJobDone({ status: 'done', result: item.result });

  if (published && published.link) {
    state.draftId = null;
    state.status = 'published';
    state.publishedLink = published.link;
    state.postId = published.postId || null;
    setDraftBadge('published');
    updatePublishButton();
    showPublishedLink(published.link);
    updateFacebookUi();
  }

  toast(`Đã mở bài #${item.index} trong trình biên tập.`, 'ok');
}

function retryBatchItem(url) {
  if (!url) return;
  $('#input-url').value = url;
  startAnalyze();
}

async function cancelBatchItem(item) {
  if (!item || !item.id) return;
  try {
    await api(`/jobs/${encodeURIComponent(item.id)}/cancel`, { method: 'POST' });
    toast(`Đã gửi huỷ video #${item.index}.`, 'ok');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function cancelBatch({ silent = false } = {}) {
  if (!state.batchId) return;
  clearTimeout(state.batchTimer);
  try {
    const result = await api(`/batch/${encodeURIComponent(state.batchId)}/cancel`, {
      method: 'POST'
    });
    if (!silent) toast(result.message || 'Đã gửi yêu cầu huỷ.', 'ok');
    if (state.batchRunning) state.batchTimer = setTimeout(pollBatch, 1200);
  } catch (err) {
    state.batchRunning = false;
    setBatchButtonBusy(false);
    updateBatchCancelButton();
    if (!silent) toast(err.message, 'bad');
  }
}

function onBatchFinished(data) {
  clearTimeout(state.batchTimer);
  state.batchRunning = false;
  setBatchButtonBusy(false);
  updateBatchCancelButton();
  renderBatch(data);

  const counts = data.counts || {};
  const done = counts.done || 0;
  const failed = counts.error || 0;
  const cancelled = counts.cancelled || 0;
  const total = data.total || state.batchTotal;
  if (done) {
    toast(
      `Xong ${done}/${total} video. Bấm "Đăng hàng loạt" để đăng tất cả, hoặc "Mở bài" để biên tập trước.`,
      failed ? '' : 'ok'
    );
  } else {
    toast(`Không có bài nào hoàn tất (${failed} lỗi, ${cancelled} đã huỷ).`, 'bad');
  }
}

/* ---------- Editor ---------- */

function fillEditor(article, metadata) {
  state.slugTouched = false;
  $('#edit-title').value = article.title || '';
  $('#edit-permalink').value = article.permalink || slugify(article.title);
  $('#edit-seo').value = article.seo_description || '';
  $('#edit-tags').value = (article.tags || []).join(', ');
  $('#edit-content').value = article.content_html || '';
  setCategorySelect(article.category_id, article.category);
  setThumbnail(state.thumbnailUrl);

  renderSourceMeta(metadata);
  renderKeyPoints(article.key_points || []);

  const videoLink = $('#video-link');
  videoLink.href = state.videoUrl || '#';
  videoLink.style.display = state.videoUrl ? '' : 'none';

  updateCounters();
  setDraftBadge('draft');
  updatePublishButton();
  $('#publish-result').hidden = true;
  setPublishState('ok', 'Sẵn sàng đăng');
  switchTab('content', true);
}

function renderSourceMeta(metadata) {
  const container = $('#source-meta');
  container.innerHTML = '';
  const add = (text) => {
    if (!text) return;
    const chip = document.createElement('span');
    chip.className = 'meta-chip';
    chip.textContent = text;
    container.appendChild(chip);
  };

  add(metadata.channel || 'YouTube');
  add(metadata.upload_date || '');
  add(metadata.duration ? formatDuration(metadata.duration) : '');
  add(metadata.view_count ? `${formatNumber(metadata.view_count)} views` : '');

  const transcriptButton = document.createElement('button');
  transcriptButton.type = 'button';
  transcriptButton.className = 'meta-chip meta-button';
  transcriptButton.dataset.action = 'show-transcript';
  transcriptButton.textContent = 'Transcript';
  container.appendChild(transcriptButton);
}

function renderKeyPoints(points) {
  const list = $('#key-points');
  list.innerHTML = '';
  for (const point of points.slice(0, 5)) {
    const item = document.createElement('li');
    item.textContent = point;
    list.appendChild(item);
  }
}

function setThumbnail(url) {
  const image = $('#thumb-img');
  const empty = $('#thumb-empty');
  if (url) {
    image.src = url;
    image.classList.add('ready');
    empty.hidden = true;
  } else {
    image.removeAttribute('src');
    image.classList.remove('ready');
    empty.hidden = false;
  }
}

function updateCounters() {
  const seoLength = $('#edit-seo').value.length;
  const counter = $('#seo-count');
  counter.textContent = `${seoLength}/160`;
  counter.classList.toggle('over', seoLength >= 155);

  const words = htmlToText($('#edit-content').value).split(/\s+/).filter(Boolean).length;
  $('#word-count').textContent = `${words} từ`;
}

function setDraftBadge(status) {
  const badge = $('#draft-badge');
  badge.textContent = status === 'published' ? 'Đã đăng' : 'Bản nháp';
  badge.classList.toggle('published', status === 'published');
}

function setPublishState(kind, text) {
  const dot = $('#publish-dot');
  dot.classList.remove('ok', 'busy', 'bad');
  if (kind) dot.classList.add(kind);
  $('#publish-state').textContent = text;
}

function switchTab(tab, skipRender = false) {
  state.activeTab = tab;
  $$('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  $('#edit-content').hidden = tab !== 'content';
  $('#preview-pane').hidden = tab !== 'preview';
  if (tab === 'preview' && !skipRender) renderPreview();
  if (tab === 'content') $('#preview-warnings').hidden = true;
}

function schedulePreview() {
  if (state.activeTab !== 'preview') return;
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(renderPreview, 450);
}

async function renderPreview() {
  const frame = $('#preview-frame');
  const warningsBox = $('#preview-warnings');
  if (!frame) return;

  frame.srcdoc =
    '<!doctype html><html><body style="font-family:Segoe UI,sans-serif;color:#6b7280;padding:24px">Đang tạo xem trước...</body></html>';

  try {
    const result = await api('/preview', {
      method: 'POST',
      body: {
        content_html: $('#edit-content').value,
        video_url: state.videoUrl,
        thumbnail_url: state.thumbnailUrl,
        title: $('#edit-title').value
      }
    });

    const css = `
      :root { color-scheme: light; }
      body { margin: 0; padding: 22px 22px 34px; font-family: "Segoe UI", system-ui, sans-serif;
        color: #1f2937; line-height: 1.7; font-size: 17px; background: #fff; }
      h1 { font-size: 28px; line-height: 1.25; margin: 0 0 10px; letter-spacing: -0.02em; }
      .preview-meta { font-size: 13px; color: #6b7280; margin-bottom: 22px; }
      p { margin: 0 0 16px; }
      span { line-height: 1.35; }
      blockquote { margin: 18px 0; padding: 12px 18px; border-left: 4px solid #4f46e5;
        background: #f8fafc; font-style: italic; }
      img { max-width: 100%; height: auto; border-radius: 8px; }
      iframe { max-width: 100%; border-radius: 8px; }
      ul, ol { margin: 0 0 16px; padding-left: 24px; }
      a { color: #4f46e5; }
    `;
    const title = escapeHtml($('#edit-title').value);
    const seo = escapeHtml($('#edit-seo').value);
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${css}</style></head><body>
      <h1>${title}</h1>
      <div class="preview-meta">${seo}</div>
      ${result.content}
    </body></html>`;

    const warnings = result.warnings || [];
    warningsBox.hidden = warnings.length === 0;
    warningsBox.textContent = warnings.join(' ');
  } catch (err) {
    frame.srcdoc = `<!doctype html><html><body style="font-family:Sans-serif;padding:22px;color:#b91c1c">${escapeHtml(
      err.message
    )}</body></html>`;
    warningsBox.hidden = true;
  }
}

/* ---------- Save / publish ---------- */

function collectEntry(status) {
  const metadata = state.source || {};
  const categoryOption = $('#edit-category').selectedOptions[0];
  return {
    id: state.draftId || undefined,
    status,
    title: $('#edit-title').value.trim(),
    permalink: $('#edit-permalink').value.trim(),
    seo_description: $('#edit-seo').value.trim(),
    tags: splitTags(),
    content_html: $('#edit-content').value,
    thumbnail_url: state.thumbnailUrl || '',
    video_url: state.videoUrl || '',
    source_url: metadata.webpage_url || (state.lastPayload && state.lastPayload.url) || '',
    category_id: $('#edit-category').value || '',
    category: categoryOption ? categoryOption.textContent : '',
    link: state.publishedLink || '',
    post_id: state.postId || undefined,
    metadata: state.source
      ? {
          title: state.source.title,
          channel: state.source.channel,
          upload_date: state.source.upload_date,
          duration: state.source.duration,
          view_count: state.source.view_count,
          webpage_url: state.source.webpage_url,
          thumbnail: state.source.thumbnail
        }
      : null
  };
}

async function saveDraft(silent) {
  if (!state.article && !$('#edit-content').value.trim()) return;
  try {
    const entry = collectEntry(state.status === 'published' ? 'published' : 'draft');
    const response = await api('/history', { method: 'POST', body: entry });
    state.draftId = response.entry.id;
    await loadHistory();
    if (!silent) toast('Đã lưu nháp.', 'ok');
  } catch (err) {
    if (!silent) toast(`Không lưu được nháp: ${err.message}`, 'bad');
  }
}

async function publish() {
  if (!state.article) return;
  if (!state.config || !state.config.hasSiteKey) {
    toast('Chưa cấu hình API key website.', 'bad');
    openSettings();
    return;
  }

  const title = $('#edit-title').value.trim();
  const content = $('#edit-content').value.trim();
  const permalink = slugify($('#edit-permalink').value || title);
  if (!title) {
    toast('Thiếu tiêu đề bài viết.', 'bad');
    return;
  }
  if (!permalink) {
    toast('Permalink đang trống.', 'bad');
    return;
  }
  if (!content) {
    toast('Thiếu nội dung bài viết.', 'bad');
    return;
  }
  const editingPublished = Boolean(state.status === 'published' && state.postId);
  if (state.status === 'published' && !state.postId) {
    const ok = window.confirm(
      'Bài này đã được đăng nhưng chưa có ID bài trên website. Đăng lại sẽ tạo một bài mới. Tiếp tục?'
    );
    if (!ok) return;
  }

  const button = $('#btn-publish');
  button.disabled = true;
  button.textContent = editingPublished ? 'Đang cập nhật...' : 'Đang đăng...';
  setPublishState('busy', editingPublished ? 'Đang cập nhật bài...' : 'Đang gửi bài lên website...');

  const payload = {
    title,
    permalink,
    seo_description: $('#edit-seo').value.trim(),
    tags: splitTags(),
    content_html: content,
    thumbnail_url: state.thumbnailUrl,
    video_url: state.videoUrl,
    category_id: $('#edit-category').value || undefined
  };

  try {
    const result = editingPublished
      ? await api(`/posts/${state.postId}`, { method: 'PUT', body: payload })
      : await api('/publish', { method: 'POST', body: payload });

    state.status = 'published';
    state.postId = result.postId || state.postId;
    state.publishedLink = result.link || state.publishedLink;
    setDraftBadge('published');
    updatePublishButton();
    setPublishState('ok', editingPublished ? 'Đã cập nhật bài đăng' : 'Đã đăng bài');
    showPublishedLink(state.publishedLink);
    checkVisibility();
    await saveDraft(true);
    toast(
      editingPublished ? 'Đã cập nhật bài trên website.' : 'Đã đăng bài lên news247us.',
      'ok'
    );

    if (result.warnings && result.warnings.length) {
      toast(result.warnings.join(' '));
    }
  } catch (err) {
    setPublishState('bad', editingPublished ? 'Cập nhật thất bại' : 'Đăng bài thất bại');
    toast(err.message, 'bad');
  } finally {
    button.disabled = false;
    updatePublishButton();
  }
}

function updatePublishButton() {
  const button = $('#btn-publish');
  if (!button) return;
  button.textContent =
    state.status === 'published' && state.postId ? 'Cập nhật bài đăng' : 'Đăng lên news247us';
}

function showPublishedLink(link) {
  const box = $('#publish-result');
  const anchor = $('#publish-link');
  anchor.href = link;
  anchor.textContent = link;

  try {
    const origin = new URL(link).origin;
    $('#btn-open-home').href = `${origin}/`;
    $('#btn-open-admin').href = `${origin}/admin`;
  } catch {
    // link không hợp lệ thì giữ nguyên nút
  }

  resetVisibility();
  box.hidden = false;
  updateFacebookUi();
}

function resetVisibility() {
  const row = $('#publish-visibility');
  if (!row) return;
  row.hidden = true;
  row.className = 'visibility-line';
  $('#visibility-dot').className = 'status-dot';
  $('#visibility-text').textContent = '';
  const hint = $('#visibility-hint');
  hint.hidden = true;
  hint.textContent = '';
}

async function checkVisibility(notify = false) {
  if (!state.publishedLink) {
    if (notify) toast('Chưa có bài đã đăng để kiểm tra.', 'bad');
    return;
  }

  const row = $('#publish-visibility');
  const dot = $('#visibility-dot');
  const text = $('#visibility-text');
  const hint = $('#visibility-hint');
  const button = $('#btn-check-visibility');

  row.hidden = false;
  row.className = 'visibility-line';
  dot.className = 'status-dot busy';
  text.textContent = 'Đang kiểm tra trang chủ và mục Latest News...';
  hint.hidden = true;
  button.disabled = true;

  const params = new URLSearchParams();
  const slug = slugify($('#edit-permalink').value.trim());
  if (slug) params.set('slug', slug);
  if (state.postId) params.set('id', String(state.postId));

  try {
    const result = await api(`/visibility?${params.toString()}`);
    if (result.homeUrl) $('#btn-open-home').href = result.homeUrl;
    if (result.adminUrl) $('#btn-open-admin').href = result.adminUrl;

    if (result.inLatest) {
      row.className = 'visibility-line ok';
      dot.className = 'status-dot ok';
      text.textContent = 'Bài đã hiển thị trong mục Latest News trên trang chủ.';
      hint.hidden = true;
    } else if (result.onHome) {
      row.className = 'visibility-line ok';
      dot.className = 'status-dot ok';
      text.textContent = 'Bài đã có trên trang chủ.';
      hint.hidden = true;
    } else {
      row.className = 'visibility-line warn';
      dot.className = 'status-dot bad';
      text.textContent = 'Chưa thấy bài trên trang chủ.';
      hint.textContent =
        'Trang chủ có thể đang cache hoặc bài chưa được duyệt. Mở link bài để kiểm tra rồi thử lại.';
      hint.hidden = false;
    }
    if (notify) toast('Đã kiểm tra trang chủ.', 'ok');
  } catch (err) {
    row.className = 'visibility-line warn';
    dot.className = 'status-dot bad';
    text.textContent = 'Không kiểm tra được trang chủ.';
    hint.textContent = err.message;
    hint.hidden = false;
  } finally {
    button.disabled = false;
  }
}

function copyPublishedLink() {
  const link = state.publishedLink;
  if (!link) return;
  navigator.clipboard
    .writeText(link)
    .then(() => toast('Đã sao chép link.', 'ok'))
    .catch(() => toast('Không sao chép được link.', 'bad'));
}

/* ---------- Image upload ---------- */

async function uploadImage(file) {
  if (file.size > 15 * 1024 * 1024) {
    toast('Ảnh vượt quá 15MB.', 'bad');
    return;
  }
  const formData = new FormData();
  formData.append('image', file);
  setPublishState('busy', 'Đang tải ảnh...');
  try {
    const result = await api('/upload-image', { method: 'POST', body: formData });
    state.thumbnailUrl = result.fileUrl;
    setThumbnail(state.thumbnailUrl);
    setPublishState('ok', 'Sẵn sàng đăng');
    schedulePreview();
    toast('Đã tải ảnh lên kho website.', 'ok');
  } catch (err) {
    setPublishState('bad', 'Tải ảnh thất bại');
    toast(err.message, 'bad');
  } finally {
    $('#file-image').value = '';
  }
}

/* ---------- History ---------- */

function renderHistory() {
  const container = $('#history-list');
  container.innerHTML = '';
  if (!state.history.length) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = 'Chưa có bài nào.';
    container.appendChild(empty);
    return;
  }

  for (const entry of state.history) {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.dataset.id = entry.id;

    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = entry.title || '(Chưa có tiêu đề)';
    item.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'history-meta';

    const badge = document.createElement('span');
    badge.className = `mini-badge ${entry.status === 'published' ? 'published' : ''}`;
    badge.textContent = entry.status === 'published' ? 'Đã đăng' : 'Nháp';
    meta.appendChild(badge);

    const date = document.createElement('span');
    date.textContent = formatDate(entry.updatedAt || entry.createdAt);
    meta.appendChild(date);

    item.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'btn btn-mini';
    openButton.dataset.action = 'open';
    openButton.textContent = 'Mở';
    actions.appendChild(openButton);

    if (entry.status === 'published' && entry.link) {
      const viewLink = document.createElement('a');
      viewLink.className = 'btn btn-mini';
      viewLink.href = entry.link;
      viewLink.target = '_blank';
      viewLink.rel = 'noopener';
      viewLink.textContent = 'Xem';
      actions.appendChild(viewLink);
    }

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-mini';
    deleteButton.dataset.action = 'delete';
    deleteButton.textContent = 'Xoá';
    deleteButton.title = entry.post_id ? 'Xoá bài trên website' : 'Xoá khỏi lịch sử';
    actions.appendChild(deleteButton);

    item.appendChild(actions);
    container.appendChild(item);
  }
}

async function onHistoryClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const item = button.closest('.history-item');
  if (!item) return;
  const entry = state.history.find((row) => row.id === item.dataset.id);
  if (!entry) return;

  if (button.dataset.action === 'open') {
    openHistoryItem(entry);
    return;
  }

  if (button.dataset.action === 'delete') {
    const hasPostId = Boolean(entry.post_id);
    const message = hasPostId
      ? `Xoá bài "${entry.title || 'này'}" khỏi website và lịch sử? Thao tác không thể hoàn tác.`
      : `Bài này không có ID trên website. Chỉ xoá khỏi lịch sử cục bộ?`;
    const ok = window.confirm(message);
    if (!ok) return;

    try {
      if (hasPostId) {
        await api(`/posts/${entry.post_id}`, { method: 'DELETE' });
      }
      await api(`/history/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });

      if (state.draftId === entry.id) {
        state.draftId = null;
        state.postId = null;
        state.status = 'draft';
        state.publishedLink = '';
        setDraftBadge('draft');
        updatePublishButton();
        $('#publish-result').hidden = true;
      }
      await loadHistory();
      toast(hasPostId ? 'Đã xoá bài trên website.' : 'Đã xoá khỏi lịch sử.', 'ok');
    } catch (err) {
      toast(`Không xoá được: ${err.message}`, 'bad');
    }
  }
}

function openHistoryItem(entry) {
  clearTimeout(state.jobTimer);
  state.jobId = null;
  state.draftId = entry.id;
  state.postId = entry.post_id ? Number(entry.post_id) : null;
  state.status = entry.status || 'draft';
  state.publishedLink = entry.link || '';
  state.article = entry;
  state.source = entry.metadata || {
    title: entry.title,
    webpage_url: entry.source_url,
    channel: '',
    thumbnail: entry.thumbnail_url
  };
  state.thumbYoutube = (entry.metadata && entry.metadata.thumbnail) || entry.thumbnail_url || '';
  state.thumbnailUrl = entry.thumbnail_url || '';
  state.videoUrl = entry.video_url || (entry.metadata && entry.metadata.webpage_url) || entry.source_url || '';
  state.slugTouched = true;

  state.result = null;
  $('#card-progress').hidden = true;
  $('#progress-error').hidden = true;
  $('#card-result').hidden = false;
  $('#card-facebook').hidden = false;
  updateFacebookUi();

  $('#edit-title').value = entry.title || '';
  $('#edit-permalink').value = entry.permalink || '';
  $('#edit-seo').value = entry.seo_description || '';
  $('#edit-tags').value = Array.isArray(entry.tags) ? entry.tags.join(', ') : entry.tags || '';
  $('#edit-content').value = entry.content_html || '';
  setCategorySelect(entry.category_id, entry.category);
  setThumbnail(state.thumbnailUrl);
  renderSourceMeta(state.source);
  renderKeyPoints(entry.key_points || []);

  const videoLink = $('#video-link');
  videoLink.href = state.videoUrl || '#';
  videoLink.style.display = state.videoUrl ? '' : 'none';

  updateCounters();
  setDraftBadge(state.status);
  updatePublishButton();
  setPublishState('ok', state.status === 'published' ? 'Đã đăng bài' : 'Sẵn sàng đăng');
  if (state.publishedLink) {
    showPublishedLink(state.publishedLink);
  } else {
    $('#publish-result').hidden = true;
  }
  switchTab('content', true);
  $('#card-result').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
}

/* ---------- Settings ---------- */

function openSettings() {
  const cfg = state.config || {};
  $('#set-gemini-base').value =
    cfg.geminiBaseUrl || 'https://generativelanguage.googleapis.com';
  $('#set-gemini-model').value = cfg.geminiModel || 'gemini-2.5-flash';
  $('#set-gemini-style').value = cfg.geminiApiStyle || 'auto';
  $('#set-site-base').value = cfg.siteBaseUrl || 'https://news247us.cfx.bz/api';
  $('#set-language').value = cfg.language || 'en';
  $('#set-tone').value = cfg.tone || 'neutral';
  $('#set-length').value = cfg.length || 'standard';
  $('#set-gemini-key').value = '';
  $('#set-site-key').value = '';
  updateSettingsHints();

  for (const id of ['#test-ai-result', '#test-site-result']) {
    const box = $(id);
    box.hidden = true;
    box.textContent = '';
    box.className = 'test-result';
  }
  $('#settings-status').textContent = '';

  const dialog = $('#dialog-settings');
  if (!dialog.open) {
    dialog.showModal();
    $('#set-gemini-key').focus({ preventScroll: true });
  }
}

function closeSettings() {
  const dialog = $('#dialog-settings');
  if (dialog.open) dialog.close();
}

async function saveFacebookSettings({ silent = false } = {}) {
  const button = $('#btn-fb-save');
  const payload = {
    apiVersion: $('#set-fb-version').value.trim(),
    clipCount: Number($('#set-fb-clip-count').value) || 5,
    minSeconds: Number($('#set-fb-min-seconds').value) || 45,
    maxSeconds: Number($('#set-fb-max-seconds').value) || 75,
    selectedPageIds: collectFbSelectedPageIds()
  };
  const token = $('#set-fb-token').value.trim();
  if (token) payload.accessToken = token;

  const status = $('#facebook-status');
  if (button) button.disabled = true;
  if (status) status.textContent = 'Đang lưu...';

  try {
    const workerCount = Number($('#set-job-workers').value);
    if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 8) {
      throw new Error('Số luồng phải là số nguyên từ 1 đến 8.');
    }
    const appConfig = await api('/config', {
      method: 'PUT',
      body: { jobWorkers: workerCount }
    });
    state.config = appConfig.config;
    const response = await api('/facebook/config', { method: 'PUT', body: payload });
    state.fbConfig = response.config;
    renderFbSettings();
    updateFacebookUi();
    if (status) status.textContent = `Đã lưu lúc ${new Date().toLocaleTimeString('vi-VN')}`;
    if (!silent) toast('Đã lưu cấu hình Facebook.', 'ok');
  } catch (err) {
    if (status) status.textContent = err.message;
    toast(err.message, 'bad');
  } finally {
    if (button) button.disabled = false;
  }
}

function updateSettingsHints() {
  const cfg = state.config || {};
  $('#set-gemini-hint').textContent = cfg.hasGeminiKey
    ? `Đã lưu key ${cfg.geminiKeyHint || ''} — để trống nếu giữ nguyên.`
    : 'Chưa có API key.';
  $('#set-site-hint').textContent = cfg.hasSiteKey
    ? `Đã lưu key ${cfg.siteKeyHint || ''} — để trống nếu giữ nguyên.`
    : 'Chưa có API key.';
  $('#set-gemini-key').placeholder = cfg.hasGeminiKey
    ? 'Để trống nếu giữ key hiện tại'
    : 'Dán API key';
  $('#set-site-key').placeholder = cfg.hasSiteKey
    ? 'Để trống nếu giữ key hiện tại'
    : 'Dán API key';
}

async function saveSettings({ silent = false, close = false } = {}) {
  const payload = {
    geminiBaseUrl: $('#set-gemini-base').value.trim(),
    geminiModel: $('#set-gemini-model').value.trim(),
    geminiApiStyle: $('#set-gemini-style').value,
    siteBaseUrl: $('#set-site-base').value.trim(),
    language: $('#set-language').value,
    tone: $('#set-tone').value,
    length: $('#set-length').value
  };
  const geminiKey = $('#set-gemini-key').value.trim();
  const siteKey = $('#set-site-key').value.trim();
  if (geminiKey) payload.geminiApiKey = geminiKey;
  if (siteKey) payload.siteApiKey = siteKey;

  const response = await api('/config', { method: 'PUT', body: payload });
  state.config = response.config;

  $('#set-gemini-key').value = '';
  $('#set-site-key').value = '';
  updateSettingsHints();
  $('#settings-status').textContent = `Đã lưu lúc ${new Date().toLocaleTimeString('vi-VN')}`;

  if (close) closeSettings();
  if (!silent) toast('Đã lưu cài đặt.', 'ok');
  await loadHealth();
  loadCategories();
}

async function testAI() {
  const button = $('#btn-test-ai');
  const box = $('#test-ai-result');
  button.disabled = true;
  box.hidden = false;
  box.className = 'test-result';
  box.textContent = 'Đang kiểm tra...';
  try {
    await saveSettings({ silent: true });
    const result = await api('/ai/test', { method: 'POST' });
    box.className = 'test-result ok';
    box.textContent = `Kết nối OK · ${result.model} (${result.style}) · ${result.latencyMs} ms`;
  } catch (err) {
    box.className = 'test-result bad';
    box.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

async function testSite() {
  const button = $('#btn-test-site');
  const box = $('#test-site-result');
  button.disabled = true;
  box.hidden = false;
  box.className = 'test-result';
  box.textContent = 'Đang kiểm tra...';
  try {
    await saveSettings({ silent: true });
    const result = await api('/site/test', { method: 'POST' });
    box.className = 'test-result ok';
    box.textContent = `Kết nối OK · ${result.user.name} (${result.user.role}) · ${result.baseUrl}`;
  } catch (err) {
    box.className = 'test-result bad';
    box.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}
