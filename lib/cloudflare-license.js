const { machine } = require('./license');

const base = () => String(process.env.LICENSE_API_URL || '').trim().replace(/\/+$/, '');
const configured = () => Boolean(base());
const adminConfigured = () => Boolean(base() && process.env.LICENSE_ADMIN_TOKEN);

async function request(route, { method = 'GET', body, admin = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (admin) headers.Authorization = `Bearer ${process.env.LICENSE_ADMIN_TOKEN}`;
  const response = await fetch(`${base()}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Cloudflare license trả về HTTP ${response.status}.`);
  return data;
}

async function status() {
  const device = machine();
  const result = await request('/v1/check', { method: 'POST', body: device });
  const { fingerprint: _fingerprint, ...publicDevice } = device;
  return { ...result, device: publicDevice, license: result.license };
}
async function activate(code) { return request('/v1/activate', { method: 'POST', body: { code, device: machine() } }); }
async function list() { if (!adminConfigured()) throw new Error('Thiếu LICENSE_ADMIN_TOKEN để quản trị kho Cloudflare.'); return { ...(await request('/v1/admin/licenses', { admin: true })), device: machine() }; }
async function create(body) { return (await request('/v1/admin/licenses', { method: 'POST', body, admin: true })).license; }
async function update(id, body) { return request(`/v1/admin/licenses/${encodeURIComponent(id)}`, { method: 'PATCH', body, admin: true }); }
async function remove(id) { return request(`/v1/admin/licenses/${encodeURIComponent(id)}`, { method: 'DELETE', admin: true }); }

module.exports = { configured, adminConfigured, status, activate, list, create, update, remove };
