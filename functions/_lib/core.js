import {
  fail, sha256, randomToken, nowRome, addDays, isoDow, shortId, euro, fmtDateIt, STATUS_LABEL,
} from './util.js';
import { sendPush, pushEnabled } from './webpush.js';
import { sendEmail, emailLayout } from './email.js';

// ---------- impostazioni ----------
export async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(results.map(r => [r.key, r.value]));
}
export const appUrl = (env, request) => (env.APP_URL || new URL(request.url).origin).replace(/\/$/, '');

// impronta della password admin: se cambi ADMIN_PASSWORD su Cloudflare, tutte le sessioni admin decadono
export const adminFingerprint = env => sha256(`admin-fp:${env.ADMIN_PASSWORD || env.ADMIN_PASSWORD_HASH || ''}`);

// ---------- sessioni ----------
const SESSION_DAYS = 60;
export async function createSession(env, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), userId, expires).run();
  await env.DB.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").bind(userId).run();
  return token;
}
export function sessionCookie(token, request, maxAge = SESSION_DAYS * 86400) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
export async function currentUser(env, request) {
  const token = readCookie(request, 'sid');
  if (!token) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.customer_id, u.active, s.token_hash,
           c.business_name, c.blocked, c.blocked_reason
    FROM sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN customers c ON c.id = u.customer_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(hash, new Date().toISOString()).first();
  if (!row || !row.active) return null;
  if (row.role === 'admin') {
    const u = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(row.id).first();
    if (!(env.ADMIN_PASSWORD || env.ADMIN_PASSWORD_HASH) || u?.password_hash !== await adminFingerprint(env)) return null;
  }
  return row;
}

