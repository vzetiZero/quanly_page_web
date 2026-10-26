const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
const now = () => new Date().toISOString();
const expiry = (value) => !value ? null : (/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value);
const hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value).trim().toLowerCase())))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
const safe = (row, devices = []) => ({ id: row.id, name: row.name, plan: row.plan, status: row.status, expiresAt: row.expires_at, maxDevices: row.max_devices, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at, devices });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' } });
    const url = new URL(request.url); const route = url.pathname.replace(/\/$/, '');
    const admin = Boolean(env.ADMIN_TOKEN) && request.headers.get('Authorization') === `Bearer ${env.ADMIN_TOKEN}`;
    try {
      if (route === '/v1/check' && request.method === 'POST') {
        const device = await request.json(); const row = await env.LICENSES.prepare(`SELECT l.* FROM licenses l JOIN license_devices d ON d.license_id=l.id WHERE d.fingerprint=? AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at>=?)`).bind(device.fingerprint, now()).first();
        if (!row) return json({ active: false });
        await env.LICENSES.prepare('UPDATE license_devices SET last_seen_at=? WHERE fingerprint=?').bind(now(), device.fingerprint).run();
        return json({ active: true, license: safe(row) });
      }
      if (route === '/v1/activate' && request.method === 'POST') {
        const { code, device } = await request.json(); const row = await env.LICENSES.prepare('SELECT * FROM licenses WHERE code_hash=?').bind(await hash(code)).first();
        if (!row || row.status !== 'active') return json({ message: 'Mã license không hợp lệ hoặc đã bị khóa.' }, 400);
        if (row.expires_at && row.expires_at < now()) return json({ message: 'License đã hết hạn.' }, 400);
        const bound = await env.LICENSES.prepare('SELECT fingerprint FROM license_devices WHERE license_id=? AND fingerprint=?').bind(row.id, device.fingerprint).first();
        const count = await env.LICENSES.prepare('SELECT COUNT(*) AS total FROM license_devices WHERE license_id=?').bind(row.id).first();
        if (!bound && count.total >= row.max_devices) return json({ message: 'License đã sử dụng hết số máy được phép.' }, 400);
        if (!bound) await env.LICENSES.prepare('INSERT INTO license_devices (fingerprint,license_id,code,name,platform,activated_at,last_seen_at) VALUES (?,?,?,?,?,?,?)').bind(device.fingerprint,row.id,device.code,device.name,device.platform,now(),now()).run();
        await env.LICENSES.prepare('UPDATE license_devices SET last_seen_at=? WHERE fingerprint=?').bind(now(),device.fingerprint).run();
        await env.LICENSES.prepare('INSERT INTO license_events (id,license_id,type,detail,at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),row.id,bound?'license.checked':'license.activated',device.code,now()).run();
        return json({ ok: true, license: safe(row) });
      }
      if (route.startsWith('/v1/admin/') && !admin) return json({ message: 'Không có quyền quản trị license.' }, 401);
      if (route === '/v1/admin/licenses' && request.method === 'GET') {
        const rows = await env.LICENSES.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
        const licenses = await Promise.all(rows.results.map(async (row) => { const ds = await env.LICENSES.prepare('SELECT fingerprint,code,name,platform,activated_at,last_seen_at FROM license_devices WHERE license_id=?').bind(row.id).all(); return safe(row, ds.results.map((d) => ({ fingerprint:d.fingerprint,code:d.code,name:d.name,platform:d.platform,activatedAt:d.activated_at,lastSeenAt:d.last_seen_at }))); }));
        const events = await env.LICENSES.prepare('SELECT id,type,detail,at FROM license_events ORDER BY at DESC LIMIT 100').all(); return json({ licenses, events: events.results });
      }
      if (route === '/v1/admin/licenses' && request.method === 'POST') {
        const body = await request.json(); const code = String(body.code || '').trim(); if (!/^[a-zA-Z0-9_-]{3,48}$/.test(code)) return json({ message: 'Mã license không hợp lệ.' }, 400);
        const id = crypto.randomUUID(); const at = now(); const plan = ['standard','pro','permanent'].includes(body.plan) ? body.plan : 'standard';
        await env.LICENSES.prepare('INSERT INTO licenses (id,code_hash,name,plan,status,expires_at,max_devices,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id,await hash(code),String(body.name||'License mới').slice(0,100),plan,'active',plan==='permanent'?null:expiry(body.expiresAt),Math.min(1000,Math.max(1,Number(body.maxDevices)||1)),String(body.notes||'').slice(0,500),at,at).run();
        await env.LICENSES.prepare('INSERT INTO license_events (id,license_id,type,detail,at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),id,'license.created',String(body.name||''),at).run();
        return json({ license: { id,name:body.name,plan,status:'active',expiresAt:plan==='permanent'?null:body.expiresAt,maxDevices:Math.max(1,Number(body.maxDevices)||1),notes:body.notes||'',createdAt:at,devices:[],code } },201);
      }
      const match = route.match(/^\/v1\/admin\/licenses\/([^/]+)$/);
      if (match && request.method === 'PATCH') {
        const id = match[1]; const body = await request.json(); const row = await env.LICENSES.prepare('SELECT * FROM licenses WHERE id=?').bind(id).first(); if (!row) return json({ message: 'Không tìm thấy license.' },404);
        if (body.releaseFingerprint) await env.LICENSES.prepare('DELETE FROM license_devices WHERE license_id=? AND fingerprint=?').bind(id,body.releaseFingerprint).run();
        const next = { name:body.name??row.name,plan:body.plan??row.plan,status:body.status??row.status,expiresAt:body.plan==='permanent'?null:(body.expiresAt===undefined?row.expires_at:expiry(body.expiresAt)),maxDevices:Math.min(1000,Math.max(1,Number(body.maxDevices??row.max_devices)||1)),notes:body.notes??row.notes };
        await env.LICENSES.prepare('UPDATE licenses SET name=?,plan=?,status=?,expires_at=?,max_devices=?,notes=?,updated_at=? WHERE id=?').bind(next.name,next.plan,next.status,next.expiresAt,next.maxDevices,next.notes,now(),id).run(); return json({ ok:true });
      }
      if (match && request.method === 'DELETE') { await env.LICENSES.prepare('DELETE FROM license_devices WHERE license_id=?').bind(match[1]).run(); await env.LICENSES.prepare('DELETE FROM licenses WHERE id=?').bind(match[1]).run(); return json({ ok:true }); }
      return json({ message: 'Không tìm thấy API license.' },404);
    } catch (error) { return json({ message: error.message || 'Lỗi license.' },500); }
  }
};
