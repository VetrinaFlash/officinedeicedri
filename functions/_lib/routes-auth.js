import {
  json, readJson, fail, sha256, hashPassword, verifyPassword, isEmail, str,
} from './util.js';
import {
  createSession, sessionCookie, getSettings, createUserToken, appUrl, adminFingerprint,
} from './core.js';
import { sendEmail, emailLayout } from './email.js';

const MIN_PW = 8;

export const authRoutes = [
  ['GET', '/api/public/config', async ({ env }) => {
    const s = await getSettings(env);
    return json({
      company_name: s.company_name, company_phone: s.company_phone, company_email: s.company_email,
      company_address: s.company_address, logo_url: s.logo_url, site_url: s.site_url,
      vapid_public_key: env.VAPID_PUBLIC_KEY || null,
    });
  }],

  // accesso al pannello: una sola password, impostata come secret ADMIN_PASSWORD su Cloudflare
  ['POST', '/api/auth/admin', async ({ env, request }) => {
    const ip = request.headers.get('cf-connecting-ip') || '';
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM login_attempts WHERE email = 'admin' AND ip = ? AND created_at > datetime('now', '-15 minutes')").bind(ip).first();
    if (recent.n >= 8) fail(429, 'Troppi tentativi. Riprova tra 15 minuti.');
    if (!env.ADMIN_PASSWORD && !env.ADMIN_PASSWORD_HASH) fail(500, 'Password del pannello non configurata.');
    const b = await readJson(request);
    const password = String(b.password || '');
    let ok;
    if (env.ADMIN_PASSWORD) {
      // secret impostato su Cloudflare: ha la precedenza
      const given = await sha256(password), expected = await sha256(env.ADMIN_PASSWORD);
      let diff = given.length ^ expected.length;
      for (let i = 0; i < Math.min(given.length, expected.length); i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
      ok = diff === 0;
    } else {
      ok = await verifyPassword(password, env.ADMIN_PASSWORD_HASH);
    }
    if (!ok) {
      await env.DB.prepare("INSERT INTO login_attempts (email, ip) VALUES ('admin', ?)").bind(ip).run();
      fail(401, 'Password non corretta.');
    }
    const fp = await adminFingerprint(env);
    let admin = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").first();
    if (!admin) {
      admin = await env.DB.prepare("INSERT INTO users (email, name, password_hash, role) VALUES ('pannello@admin', 'Amministratore', ?, 'admin') RETURNING id").bind(fp).first();
    } else {
      await env.DB.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?').bind(fp, admin.id).run();
    }
    await env.DB.prepare("DELETE FROM login_attempts WHERE email = 'admin' AND ip = ?").bind(ip).run();
    const token = await createSession(env, admin.id);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token, request) });
  }],

  ['POST', '/api/auth/login', async ({ env, request }) => {
    const b = await readJson(request);
    const email = String(b.email || '').trim().toLowerCase();
    const ip = request.headers.get('cf-connecting-ip') || '';
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM login_attempts WHERE (email = ? OR ip = ?) AND created_at > datetime('now', '-15 minutes')").bind(email, ip).first();
    if (recent.n >= 8) fail(429, 'Troppi tentativi. Riprova tra 15 minuti.');
    const user = await env.DB.prepare("SELECT * FROM users WHERE email = ? AND role = 'cliente'").bind(email).first();
    if (!user || !user.active || !(await verifyPassword(String(b.password || ''), user.password_hash))) {
      await env.DB.prepare('INSERT INTO login_attempts (email, ip) VALUES (?, ?)').bind(email, ip).run();
      fail(401, 'Email o password non corretti.');
    }
    await env.DB.prepare('DELETE FROM login_attempts WHERE email = ?').bind(email).run();
    const token = await createSession(env, user.id);
    return json({ ok: true, role: user.role }, 200, { 'set-cookie': sessionCookie(token, request) });
  }],

  ['POST', '/api/auth/logout', async ({ env, request, user }) => {
    if (user) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.token_hash).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', request, 0) });
  }],

  ['GET', '/api/auth/me', async ({ user }) => {
    if (!user) return json({ user: null });
    const { token_hash, ...u } = user;
    return json({ user: u });
  }],

  ['GET', '/api/auth/token', async ({ env, url }) => {
    const token = url.searchParams.get('t') || '';
    const row = await env.DB.prepare(`SELECT t.purpose, u.email, u.name FROM tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.expires_at > ?`).bind(await sha256(token), new Date().toISOString()).first();
    if (!row) fail(404, 'Il link è scaduto o è già stato usato. Chiedi al fornitore un nuovo invito.');
    return json(row);
  }],

  ['POST', '/api/auth/set-password', async ({ env, request }) => {
    const b = await readJson(request);
    if (!b.password || b.password.length < MIN_PW) fail(400, `La password deve avere almeno ${MIN_PW} caratteri.`);
    const hash = await sha256(String(b.token || ''));
    const row = await env.DB.prepare("SELECT t.* FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.expires_at > ? AND u.role = 'cliente'").bind(hash, new Date().toISOString()).first();
    if (!row) fail(400, 'Il link è scaduto o è già stato usato.');
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(b.password), row.user_id),
      env.DB.prepare('DELETE FROM tokens WHERE user_id = ?').bind(row.user_id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
    ]);
    const user = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(row.user_id).first();
    const token = await createSession(env, row.user_id);
    return json({ ok: true, role: user.role }, 200, { 'set-cookie': sessionCookie(token, request) });
  }],

  ['POST', '/api/auth/forgot', async ({ env, request }) => {
    const b = await readJson(request);
    const user = await env.DB.prepare("SELECT * FROM users WHERE email = ? AND active = 1 AND role = 'cliente'").bind(String(b.email || '').trim()).first();
    if (user) {
      const s = await getSettings(env);
      const token = await createUserToken(env, user.id, 'reset', 1);
      await sendEmail(env, {
        to: user.email, subject: `Reimposta la password · ${s.company_name}`,
        html: emailLayout({
          company: s.company_name, title: 'Reimposta la password',
          intro: 'Hai chiesto di reimpostare la password per ordinare online. Il link vale 24 ore.',
          button: { url: `${appUrl(env, request)}/#/password/${token}`, label: 'Scegli una nuova password' },
          footer: 'Se non sei stato tu, ignora questa email.',
        }),
      });
    }
    return json({ ok: true, email_enabled: Boolean(env.RESEND_API_KEY) });
  }],

  ['POST', '/api/auth/change-password', async ({ env, request, user }) => {
    if (!user) fail(401, 'Accedi di nuovo.');
    if (user.role === 'admin') fail(400, 'La password del pannello si cambia su Cloudflare (ADMIN_PASSWORD).');
    const b = await readJson(request);
    const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first();
    if (!(await verifyPassword(String(b.old || ''), row.password_hash))) fail(400, 'La password attuale non è corretta.');
    if (!b.password || b.password.length < MIN_PW) fail(400, `La nuova password deve avere almeno ${MIN_PW} caratteri.`);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(b.password), user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, user.token_hash),
    ]);
    return json({ ok: true });
  }],

  // ---------- push & notifiche (entrambi i ruoli) ----------
  ['POST', '/api/push/subscribe', async ({ env, request, user }) => {
    if (!user) fail(401, 'Accedi di nuovo.');
    const b = await readJson(request);
    const s = b.subscription || {};
    if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth) fail(400, 'Sottoscrizione non valida.');
    if (!/^https:\/\//.test(s.endpoint)) fail(400, 'Endpoint non valido.');
    await env.DB.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .bind(user.id, s.endpoint, s.keys.p256dh, s.keys.auth, (request.headers.get('user-agent') || '').slice(0, 200)).run();
    return json({ ok: true });
  }],
  ['POST', '/api/push/unsubscribe', async ({ env, request, user }) => {
    if (!user) fail(401, 'Accedi di nuovo.');
    const b = await readJson(request);
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(String(b.endpoint || ''), user.id).run();
    return json({ ok: true });
  }],
  ['POST', '/api/push/test', async ({ env, user }) => {
    if (!user) fail(401, 'Accedi di nuovo.');
    const { notifyUsers } = await import('./core.js');
    await notifyUsers(env, [user.id], { title: 'Notifiche attive', body: 'Riceverai qui gli aggiornamenti sugli ordini.', url: user.role === 'admin' ? '/admin/' : '/' });
    return json({ ok: true });
  }],
  ['GET', '/api/notifications', async ({ env, user }) => {
    if (!user) fail(401, 'Accedi di nuovo.');
    const { results } = await env.DB.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 40').bind(user.id).all();
    const unread = results.filter(n => !n.read).length;
    return json({ items: results, unread });
  }],
  ['POST', '/api/notifications/read', async ({ env, user }) => {
    if (!user) fail(401, 'Accedi di nuovo.');
    await env.DB.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').bind(user.id).run();
    return json({ ok: true });
  }],
];
