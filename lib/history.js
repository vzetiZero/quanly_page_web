const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const MAX_ITEMS = 100;

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readAll() {
  ensureDir();
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[history] Không đọc được data/history.json:', err.message);
    }
    return [];
  }
}

function writeAll(items) {
  ensureDir();
  const tmp = `${HISTORY_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8');
  fs.renameSync(tmp, HISTORY_PATH);
}

function list() {
  return readAll();
}

function upsert(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Dữ liệu lịch sử không hợp lệ.');
  }
  const now = new Date().toISOString();
  const id = typeof input.id === 'string' && input.id ? input.id : crypto.randomUUID();
  const entry = {
    ...input,
    id,
    createdAt: input.createdAt || now,
    updatedAt: now
  };

  const items = readAll();
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) {
    items[index] = { ...items[index], ...entry };
  } else {
    items.unshift(entry);
  }
  writeAll(items.slice(0, MAX_ITEMS));
  return entry;
}

function remove(id) {
  const items = readAll();
  const next = items.filter((item) => item.id !== id);
  writeAll(next);
  return { removed: items.length - next.length };
}

module.exports = { list, upsert, remove };
