const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'licenses.json');

function machineFingerprint() {
  const macs = Object.values(os.networkInterfaces()).flat().filter(Boolean)
    .map((item) => item.mac).filter((mac) => mac && mac !== '00:00:00:00:00:00').sort();
  const source = [os.hostname().toLowerCase(), os.platform(), os.arch(),
    os.cpus()[0]?.model || '', [...new Set(macs)].join(',')].join('|');
  return crypto.createHash('sha256').update(source).digest('hex').toUpperCase();
}

function machine() {
  const fingerprint = machineFingerprint();
  return {
    code: fingerprint.match(/.{1,4}/g).slice(0, 6).join('-'),
    fingerprint,
    name: os.hostname(),
    platform: `${os.type()} ${os.release()} · ${os.arch()}`
  };
}

function read() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { licenses: Array.isArray(data.licenses) ? data.licenses : [], events: Array.isArray(data.events) ? data.events : [] };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { licenses: [], events: [] };
  }
}

function write(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temp = `${FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, FILE);
}

function codeHash(code) { return crypto.createHash('sha256').update(String(code).trim().toLowerCase()).digest('hex'); }
function expiry(value) {
  if (!value) return null;
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T23:59:59.999Z` : new Date(text).toISOString();
}
function safeLicense(item, includeFingerprints = false) {
  const { codeHash: _hash, ...safe } = item;
  if (!includeFingerprints) safe.devices = (safe.devices || []).map(({ fingerprint: _fingerprint, ...device }) => device);
  return safe;
}
function publicMachine(device) {
  const { fingerprint: _fingerprint, ...safe } = device;
  return safe;
}
function recordEvent(data, event) {
  data.events.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...event });
  data.events = data.events.slice(0, 500);
}
function activate(code, device = machine()) {
  const data = read();
  const item = data.licenses.find((license) => license.codeHash === codeHash(code));
  if (!item) return { ok: false, message: 'Mã license không hợp lệ.' };
  if (item.status !== 'active') return { ok: false, message: 'License đã bị khóa.' };
  if (item.expiresAt && new Date(item.expiresAt).getTime() < Date.now()) return { ok: false, message: 'License đã hết hạn.' };
  const binding = item.devices.find((entry) => entry.fingerprint === device.fingerprint);
  if (!binding && item.devices.length >= item.maxDevices) return { ok: false, message: 'License đã sử dụng hết số máy được phép.' };
  if (!binding) item.devices.push({ fingerprint: device.fingerprint, code: device.code, name: device.name, platform: device.platform, activatedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() });
  else binding.lastSeenAt = new Date().toISOString();
  item.updatedAt = new Date().toISOString();
  recordEvent(data, { type: binding ? 'license.checked' : 'license.activated', licenseId: item.id, deviceCode: device.code });
  write(data);
  return { ok: true, license: safeLicense(item) };
}
function status() {
  const device = machine();
  const data = read();
  const item = data.licenses.find((license) => license.devices.some((entry) => entry.fingerprint === device.fingerprint && license.status === 'active' && (!license.expiresAt || new Date(license.expiresAt).getTime() >= Date.now())));
  if (!item) return { active: false, device: publicMachine(device) };
  const binding = item.devices.find((entry) => entry.fingerprint === device.fingerprint);
  if (Date.now() - Date.parse(binding.lastSeenAt || 0) > 10 * 60 * 1000) {
    binding.lastSeenAt = new Date().toISOString();
    write(data);
  }
  return { active: true, device: publicMachine(device), license: safeLicense(item) };
}
function list() {
  const data = read();
  return { licenses: data.licenses.map((item) => safeLicense(item, true)), events: data.events, device: machine() };
}
function create({ code, name, plan = 'standard', expiresAt = null, maxDevices = 1, notes = '' }) {
  const cleaned = String(code || '').trim();
  if (!/^[a-zA-Z0-9_-]{3,48}$/.test(cleaned)) throw new Error('Mã license cần từ 3–48 ký tự (chữ, số, - hoặc _).');
  const data = read();
  if (data.licenses.some((item) => item.codeHash === codeHash(cleaned))) throw new Error('Mã license đã tồn tại.');
  const item = { id: crypto.randomUUID(), codeHash: codeHash(cleaned), name: String(name || 'License mới').trim().slice(0, 100), plan: ['standard', 'pro', 'permanent'].includes(plan) ? plan : 'standard', status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: plan === 'permanent' ? null : expiry(expiresAt), maxDevices: Math.max(1, Math.min(1000, Math.floor(Number(maxDevices) || 1))), notes: String(notes || '').slice(0, 500), devices: [] };
  data.licenses.unshift(item);
  recordEvent(data, { type: 'license.created', licenseId: item.id, name: item.name });
  write(data);
  return { ...safeLicense(item), code: cleaned };
}
function update(id, patch) {
  const data = read();
  const item = data.licenses.find((license) => license.id === id);
  if (!item) return null;
  if (patch.status && ['active', 'suspended'].includes(patch.status)) item.status = patch.status;
  if (patch.name !== undefined) item.name = String(patch.name).trim().slice(0, 100);
  if (patch.plan && ['standard', 'pro', 'permanent'].includes(patch.plan)) item.plan = patch.plan;
  if (patch.maxDevices !== undefined) item.maxDevices = Math.max(item.devices.length, Math.min(1000, Math.max(1, Math.floor(Number(patch.maxDevices) || 1))));
  if (patch.expiresAt !== undefined) item.expiresAt = item.plan === 'permanent' ? null : expiry(patch.expiresAt);
  if (patch.notes !== undefined) item.notes = String(patch.notes).slice(0, 500);
  if (patch.releaseFingerprint) item.devices = item.devices.filter((entry) => entry.fingerprint !== patch.releaseFingerprint);
  item.updatedAt = new Date().toISOString();
  recordEvent(data, { type: 'license.updated', licenseId: id });
  write(data);
  return safeLicense(item);
}
function remove(id) {
  const data = read();
  const length = data.licenses.length;
  data.licenses = data.licenses.filter((item) => item.id !== id);
  if (length === data.licenses.length) return false;
  recordEvent(data, { type: 'license.deleted', licenseId: id });
  write(data);
  return true;
}

module.exports = { machine, read, list, create, update, remove, activate, status };
