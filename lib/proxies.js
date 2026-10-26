const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_PATH = path.join(DATA_DIR, 'proxies.json');
const LIST_PATH = path.join(DATA_DIR, 'proxies.txt');

const DEFAULT_COOLDOWN = 1800;
const MAX_TEXT_LENGTH = 200 * 1024;

function clampCooldown(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_COOLDOWN;
  return Math.min(7200, Math.max(60, Math.round(number)));
}

function readSettings() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[proxy] Không đọc được data/proxies.json:', err.message);
    }
  }
  return {
    enabled: Boolean(stored && stored.enabled),
    cooldownSeconds: clampCooldown(stored && stored.cooldownSeconds)
  };
}

function readText() {
  try {
    return fs.readFileSync(LIST_PATH, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[proxy] Không đọc được data/proxies.txt:', err.message);
    }
    return '';
  }
}

function countProxies(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('//')).length;
}

function normalizeText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function save(patch) {
  const body = patch || {};
  const current = readSettings();
  const settings = {
    enabled: body.enabled === undefined ? current.enabled : Boolean(body.enabled),
    cooldownSeconds: clampCooldown(
      body.cooldownSeconds === undefined ? current.cooldownSeconds : body.cooldownSeconds
    )
  };
  const text = body.text === undefined ? readText() : normalizeText(body.text);
  if (text.length > MAX_TEXT_LENGTH) {
    const error = new Error('Danh sách proxy quá lớn (tối đa 200 KB).');
    error.status = 400;
    throw error;
  }
  writeAtomic(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  writeAtomic(LIST_PATH, text);
  return publicInfo();
}

function publicInfo() {
  const settings = readSettings();
  const text = readText();
  return {
    enabled: settings.enabled,
    cooldownSeconds: settings.cooldownSeconds,
    count: countProxies(text),
    text
  };
}

module.exports = {
  DATA_DIR,
  SETTINGS_PATH,
  LIST_PATH,
  get: readSettings,
  readText,
  countProxies,
  save,
  publicInfo
};