// token per invito / reset password
export async function createUserToken(env, userId, purpose, days = 7) {
  const token = randomToken(24);
  await env.DB.prepare('DELETE FROM tokens WHERE user_id = ? AND purpose = ?').bind(userId, purpose).run();
  await env.DB.prepare('INSERT INTO tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), userId, purpose, new Date(Date.now() + days * 864e5).toISOString()).run();
  return token;
}

// ---------- notifiche (in-app + push) ----------
export async function notifyUsers(env, userIds, { title, body, url, tag }) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return;
  const stmts = ids.map(id => env.DB.prepare('INSERT INTO notifications (user_id, title, body, url) VALUES (?, ?, ?, ?)')
    .bind(id, title, body || null, url || null));
  await env.DB.batch(stmts);
  if (!pushEnabled(env)) return;
  const placeholders = ids.map(() => '?').join(',');
  const { results: subs } = await env.DB.prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${placeholders})`).bind(...ids).all();
  const outcomes = await Promise.all(subs.map(s => sendPush(env, s, { title, body, url, tag })));
  const gone = subs.filter((_, i) => outcomes[i] === 'gone').map(s => s.id);
  if (gone.length) await env.DB.prepare(`DELETE FROM push_subscriptions WHERE id IN (${gone.map(() => '?').join(',')})`).bind(...gone).run();
}
export async function adminIds(env) {
  const { results } = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1").all();
  return results.map(r => r.id);
}
export async function customerUserIds(env, customerId) {
  const { results } = await env.DB.prepare("SELECT id FROM users WHERE customer_id = ? AND active = 1").bind(customerId).all();
  return results.map(r => r.id);
}

// ---------- prezzi ----------
export function effectivePrice(product, customer, customPrice) {
  if (customPrice !== null && customPrice !== undefined) return customPrice;
  const disc = Number(customer?.discount || 0);
  return Math.round(product.price * (1 - disc / 100));
}

// ---------- promozioni ----------
export function promoPrice(promo, listPrice) {
  return promo.kind === 'prezzo' ? Math.round(promo.value) : Math.round(listPrice * (1 - Number(promo.value) / 100));
}
/** Promozioni attive oggi per il cliente (tutte o della sua zona), indicizzate per prodotto. */
export async function activePromos(env, customer) {
  const today = nowRome().date;
  const { results } = await env.DB.prepare(`SELECT * FROM promotions WHERE active = 1 AND starts_on <= ?1 AND ends_on >= ?1
    AND (zone_id IS NULL OR zone_id = ?2)`).bind(today, customer?.zone_id ?? -1).all();
  const byProduct = new Map();
  for (const pr of results) (byProduct.get(pr.product_id) || byProduct.set(pr.product_id, []).get(pr.product_id)).push(pr);
  return byProduct;
}
/** Prezzo finale: il migliore tra prezzo cliente e promozione. */
function withPromo(p, customer, customPrice, promos) {
  const regular = effectivePrice(p, customer, customPrice);
  let best = null;
  for (const pr of promos.get(p.id) || []) {
    const v = promoPrice(pr, p.price);
    if (v < regular && (!best || v < best.price)) best = { price: v, promo: pr };
  }
  return best
    ? { price: best.price, regular_price: regular, promo: { id: best.promo.id, title: best.promo.title, description: best.promo.description, ends_on: best.promo.ends_on } }
    : { price: regular, regular_price: regular, promo: null };
}

/** Prodotti ordinabili da un cliente con prezzo effettivo. */
export async function catalogFor(env, customer) {
  const { results } = await env.DB.prepare(`
    SELECT p.*, cp.price AS custom_price,
      EXISTS (SELECT 1 FROM favorites f WHERE f.customer_id = ?1 AND f.product_id = p.id) AS favorite
    FROM products p
    LEFT JOIN customer_prices cp ON cp.product_id = p.id AND cp.customer_id = ?1
    WHERE p.archived = 0
      AND (NOT EXISTS (SELECT 1 FROM product_visibility v WHERE v.product_id = p.id)
           OR EXISTS (SELECT 1 FROM product_visibility v WHERE v.product_id = p.id AND v.customer_id = ?1))
    ORDER BY p.sort, p.name`).bind(customer.id).all();
  const promos = await activePromos(env, customer);
  return results.map(p => ({
    id: p.id, sku: p.sku, name: p.name, description: p.description, category_id: p.category_id,
    unit: p.unit, pack: p.pack, vat_rate: p.vat_rate, min_qty: p.min_qty, step_qty: p.step_qty,
    available: p.available && (p.stock === null || p.stock > 0) ? 1 : 0,
    stock: p.stock, featured: p.featured, favorite: p.favorite,
    image: p.image_key ? `/api/img/${p.image_key}` : (p.image_url || null),
    list_price: p.price,
    ...withPromo(p, customer, p.custom_price, promos),
  }));
}

// ---------- consegne ----------
export async function zoneFor(env, customer) {
  if (customer.zone_id) {
    const z = await env.DB.prepare('SELECT * FROM zones WHERE id = ?').bind(customer.zone_id).first();
    if (z) return z;
  }
  return { id: null, name: 'Standard', delivery_days: '1,2,3,4,5', cutoff_time: '18:00', lead_days: 1, delivery_fee: 0, free_over: 0 };
}

export function deliveryOptions(zone, settings, limit = 12, now = new Date()) {
  const { date: today, time } = nowRome(now);
  const days = String(zone.delivery_days || '').split(',').map(Number).filter(Boolean);
  const closed = new Set(String(settings.closed_dates || '').split(/[\s,;]+/).filter(Boolean));
  const lead = Number(zone.lead_days || 0);
  const cutoff = zone.cutoff_time || '23:59';
  const out = [];
  for (let i = 0; i < 60 && out.length < limit; i++) {
    const d = addDays(today, i);
    if (!days.includes(isoDow(d)) || closed.has(d)) continue;
    const deadlineDate = addDays(d, -lead);
    if (deadlineDate < today || (deadlineDate === today && time >= cutoff)) continue;
    out.push({ date: d, deadline: `${deadlineDate}T${cutoff}`, deadline_date: deadlineDate, cutoff });
  }
  return out;
}

// ---------- ordini ----------
export function computeTotals(items, zone) {
  let subtotal = 0;
  const vatByRate = {};
  for (const it of items) {
    it.line_total = Math.round(it.price * it.qty);
    subtotal += it.line_total;
    vatByRate[it.vat_rate] = (vatByRate[it.vat_rate] || 0) + it.line_total;
  }
  let fee = 0;
  if (zone && zone.delivery_fee > 0 && !(zone.free_over > 0 && subtotal >= zone.free_over)) fee = zone.delivery_fee;
  if (fee) vatByRate[22] = (vatByRate[22] || 0) + fee;
  const vat = Object.entries(vatByRate).reduce((a, [rate, base]) => a + Math.round(base * Number(rate) / 100), 0);
  return { subtotal, delivery_fee: fee, vat_total: vat, total: subtotal + fee + vat };
}

function validQty(qty, p) {
  if (!(qty > 0)) return false;
  if (qty < p.min_qty) return false;
  const step = p.step_qty || 1;
  const k = (qty - p.min_qty) / step;
  return Math.abs(k - Math.round(k)) < 1e-6;
}

/**
 * Crea un ordine. by = utente che lo inserisce (cliente o admin).
 * opts.skipRules = true per ordini inseriti dall'admin (nessun vincolo cut-off / minimo).
 */
export async function createOrder(env, { customer, by, items, delivery_date, notes, source = 'app', skipRules = false }) {
  if (!Array.isArray(items) || !items.length) fail(400, 'Il carrello è vuoto.');
  if (items.length > 200) fail(400, 'Troppe righe in un solo ordine.');
  const settings = await getSettings(env);
  if (!skipRules) {
    if (settings.orders_open === '0') fail(409, settings.orders_closed_message || 'Gli ordini online sono momentaneamente sospesi.');
    if (customer.blocked) fail(403, customer.blocked_reason || 'Il tuo account non può inviare ordini. Contatta il fornitore.');
  }
  const zone = await zoneFor(env, customer);
  if (!skipRules) {
    const opts = deliveryOptions(zone, settings, 60);
    if (!opts.some(o => o.date === delivery_date)) fail(400, 'La data di consegna scelta non è più disponibile. Scegline un\'altra.');
  } else if (delivery_date && !/^\d{4}-\d{2}-\d{2}$/.test(delivery_date)) {
    fail(400, 'Data di consegna non valida.');
  }

  const catalog = skipRules ? await adminCatalogFor(env, customer) : await catalogFor(env, customer);
  const byId = new Map(catalog.map(p => [p.id, p]));
  const merged = new Map();
  for (const raw of items) {
    const id = Number(raw.product_id), qty = Number(raw.qty);
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  const lines = [];
  for (const [id, qty] of merged) {
    const p = byId.get(id);
    if (!p) fail(400, 'Un prodotto nel carrello non è più disponibile. Aggiorna la pagina.');
    if (!skipRules && !p.available) fail(409, `${p.name} non è disponibile al momento.`);
    if (!skipRules && !validQty(qty, p)) fail(400, `Quantità non valida per ${p.name} (minimo ${p.min_qty}, multipli di ${p.step_qty}).`);
    if (skipRules && !(qty > 0)) fail(400, `Quantità non valida per ${p.name}.`);
    if (!skipRules && p.stock !== null && qty > p.stock) fail(409, `Per ${p.name} sono disponibili solo ${p.stock} ${p.unit}.`);
    lines.push({ product_id: p.id, sku: p.sku, name: p.name, unit: p.unit, pack: p.pack, qty, price: p.price, vat_rate: p.vat_rate,
      list_price: p.promo ? p.regular_price : null, promo_id: p.promo?.id || null });
  }
  const totals = computeTotals(lines, zone);
  if (!skipRules) {
    const min = customer.min_order ?? Number(settings.min_order || 0);
    if (min > 0 && totals.subtotal < min) fail(400, `L'ordine minimo è ${euro(min)} IVA esclusa.`);
  }

  const id = shortId();
  const year = Number(nowRome().date.slice(0, 4));
  const status = settings.auto_confirm === '1' && !skipRules ? 'confermato' : 'nuovo';
  const agent = customer.agent_id
    ? await env.DB.prepare("SELECT id, commission FROM users WHERE id = ? AND role = 'agente'").bind(customer.agent_id).first() : null;
  const createdNote = by.role === 'admin' ? `Inserito dal fornitore (${source})` : by.role === 'agente' ? `Inserito dall'agente ${by.name || ''}`.trim() : 'Inviato dal cliente';
  const stmts = [
    env.DB.prepare(`INSERT INTO orders (id, year, seq, customer_id, user_id, agent_id, commission_rate, source, status, delivery_date, notes, subtotal, delivery_fee, vat_total, total)
      VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM orders WHERE year = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, year, year, customer.id, by.id, agent?.id ?? null, agent?.commission ?? 0, source, status, delivery_date || null, notes || null,
        totals.subtotal, totals.delivery_fee, totals.vat_total, totals.total),
    ...lines.map(l => env.DB.prepare(`INSERT INTO order_items (order_id, product_id, sku, name, unit, pack, qty, price, vat_rate, line_total, list_price, promo_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, l.product_id, l.sku, l.name, l.unit, l.pack, l.qty, l.price, l.vat_rate, l.line_total, l.list_price, l.promo_id)),
    ...lines.map(l => env.DB.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL').bind(l.qty, l.product_id)),
    env.DB.prepare('INSERT INTO order_events (order_id, type, status, note, user_id) VALUES (?, ?, ?, ?, ?)')
      .bind(id, 'status', status, createdNote, by.id),
  ];
  await env.DB.batch(stmts);
  return getOrder(env, id);
}

