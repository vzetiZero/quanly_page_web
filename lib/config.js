const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const ENV_DEFAULTS = {
  geminiBaseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  geminiApiStyle: process.env.GEMINI_API_STYLE || 'auto',
  siteBaseUrl: process.env.SITE_BASE_URL || 'https://news247us.cfx.bz/api',
  siteApiKey: process.env.SITE_API_KEY || '',
  language: process.env.DEFAULT_LANGUAGE || 'en',
  tone: process.env.DEFAULT_TONE || 'neutral',
  length: process.env.DEFAULT_LENGTH || 'standard',
  jobWorkers: Math.min(8, Math.max(1, Number(process.env.JOB_WORKERS) || 4))
};

let cache = null;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function pickKnown(source) {
  const result = {};
  for (const key of Object.keys(ENV_DEFAULTS)) {
    if (typeof source[key] === 'string') {
      result[key] = source[key].trim();
    }
  }
  if (source.jobWorkers !== undefined && Number.isFinite(Number(source.jobWorkers))) {
    result.jobWorkers = Math.min(8, Math.max(1, Math.round(Number(source.jobWorkers))));
  }
  return result;
}

function get() {
  if (cache) return cache;
  ensureDataDir();
  let fileConfig = {};
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[config] Không đọc được data/config.json:', err.message);
    }
  }
  cache = { ...ENV_DEFAULTS, ...pickKnown(fileConfig) };
  return cache;
}

function save(patch) {
  const current = get();
  const next = { ...current };
  const clean = pickKnown(patch);
  for (const [key, value] of Object.entries(clean)) {
    if (key.endsWith('ApiKey') && !value) {
      continue;
    }
    if (key === 'geminiBaseUrl' && !value) {
      next[key] = ENV_DEFAULTS.geminiBaseUrl;
      continue;
    }
    next[key] = value;
  }
  ensureDataDir();
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  cache = next;
  return next;
}

function keyHint(key) {
  if (!key) return '';
  return `••••${key.slice(-4)}`;
}

function publicConfig() {
  const cfg = get();
  return {
    geminiBaseUrl: cfg.geminiBaseUrl,
    geminiModel: cfg.geminiModel,
    geminiApiStyle: cfg.geminiApiStyle,
    hasGeminiKey: Boolean(cfg.geminiApiKey),
    geminiKeyHint: keyHint(cfg.geminiApiKey),
    siteBaseUrl: cfg.siteBaseUrl,
    hasSiteKey: Boolean(cfg.siteApiKey),
    siteKeyHint: keyHint(cfg.siteApiKey),
    language: cfg.language,
    tone: cfg.tone,
    length: cfg.length,
    jobWorkers: cfg.jobWorkers
  };
}

function aiConfig() {
  const cfg = get();
  return {
    baseUrl: cfg.geminiBaseUrl,
    apiKey: cfg.geminiApiKey,
    model: cfg.geminiModel,
    apiStyle: cfg.geminiApiStyle
  };
}

module.exports = {
  DATA_DIR,
  CONFIG_PATH,
  get,
  save,
  publicConfig,
  aiConfig
};
