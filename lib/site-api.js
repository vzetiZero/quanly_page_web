const config = require('./config');

class SiteError extends Error {
  constructor(message, status = 500, fields = null) {
    super(message);
    this.name = 'SiteError';
    this.status = status;
    this.fields = fields;
  }
}

function baseUrl() {
  const raw = (config.get().siteBaseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) throw new SiteError('Chưa cấu hình địa chỉ API website.', 400);
  return /\/api$/i.test(raw) ? raw : `${raw}/api`;
}

function authHeaders() {
  const cfg = config.get();
  if (!cfg.siteApiKey) {
    throw new SiteError('Chưa cấu hình API key của website. Mở Cài đặt để nhập.', 400);
  }
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${cfg.siteApiKey}`
  };
}

async function request(endpoint, options = {}) {
  const { method = 'GET', body, timeout = 30000 } = options;
  const headers = authHeaders();
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${baseUrl()}${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
  } catch (err) {
    throw new SiteError(`Không kết nối được website: ${err.message}`, 502);
  }

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    let message = data.message || `Website trả về HTTP ${response.status}`;
    if (data.errors) {
      const first = Object.values(data.errors)[0];
      if (Array.isArray(first) && first[0]) message = first[0];
    }
    throw new SiteError(message, response.status, data.errors || null);
  }
  return data;
}

let categoryCache = { at: 0, key: '', items: [] };
let tagCache = { at: 0, key: '', items: [] };
const CACHE_TTL = 5 * 60 * 1000;

async function getCategories(force = false) {
  const key = `${baseUrl()}|${config.get().siteApiKey.slice(-6)}`;
  if (!force && categoryCache.key === key && Date.now() - categoryCache.at < CACHE_TTL) {
    return categoryCache.items;
  }
  const data = await request('/categories');
  const items = Array.isArray(data) ? data : data.data || [];
  categoryCache = { at: Date.now(), key, items };
  return items;
}

async function getTags(force = false) {
  const key = `${baseUrl()}|${config.get().siteApiKey.slice(-6)}`;
  if (!force && tagCache.key === key && Date.now() - tagCache.at < CACHE_TTL) {
    return tagCache.items;
  }
  const data = await request('/tags');
  const items = Array.isArray(data) ? data : data.data || [];
  tagCache = { at: Date.now(), key, items };
  return items;
}

async function getUser() {
  return request('/user');
}

async function publishPost({ title, content, permalink, seoDescription, tags, categoryId }) {
  const body = { title, content, permalink };
  if (seoDescription) body.seo_description = seoDescription;
  if (Array.isArray(tags) && tags.length) body.tags = tags;
  if (categoryId) body.category_id = categoryId;
  return request('/posts', { method: 'POST', body, timeout: 45000 });
}

async function updatePost({ id, title, content, permalink, seoDescription, tags }) {
  const body = { id, title, content, permalink };
  if (seoDescription) body.seo_description = seoDescription;
  if (Array.isArray(tags) && tags.length) body.tags = tags;
  return request('/posts', { method: 'PUT', body, timeout: 45000 });
}

async function deletePost(id) {
  return request('/posts', { method: 'DELETE', body: { id }, timeout: 45000 });
}

async function uploadImage(buffer, fileName, contentType) {
  const presign = await request('/uploads/presigned-image-url', {
    method: 'POST',
    body: { fileName, contentType, size: buffer.length },
    timeout: 30000
  });
  const data = presign.data || presign;
  const uploadUrl = data.upload && data.upload.url;
  const fileUrl = data.fileUrl;
  if (!uploadUrl || !fileUrl) {
    throw new SiteError('Website không trả về URL upload ảnh hợp lệ.', 502);
  }

  let response;
  try {
    response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: buffer,
      signal: AbortSignal.timeout(120000)
    });
  } catch (err) {
    throw new SiteError(`Upload ảnh thất bại: ${err.message}`, 502);
  }
  if (!response.ok) {
    throw new SiteError(`Upload ảnh lên kho R2 thất bại (HTTP ${response.status}).`, 502);
  }
  return { fileUrl, objectKey: data.objectKey || '', size: buffer.length };
}

module.exports = {
  SiteError,
  baseUrl,
  request,
  getCategories,
  getTags,
  getUser,
  publishPost,
  updatePost,
  deletePost,
  uploadImage
};
