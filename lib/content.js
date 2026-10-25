function slugify(text, maxLength = 80) {
  const value = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return value.slice(0, maxLength).replace(/-+$/g, '');
}

function escapeAttribute(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseYouTubeId(url) {
  const value = String(url || '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const valid = (id) => (/^[a-zA-Z0-9_-]{6,20}$/.test(id || '') ? id : null);

    if (host === 'youtu.be') {
      return valid(parsed.pathname.split('/').filter(Boolean)[0]);
    }
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const queryId = parsed.searchParams.get('v');
      if (queryId) return valid(queryId);
      const match = parsed.pathname.match(/\/(?:embed|shorts|live|v)\/([^/?#]+)/);
      if (match) return valid(match[1]);
    }
  } catch {
    return null;
  }
  return null;
}

function buildContent({ contentHtml, videoUrl, thumbnailUrl, title }) {
  let html = String(contentHtml || '').trim();
  if (!html) {
    const error = new Error('Nội dung bài viết đang trống.');
    error.status = 400;
    throw error;
  }

  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(?:"|')?\s*javascript:[^"'\s>]*/gi, '$1="#"')
    .trim();

  const warnings = [];
  const safeTitle = escapeAttribute(title);
  let extras = '';

  if (thumbnailUrl) {
    extras +=
      `<p><img src="${escapeAttribute(thumbnailUrl)}" alt="${safeTitle}" width="480" height="360" ` +
      'style="border-style: none; max-width: 100%; height: auto;" loading="eager"></p>';
  } else {
    warnings.push('Chưa có ảnh bìa — bài viết sẽ không có ảnh minh họa đầu bài.');
  }

  const videoId = parseYouTubeId(videoUrl);
  if (videoId) {
    extras +=
      `<p><iframe src="https://www.youtube-nocookie.com/embed/${videoId}" title="${safeTitle}" ` +
      'width="560" height="400" style="width: 100%; height: 400px; border: 0; display: block;" ' +
      'allowfullscreen="allowfullscreen" loading="lazy"></iframe></p>';
  } else {
    warnings.push('Link video không phải YouTube hợp lệ — bài viết chỉ có nội dung, không kèm video.');
  }

  if (extras) {
    const index = html.indexOf('</p>');
    html = index >= 0 ? html.slice(0, index + 4) + extras + html.slice(index + 4) : extras + html;
  }

  return { content: html, warnings };
}

function normalizeTags(value) {
  let list = value;
  if (typeof list === 'string') list = list.split(',');
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const tag = String(item || '').replace(/^#+/, '').trim().slice(0, 40);
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
    if (result.length >= 8) break;
  }
  return result;
}

module.exports = { slugify, parseYouTubeId, buildContent, normalizeTags };