export async function adminCatalogFor(env, customer) {
  const { results } = await env.DB.prepare(`
    SELECT p.*, cp.price AS custom_price FROM products p
    LEFT JOIN customer_prices cp ON cp.product_id = p.id AND cp.customer_id = ?
    WHERE p.archived = 0`).bind(customer.id).all();
  const promos = await activePromos(env, customer);
  return results.map(p => ({ ...p, list_price: p.price, ...withPromo(p, customer, p.custom_price, promos) }));
}

export async function getOrder(env, id) {
  const order = await env.DB.prepare(`
    SELECT o.*, c.business_name, c.contact_name, c.phone, c.email AS customer_email, c.delivery_address, c.address, c.city,
           c.province, c.zip, c.delivery_notes, c.vat, c.zone_id, c.agent_id AS customer_agent_id,
           z.name AS zone_name, u.name AS user_name, u.role AS user_role, a.name AS agent_name, a.phone AS agent_phone
    FROM orders o JOIN customers c ON c.id = o.customer_id
    LEFT JOIN zones z ON z.id = c.zone_id
    LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN users a ON a.id = c.agent_id
    WHERE o.id = ?`).bind(id).first();
  if (!order) return null;
  const [{ results: items }, { results: events }] = await Promise.all([
    env.DB.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').bind(id).all(),
    env.DB.prepare(`SELECT e.*, u.name AS user_name, u.role AS user_role FROM order_events e
      LEFT JOIN users u ON u.id = e.user_id WHERE e.order_id = ? ORDER BY e.id`).bind(id).all(),
  ]);
  order.number = orderNumber(order);
  order.items = items;
  order.events = events;
  return order;
}
export const orderNumber = o => `${o.year}/${String(o.seq).padStart(4, '0')}`;

