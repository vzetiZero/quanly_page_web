const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'facebook.json');

const DEFAULTS = {
  accessToken: process.env.FB_ACCESS_TOKEN || '',
  apiVersion: process.env.FB_API_VERSION || 'v25.0',
  hashtags: process.env.FB_HASHTAGS || '',
  clipCount: Number(process.env.FB_CLIP_COUNT) || 5,
  minSeconds: Number(process.env.FB_MIN_SECONDS) || 45,
  maxSeconds: Number(process.env.FB_MAX_SECONDS) || 75,
  vertical: true,
  pages: [],
  selectedPageIds: []
};

let cache = null;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function normalizePages(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const pages = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    pages.push({
      id,
      name: String(item.name || item.id).trim(),
      accessToken: String(item.accessToken || item.access_token || '').trim(),
      tasks: Array.isArray(item.tasks) ? item.tasks : [],
      category: String(item.category || '').trim()
    });
  }
  return pages;
}

function load() {
  ensureDir();
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[facebook] Không đọc được data/facebook.json:', err.message);
    }
  }
  const config = {
    ...DEFAULTS,
    ...stored,
    clipCount: clampInt(stored.clipCount ?? DEFAULTS.clipCount, 5, 1, 10),
    minSeconds: clampInt(stored.minSeconds ?? DEFAULTS.minSeconds, 45, 20, 120),
    maxSeconds: clampInt(stored.maxSeconds ?? DEFAULTS.maxSeconds, 75, 30, 180),
    vertical: stored.vertical !== false,
    pages: normalizePages(stored.pages),
    selectedPageIds: Array.isArray(stored.selectedPageIds)
      ? stored.selectedPageIds.map(String)
      : []
  };
  if (config.maxSeconds <= config.minSeconds) {
    config.maxSeconds = config.minSeconds + 30;
  }
  return config;
}

function get() {
  if (!cache) cache = load();
  return cache;
}

function write(config) {
  ensureDir();
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  cache = config;
  return config;
}

function save(patch) {
  const current = get();
  const next = { ...current };
  const body = patch || {};

  if (typeof body.accessToken === 'string' && body.accessToken.trim()) {
    const token = body.accessToken.trim();
    if (token !== current.accessToken) {
      next.accessToken = token;
      next.pages = [];
      next.selectedPageIds = [];
    }
  }
  if (typeof body.apiVersion === 'string' && body.apiVersion.trim()) {
    next.apiVersion = body.apiVersion.trim();
  }
  if (typeof body.hashtags === 'string') {
    next.hashtags = body.hashtags.trim();
  }
  if (body.clipCount !== undefined) {
    next.clipCount = clampInt(body.clipCount, current.clipCount, 1, 10);
  }
  if (body.minSeconds !== undefined) {
    next.minSeconds = clampInt(body.minSeconds, current.minSeconds, 20, 120);
  }
  if (body.maxSeconds !== undefined) {
    next.maxSeconds = clampInt(body.maxSeconds, current.maxSeconds, 30, 180);
  }
  if (next.maxSeconds <= next.minSeconds) {
    next.maxSeconds = next.minSeconds + 30;
  }
  if (body.vertical !== undefined) {
    next.vertical = Boolean(body.vertical);
  }
  if (Array.isArray(body.selectedPageIds)) {
    const available = new Set(next.pages.map((page) => page.id));
    next.selectedPageIds = body.selectedPageIds
      .map(String)
      .filter((id) => available.has(id));
  }

  return write(next);
}

function setPages(items) {
  const current = get();
  const pages = normalizePages(items);
  const available = new Set(pages.map((page) => page.id));
  return write({
    ...current,
    pages,
    selectedPageIds: current.selectedPageIds.filter((id) => available.has(id))
  });
}

function selectedPages() {
  const config = get();
  const selected = new Set(config.selectedPageIds);
  return config.pages.filter((page) => selected.has(page.id) && page.accessToken);
}

function keyHint(key) {
  if (!key) return '';
  return `••••${key.slice(-6)}`;
}

function publicConfig() {
  const config = get();
  return {
    hasAccessToken: Boolean(config.accessToken),
    accessTokenHint: keyHint(config.accessToken),
    apiVersion: config.apiVersion,
    hashtags: config.hashtags,
    clipCount: config.clipCount,
    minSeconds: config.minSeconds,
    maxSeconds: config.maxSeconds,
    vertical: config.vertical,
    selectedPageIds: config.selectedPageIds,
    pages: config.pages.map((page) => ({
      id: page.id,
      name: page.name,
      category: page.category,
      tasks: page.tasks,
      hasToken: Boolean(page.accessToken)
    }))
  };
}

module.exports = {
  get,
  save,
  setPages,
  selectedPages,
  publicConfig
};
