import { json, HttpError, nowRome, fmtDateIt } from './lib/util.js';
import { currentUser, getSettings, zoneFor, deliveryOptions, notifyUsers } from './lib/core.js';
import { authRoutes } from './lib/routes-auth.js';
import { clientRoutes } from './lib/routes-client.js';
import { adminRoutes, AGENT_ROUTES } from './lib/routes-admin.js';
import { ensureSchema } from './lib/migrate.js';

function compile(routes, role) {
  return routes.map(([method, path, handler]) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    return { method, re, keys, handler, role, agent: role === 'admin' && AGENT_ROUTES.has(`${method} ${path}`) };
  });
}

/** Promemoria "ordina entro il limite": eseguito dal cron del Worker ogni 30 minuti. */
export async function runReminders(env) {
  await ensureSchema(env);
    const settings = await getSettings(env);
    const hours = Number(settings.reminder_hours || 0);
    if (!hours || settings.orders_open === '0') return 0;
    const { results: customers } = await env.DB.prepare(`
      SELECT DISTINCT c.* FROM customers c JOIN users u ON u.customer_id = c.id
      JOIN push_subscriptions s ON s.user_id = u.id
      WHERE c.blocked = 0 AND u.active = 1
        AND EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.created_at > datetime('now', '-90 days'))`).all();
    let sent = 0;
    for (const c of customers) {
      const zone = await zoneFor(env, c);
      const next = deliveryOptions(zone, settings, 1)[0];
      if (!next) continue;
      // confronto in ora italiana: entrambe le date sono espresse come ora locale di Roma
      const { date, time } = nowRome();
      const minsNow = Date.parse(`${date}T${time}:00Z`);
      const minsDeadline = Date.parse(`${next.deadline}:00Z`);
      const diffH = (minsDeadline - minsNow) / 36e5;
      if (diffH <= 0 || diffH > hours) continue;
      const already = await env.DB.prepare('SELECT 1 FROM reminder_log WHERE customer_id = ? AND delivery_date = ?').bind(c.id, next.date).first();
      const ordered = await env.DB.prepare("SELECT 1 FROM orders WHERE customer_id = ? AND delivery_date = ? AND status != 'annullato'").bind(c.id, next.date).first();
      if (already || ordered) continue;
      await env.DB.prepare('INSERT INTO reminder_log (customer_id, delivery_date) VALUES (?, ?)').bind(c.id, next.date).run();
      const { results: users } = await env.DB.prepare('SELECT id FROM users WHERE customer_id = ? AND active = 1').bind(c.id).all();
      await notifyUsers(env, users.map(u => u.id), {
        title: 'Ti serve qualcosa?',
        body: `Ordina entro le ${next.cutoff}${next.deadline_date === date ? '' : ' di ' + fmtDateIt(next.deadline_date)} per ricevere ${fmtDateIt(next.date)}.`,
        url: '/', tag: 'reminder',
      });
      sent++;
    }
    return sent;
}

const ROUTES = [
  ...compile(authRoutes, 'public'),
  ...compile(clientRoutes, 'cliente'),
  ...compile(adminRoutes, 'admin'),
];

/** Gestisce tutte le richieste /api/* (context: { request, env, waitUntil }). */
export async function handleApi(context) {
  const { request } = context;
  // binding accettati anche in minuscolo (se configurati dal pannello Cloudflare)
  const env = { ...context.env };
  env.DB ||= context.env.db;
  env.IMAGES ||= context.env.images || context.env.Images;
  if (!env.DB) return json({ error: 'Database non collegato: aggiungi il binding D1 con nome DB.' }, 500);
  const url0 = new URL(request.url);
  // promemoria via HTTP (Pages non ha cron: lo chiama il piccolo worker in cron-worker/)
  if (request.method === 'POST' && url0.pathname === '/api/cron/reminders') {
    if (!env.CRON_SECRET || request.headers.get('x-cron-secret') !== env.CRON_SECRET) return json({ error: 'forbidden' }, 403);
    return json({ sent: await runReminders(env) });
  }
  const url = new URL(request.url);

  // immagini prodotto da R2
  if (request.method === 'GET' && url.pathname.startsWith('/api/img/')) {
    const key = decodeURIComponent(url.pathname.slice('/api/img/'.length));
    if (!env.IMAGES || !/^[\w.-]+$/.test(key)) return new Response('Not found', { status: 404 });
    const obj = await env.IMAGES.get(key);
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    return new Response(obj.body, { headers });
  }

  // protezione CSRF: le richieste che modificano dati devono venire dalla stessa origine
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return json({ error: 'Origine non consentita.' }, 403);
  }

  try {
    await ensureSchema(env);
    const user = await currentUser(env, request);
    for (const r of ROUTES) {
      if (r.method !== request.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      if (r.role !== 'public') {
        if (!user) return json({ error: 'Sessione scaduta: accedi di nuovo.' }, 401);
        if (user.role !== r.role && !(r.agent && user.role === 'agente')) return json({ error: 'Non hai i permessi per questa operazione.' }, 403);
      }
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = await r.handler({ env, request, url, user, params });
      if (out instanceof Response) return out;
      if (out?.waitUntil) context.waitUntil(out.waitUntil.catch(e => console.error('background', e)));
      return out.response;
    }
    return json({ error: 'Risorsa non trovata.' }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Errore imprevisto del server. Riprova tra poco.' }, 500);
  }
}