// notifiche ordine
export async function notifyNewOrder(env, request, order, settings, by) {
  const url = `/admin/#/ordini/${order.id}`;
  const staff = [...await adminIds(env), order.customer_agent_id].filter(id => id && id !== by?.id);
  await notifyUsers(env, staff, {
    title: by?.role === 'agente' ? `Ordine di ${by.name || 'un agente'} per ${order.business_name}` : `Nuovo ordine da ${order.business_name}`,
    body: `${order.number} · ${euro(order.total)} · consegna ${fmtDateIt(order.delivery_date)}`,
    url, tag: `order-${order.id}`,
  });
  const base = appUrl(env, request);
  const company = settings.company_name || 'Fornitore';
  const rows = order.items.map(i => [`${fmtQty(i.qty)} × ${i.name}${i.pack ? ' (' + i.pack + ')' : ''}`, euro(i.line_total)]);
  rows.push(['Totale IVA inclusa', euro(order.total)]);
  const adminTo = String(settings.order_notify_emails || '').split(/[\s,;]+/).filter(Boolean);
  const tasks = [];
  if (adminTo.length) tasks.push(sendEmail(env, {
    to: adminTo, replyTo: order.customer_email || undefined,
    subject: `Nuovo ordine ${order.number} · ${order.business_name}`,
    html: emailLayout({
      company, title: `Ordine ${order.number} da ${order.business_name}`,
      intro: `Consegna richiesta per ${fmtDateIt(order.delivery_date)}.${order.notes ? ' Note del cliente: ' + order.notes : ''}`,
      rows, button: { url: `${base}${url}`, label: 'Apri l\'ordine' },
    }),
  }));
  if (order.customer_email && order.source === 'app') tasks.push(sendEmail(env, {
    to: order.customer_email,
    subject: `Abbiamo ricevuto il tuo ordine ${order.number}`,
    html: emailLayout({
      company, title: 'Ordine ricevuto',
      intro: `Grazie! Il tuo ordine ${order.number} è stato inviato a ${company}. Consegna prevista ${fmtDateIt(order.delivery_date)}. Ti avvisiamo appena viene confermato.`,
      rows, button: { url: `${base}/#/ordini/${order.id}`, label: 'Segui l\'ordine' },
      footer: settings.order_terms,
    }),
  }));
  await Promise.all(tasks);
}

export async function notifyStatus(env, order, note) {
  const msg = {
    confermato: `Il tuo ordine ${order.number} è confermato per ${fmtDateIt(order.delivery_date)}.`,
    in_preparazione: `Stiamo preparando il tuo ordine ${order.number}.`,
    in_consegna: `Il tuo ordine ${order.number} è in consegna.`,
    consegnato: `Ordine ${order.number} consegnato. Grazie!`,
    annullato: `L'ordine ${order.number} è stato annullato.`,
  }[order.status];
  if (!msg) return;
  await notifyUsers(env, await customerUserIds(env, order.customer_id), {
    title: STATUS_LABEL[order.status], body: note ? `${msg} ${note}` : msg, url: `/#/ordini/${order.id}`, tag: `order-${order.id}`,
  });
}

export const fmtQty = q => Number.isInteger(q) ? String(q) : String(q).replace('.', ',');
