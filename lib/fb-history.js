const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'facebook-history.json');
const MAX_ITEMS = 30;

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[fb-history] Không đọc được data/facebook-history.json:', err.message);
    }
    return [];
  }
}

function writeAll(items) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${HISTORY_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8');
  fs.renameSync(tmp, HISTORY_PATH);
}

function list() {
  return readAll();
}

function upsert(entry) {
  if (!entry || !entry.id) return null;
  const items = readAll();
  const index = items.findIndex((item) => item.id === entry.id);
  const record = { ...entry, updatedAt: new Date().toISOString() };
  if (index >= 0) items[index] = record;
  else items.unshift(record);
  writeAll(items.slice(0, MAX_ITEMS));
  return record;
}

module.exports = { list, upsert };
