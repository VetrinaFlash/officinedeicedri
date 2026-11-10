import {
  json, readJson, fail, str, int, num, isEmail, isIsoDate, nowRome, addDays, STATUS, STATUS_LABEL, euro, fmtDateIt,
} from './util.js';
import {
  getSettings, getOrder, createOrder, notifyNewOrder, notifyStatus, notifyUsers, zoneFor, computeTotals,
  createUserToken, appUrl, adminCatalogFor, orderNumber, deliveryOptions, effectivePrice,
} from './core.js';
import { sendEmail, emailLayout } from './email.js';

const SETTINGS_KEYS = ['company_name', 'company_address', 'company_phone', 'company_email', 'company_vat', 'logo_url', 'site_url',
  'order_notify_emails', 'min_order', 'closed_dates', 'orders_open', 'orders_closed_message', 'reminder_hours', 'auto_confirm', 'order_terms'];

function customerFields(b) {
  return {
    business_name: str(b.business_name, 150), vat: str(b.vat, 20), tax_code: str(b.tax_code, 20), sdi: str(b.sdi, 10),
    pec: str(b.pec, 120), contact_name: str(b.contact_name, 100), phone: str(b.phone, 40), email: str(b.email, 120),
    address: str(b.address, 200), city: str(b.city, 80), province: str(b.province, 4), zip: str(b.zip, 10),
    delivery_address: str(b.delivery_address, 250), delivery_notes: str(b.delivery_notes, 500),
    zone_id: b.zone_id ? int(b.zone_id) : null, discount: Math.min(100, Math.max(0, num(b.discount))),
    payment_terms: str(b.payment_terms, 120), min_order: b.min_order === '' || b.min_order === null || b.min_order === undefined ? null : int(b.min_order),
    blocked: b.blocked ? 1 : 0, blocked_reason: str(b.blocked_reason, 250), notes: str(b.notes, 2000),
  };
}
function productFields(b) {
  return {
    sku: str(b.sku, 40), name: str(b.name, 150), description: str(b.description, 1000),
    category_id: b.category_id ? int(b.category_id) : null, unit: str(b.unit, 20) || 'pz', pack: str(b.pack, 60),
    price: Math.max(0, int(b.price)), vat_rate: num(b.vat_rate, 10), min_qty: Math.max(0.001, num(b.min_qty, 1)),
    step_qty: Math.max(0.001, num(b.step_qty, 1)),
    stock: b.stock === '' || b.stock === null || b.stock === undefined ? null : num(b.stock),
    available: b.available ? 1 : 0, featured: b.featured ? 1 : 0, image_url: str(b.image_url, 500),
    sort: int(b.sort), archived: b.archived ? 1 : 0,
  };
}
const upd = (fields) => Object.keys(fields).map(k => `${k} = ?`).join(', ');

async function sendInvite(env, request, user, settings) {
  const token = await createUserToken(env, user.id, 'invite', 14);
  const link = `${appUrl(env, request)}/#/password/${token}`;
  const emailed = await sendEmail(env, {
    to: user.email,
    subject: `Il tuo accesso per ordinare da ${settings.company_name}`,
    html: emailLayout({
      company: settings.company_name,
      title: 'Puoi ordinare online',
      intro: `Ciao${user.name ? ' ' + user.name : ''}, ${settings.company_name} ti ha creato un accesso per ordinare i prodotti con i tuoi prezzi riservati. Scegli una password per entrare. Il link vale 14 giorni.`,
      button: { url: link, label: 'Scegli la password' },
      footer: `Per domande: ${settings.company_phone || ''} ${settings.company_email || ''}`,
    }),
  });
  return { link, emailed };
}

async function restockDelta(env, items, sign) {
  return items.filter(i => i.product_id).map(i =>
    env.DB.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL').bind(sign * i.qty, i.product_id));
}

export const adminRoutes = [
  // ---------- dashboard ----------
  ['GET', '/api/admin/dashboard', async ({ env }) => {
    const today = nowRome().date;
    const tomorrow = addDays(today, 1);
    const monthStart = today.slice(0, 8) + '01';
    const from30 = addDays(today, -29);
    const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
    const [counts, month, prevMonth, byDay, topProducts, topCustomers, dormant, lowStock, recent] = await Promise.all([
      q(`SELECT
          SUM(status = 'nuovo') AS nuovi,
          SUM(delivery_date = ? AND status NOT IN ('annullato')) AS oggi,
          SUM(delivery_date = ? AND status NOT IN ('annullato')) AS domani,
          SUM(status IN ('confermato','in_preparazione')) AS da_evadere
        FROM orders`, today, tomorrow).first(),
      q(`SELECT COALESCE(SUM(subtotal),0) AS imponibile, COUNT(*) AS ordini, COUNT(DISTINCT customer_id) AS clienti
         FROM orders WHERE status != 'annullato' AND date(created_at) >= ?`, monthStart).first(),
      q(`SELECT COALESCE(SUM(subtotal),0) AS imponibile FROM orders WHERE status != 'annullato'
         AND date(created_at) >= date(?, '-1 month') AND date(created_at) < ?`, monthStart, monthStart).first(),
      q(`SELECT date(created_at) AS d, SUM(subtotal) AS imponibile, COUNT(*) AS ordini FROM orders
         WHERE status != 'annullato' AND date(created_at) >= ? GROUP BY d ORDER BY d`, from30).all(),
      q(`SELECT i.name, i.pack, i.unit, SUM(i.qty) AS qty, SUM(i.line_total) AS imponibile FROM order_items i
         JOIN orders o ON o.id = i.order_id WHERE o.status != 'annullato' AND date(o.created_at) >= ?
         GROUP BY i.product_id, i.name ORDER BY imponibile DESC LIMIT 8`, from30).all(),
      q(`SELECT c.id, c.business_name, SUM(o.subtotal) AS imponibile, COUNT(*) AS ordini FROM orders o
         JOIN customers c ON c.id = o.customer_id WHERE o.status != 'annullato' AND date(o.created_at) >= ?
         GROUP BY c.id ORDER BY imponibile DESC LIMIT 8`, from30).all(),
      q(`SELECT c.id, c.business_name, c.phone, MAX(o.created_at) AS ultimo FROM customers c
         JOIN orders o ON o.customer_id = c.id AND o.status != 'annullato'
         WHERE c.blocked = 0 GROUP BY c.id HAVING ultimo < datetime('now', '-21 days') ORDER BY ultimo LIMIT 8`).all(),
      q(`SELECT id, name, pack, stock, unit FROM products WHERE archived = 0 AND stock IS NOT NULL AND stock <= 5 ORDER BY stock LIMIT 8`).all(),
      q(`SELECT o.id, o.year, o.seq, o.status, o.total, o.delivery_date, o.created_at, c.business_name FROM orders o
         JOIN customers c ON c.id = o.customer_id ORDER BY o.created_at DESC LIMIT 8`).all(),
    ]);
    const series = [];
    const map = new Map(byDay.results.map(r => [r.d, r]));
    for (let i = 0; i < 30; i++) { const d = addDays(from30, i); series.push({ d, imponibile: map.get(d)?.imponibile || 0, ordini: map.get(d)?.ordini || 0 }); }
    return json({
      today, tomorrow, counts, month, prev_month: prevMonth, series,
      top_products: topProducts.results, top_customers: topCustomers.results, dormant: dormant.results,
      low_stock: lowStock.results, recent: recent.results.map(o => ({ ...o, number: orderNumber(o) })),
    });
  }],

  // ---------- ordini ----------
  ['GET', '/api/admin/orders', async ({ env, url }) => {
    const p = url.searchParams;
    const where = [], args = [];
    if (p.get('status')) {
      const st = p.get('status');
      if (st === 'aperti') where.push("o.status IN ('nuovo','confermato','in_preparazione','in_consegna')");
      else { where.push('o.status = ?'); args.push(st); }
    }
    if (p.get('customer_id')) { where.push('o.customer_id = ?'); args.push(int(p.get('customer_id'))); }
    if (p.get('delivery')) { where.push('o.delivery_date = ?'); args.push(p.get('delivery')); }
    if (p.get('from')) { where.push('date(o.created_at) >= ?'); args.push(p.get('from')); }
    if (p.get('to')) { where.push('date(o.created_at) <= ?'); args.push(p.get('to')); }
    if (p.get('zone_id')) { where.push('c.zone_id = ?'); args.push(int(p.get('zone_id'))); }
    if (p.get('q')) {
      const qs = `%${p.get('q').trim()}%`;
      where.push("(c.business_name LIKE ? OR (o.year || '/' || substr('0000' || o.seq, -4)) LIKE ? OR o.notes LIKE ?)");
      args.push(qs, qs, qs);
    }
    const limit = Math.min(200, int(p.get('limit'), 50)), offset = int(p.get('offset'), 0);
    const sql = `SELECT o.id, o.year, o.seq, o.status, o.delivery_date, o.total, o.subtotal, o.created_at, o.source, o.paid, o.notes,
      c.business_name, c.id AS customer_id, z.name AS zone_name,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS lines
      FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN zones z ON z.id = c.zone_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${p.get('sort') === 'delivery' ? 'o.delivery_date, c.business_name' : 'o.created_at DESC'} LIMIT ? OFFSET ?`;
    const { results } = await env.DB.prepare(sql).bind(...args, limit + 1, offset).all();
    return json({ items: results.slice(0, limit).map(o => ({ ...o, number: orderNumber(o) })), more: results.length > limit });
  }],

  ['GET', '/api/admin/orders/:id', async ({ env, params }) => {
    const order = await getOrder(env, params.id);
    if (!order) fail(404, 'Ordine non trovato.');
    return json({ order });
  }],

  ['POST', '/api/admin/orders', async ({ env, request, user }) => {
    const b = await readJson(request);
    const customer = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(int(b.customer_id)).first();
    if (!customer) fail(400, 'Scegli il cliente.');
    const order = await createOrder(env, {
      customer, by: user, items: b.items, delivery_date: b.delivery_date || null, notes: str(b.notes, 1000),
      source: ['telefono', 'whatsapp', 'email', 'agente', 'app'].includes(b.source) ? b.source : 'telefono', skipRules: true,
    });
    if (b.status && STATUS.includes(b.status) && b.status !== 'nuovo') {
      await env.DB.batch([
        env.DB.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(b.status, order.id),
        env.DB.prepare("INSERT INTO order_events (order_id, type, status, user_id) VALUES (?, 'status', ?, ?)").bind(order.id, b.status, user.id),
      ]);
      order.status = b.status;
    }
    const work = b.notify_customer ? notifyStatus(env, order) : null;
    return { response: json({ order }), waitUntil: work };
  }],

  ['POST', '/api/admin/orders/:id/status', async ({ env, request, user, params }) => {
    const b = await readJson(request);
    if (!STATUS.includes(b.status)) fail(400, 'Stato non valido.');
    const order = await getOrder(env, params.id);
    if (!order) fail(404, 'Ordine non trovato.');
    if (order.status === b.status) return json({ order });
    const stmts = [
      env.DB.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(b.status, order.id),
      env.DB.prepare("INSERT INTO order_events (order_id, type, status, note, user_id) VALUES (?, 'status', ?, ?, ?)")
        .bind(order.id, b.status, str(b.note, 500), user.id),
    ];
    if (b.status === 'annullato') stmts.push(...await restockDelta(env, order.items, +1));
    if (order.status === 'annullato') stmts.push(...await restockDelta(env, order.items, -1));
    await env.DB.batch(stmts);
    const updated = await getOrder(env, order.id);
    const work = b.notify === false ? null : notifyStatus(env, updated, str(b.note, 500));
    return { response: json({ order: updated }), waitUntil: work };
  }],

  // stato in blocco (es. tutti gli ordini di domani "in consegna")
  ['POST', '/api/admin/orders/bulk-status', async ({ env, request, user }) => {
    const b = await readJson(request);
    if (!STATUS.includes(b.status) || b.status === 'annullato') fail(400, 'Stato non valido.');
    const ids = (b.ids || []).map(String).slice(0, 200);
    const orders = [];
    for (const id of ids) {
      const o = await getOrder(env, id);
      if (!o || o.status === b.status || o.status === 'annullato') continue;
      await env.DB.batch([
        env.DB.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(b.status, id),
        env.DB.prepare("INSERT INTO order_events (order_id, type, status, user_id) VALUES (?, 'status', ?, ?)").bind(id, b.status, user.id),
      ]);
      o.status = b.status;
      orders.push(o);
    }
    const work = Promise.all(orders.map(o => notifyStatus(env, o)));
    return { response: json({ updated: orders.length }), waitUntil: work };
  }],

  ['PUT', '/api/admin/orders/:id', async ({ env, request, user, params }) => {
    const b = await readJson(request);
    const order = await getOrder(env, params.id);
    if (!order) fail(404, 'Ordine non trovato.');
    if (b.delivery_date && !isIsoDate(b.delivery_date)) fail(400, 'Data non valida.');
    const stmts = [env.DB.prepare(`UPDATE orders SET delivery_date = ?, admin_notes = ?, paid = ?, invoice_ref = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(b.delivery_date || order.delivery_date, str(b.admin_notes, 2000), b.paid ? 1 : 0, str(b.invoice_ref, 60), order.id)];
    if (b.delivery_date && b.delivery_date !== order.delivery_date) {
      stmts.push(env.DB.prepare("INSERT INTO order_events (order_id, type, note, user_id) VALUES (?, 'edit', ?, ?)")
        .bind(order.id, `Consegna spostata a ${fmtDateIt(b.delivery_date)}`, user.id));
    }
    await env.DB.batch(stmts);
    const updated = await getOrder(env, order.id);
    let work = null;
    if (b.delivery_date && b.delivery_date !== order.delivery_date && b.notify !== false) {
      const { customerUserIds } = await import('./core.js');
      work = notifyUsers(env, await customerUserIds(env, order.customer_id), {
        title: 'Consegna spostata', body: `L'ordine ${order.number} arriverà ${fmtDateIt(b.delivery_date)}.`, url: `/#/ordini/${order.id}`,
      });
    }
    return { response: json({ order: updated }), waitUntil: work };
  }],

  // modifica righe (quantità effettive, prodotti sostituiti, prezzi)
  ['PUT', '/api/admin/orders/:id/items', async ({ env, request, user, params }) => {
    const b = await readJson(request);
    const order = await getOrder(env, params.id);
    if (!order) fail(404, 'Ordine non trovato.');
    if (!Array.isArray(b.items) || !b.items.length) fail(400, 'L\'ordine deve avere almeno una riga. Per eliminarlo, annullalo.');
    const customer = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(order.customer_id).first();
    const catalog = new Map((await adminCatalogFor(env, customer)).map(p => [p.id, p]));
    const old = new Map(order.items.map(i => [i.id, i]));
    const lines = b.items.map(raw => {
      const qty = num(raw.qty);
      if (!(qty > 0)) fail(400, 'Le quantità devono essere maggiori di zero.');
      const prev = raw.id ? old.get(int(raw.id)) : null;
      const p = raw.product_id ? catalog.get(int(raw.product_id)) : null;
      const usePrev = prev && (!raw.product_id || int(raw.product_id) === prev.product_id);
      const base = usePrev ? prev : p;
      if (!base) fail(400, 'Prodotto non trovato.');
      const price = raw.price !== undefined && raw.price !== null && raw.price !== '' ? Math.max(0, int(raw.price)) : base.price;
      return { product_id: usePrev ? prev.product_id : p.id, sku: base.sku, name: base.name, unit: base.unit, pack: base.pack, qty, price, vat_rate: base.vat_rate };
    });
    const zone = await zoneFor(env, customer);
    const totals = computeTotals(lines, zone);
    if (b.delivery_fee !== undefined && b.delivery_fee !== null && b.delivery_fee !== '') {
      const fee = Math.max(0, int(b.delivery_fee));
      const vatDiff = Math.round((fee - totals.delivery_fee) * 0.22);
      totals.vat_total += vatDiff; totals.total += (fee - totals.delivery_fee) + vatDiff; totals.delivery_fee = fee;
    }
    const stmts = [];
    if (order.status !== 'annullato') { stmts.push(...await restockDelta(env, order.items, +1)); stmts.push(...await restockDelta(env, lines, -1)); }
    stmts.push(
      env.DB.prepare('DELETE FROM order_items WHERE order_id = ?').bind(order.id),
      ...lines.map(l => env.DB.prepare(`INSERT INTO order_items (order_id, product_id, sku, name, unit, pack, qty, price, vat_rate, line_total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(order.id, l.product_id, l.sku, l.name, l.unit, l.pack, l.qty, l.price, l.vat_rate, l.line_total)),
      env.DB.prepare(`UPDATE orders SET subtotal = ?, delivery_fee = ?, vat_total = ?, total = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(totals.subtotal, totals.delivery_fee, totals.vat_total, totals.total, order.id),
      env.DB.prepare("INSERT INTO order_events (order_id, type, note, user_id) VALUES (?, 'edit', ?, ?)")
        .bind(order.id, str(b.note, 300) || `Righe modificate · nuovo totale ${euro(totals.total)}`, user.id),
    );
    await env.DB.batch(stmts);
    const updated = await getOrder(env, order.id);
    let work = null;
    if (b.notify) {
      const { customerUserIds } = await import('./core.js');
      work = notifyUsers(env, await customerUserIds(env, order.customer_id), {
        title: 'Ordine aggiornato', body: `Abbiamo aggiornato l'ordine ${order.number}: nuovo totale ${euro(updated.total)}.${b.note ? ' ' + b.note : ''}`,
        url: `/#/ordini/${order.id}`,
      });
    }
    return { response: json({ order: updated }), waitUntil: work };
  }],

  ['POST', '/api/admin/orders/:id/message', async ({ env, request, user, params }) => {
    const b = await readJson(request);
    const order = await getOrder(env, params.id);
    if (!order) fail(404, 'Ordine non trovato.');
    const text = str(b.text, 500);
    if (!text) fail(400, 'Scrivi il messaggio.');
    await env.DB.prepare("INSERT INTO order_events (order_id, type, note, user_id) VALUES (?, 'message', ?, ?)").bind(order.id, text, user.id).run();
    const { customerUserIds } = await import('./core.js');
    const work = notifyUsers(env, await customerUserIds(env, order.customer_id), {
      title: `Messaggio sull'ordine ${order.number}`, body: text, url: `/#/ordini/${order.id}`,
    });
    return { response: json({ ok: true }), waitUntil: work };
  }],

  // ---------- preparazione / giro consegne ----------
  ['GET', '/api/admin/picking', async ({ env, url }) => {
    const date = url.searchParams.get('date') || addDays(nowRome().date, 1);
    if (!isIsoDate(date)) fail(400, 'Data non valida.');
    const statuses = (url.searchParams.get('statuses') || 'nuovo,confermato,in_preparazione,in_consegna').split(',').filter(s => STATUS.includes(s));
    const ph = statuses.map(() => '?').join(',');
    const { results: orders } = await env.DB.prepare(`
      SELECT o.id, o.year, o.seq, o.status, o.total, o.notes, o.paid, c.business_name, c.phone, c.contact_name,
        COALESCE(NULLIF(c.delivery_address, ''), TRIM(COALESCE(c.address, '') || CASE WHEN c.address IS NOT NULL AND c.city IS NOT NULL THEN ', ' ELSE '' END || COALESCE(c.city, ''))) AS address, c.delivery_notes, c.payment_terms,
        z.id AS zone_id, COALESCE(z.name, 'Senza zona') AS zone_name, z.sort AS zone_sort
      FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN zones z ON z.id = c.zone_id
      WHERE o.delivery_date = ? AND o.status IN (${ph})
      ORDER BY z.sort, c.city, c.business_name`).bind(date, ...statuses).all();
    const ids = orders.map(o => o.id);
    let items = [];
    if (ids.length) {
      const r = await env.DB.prepare(`SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')}) ORDER BY name`).bind(...ids).all();
      items = r.results;
    }
    const totals = new Map();
    for (const i of items) {
      const key = `${i.product_id || i.name}|${i.pack || ''}`;
      const t = totals.get(key) || { name: i.name, pack: i.pack, unit: i.unit, sku: i.sku, qty: 0, orders: 0 };
      t.qty += i.qty; t.orders += 1; totals.set(key, t);
    }
    const itemsByOrder = Object.groupBy ? Object.groupBy(items, i => i.order_id) : items.reduce((a, i) => ((a[i.order_id] ||= []).push(i), a), {});
    return json({
      date, products: [...totals.values()].sort((a, b) => a.name.localeCompare(b.name)),
      orders: orders.map(o => ({ ...o, number: orderNumber(o), items: itemsByOrder[o.id] || [] })),
    });
  }],

  ['GET', '/api/admin/export/orders.csv', async ({ env, url }) => {
    const from = url.searchParams.get('from') || addDays(nowRome().date, -30);
    const to = url.searchParams.get('to') || nowRome().date;
    const { results } = await env.DB.prepare(`
      SELECT o.year, o.seq, date(o.created_at) AS data, o.delivery_date, o.status, c.business_name, c.vat, i.sku, i.name, i.pack, i.unit,
        i.qty, i.price, i.vat_rate, i.line_total, o.subtotal, o.delivery_fee, o.vat_total, o.total, o.paid, o.invoice_ref
      FROM orders o JOIN customers c ON c.id = o.customer_id JOIN order_items i ON i.order_id = o.id
      WHERE date(o.created_at) BETWEEN ? AND ? AND o.status != 'annullato' ORDER BY o.year, o.seq, i.id`).bind(from, to).all();
    const cents = v => (v / 100).toFixed(2).replace('.', ',');
    const cell = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['Ordine', 'Data', 'Consegna', 'Stato', 'Cliente', 'P.IVA', 'Codice', 'Prodotto', 'Formato', 'Unità', 'Quantità',
      'Prezzo unitario', 'IVA %', 'Totale riga', 'Imponibile ordine', 'Consegna', 'IVA ordine', 'Totale ordine', 'Pagato', 'Rif. fattura'];
    const rows = results.map(r => [orderNumber(r), r.data, r.delivery_date, STATUS_LABEL[r.status], r.business_name, r.vat, r.sku, r.name, r.pack,
      r.unit, String(r.qty).replace('.', ','), cents(r.price), r.vat_rate, cents(r.line_total), cents(r.subtotal), cents(r.delivery_fee),
      cents(r.vat_total), cents(r.total), r.paid ? 'sì' : 'no', r.invoice_ref]);
    const csv = '﻿' + [head, ...rows].map(r => r.map(cell).join(';')).join('\r\n');
    return new Response(csv, { headers: {
      'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="ordini_${from}_${to}.csv"`,
    } });
  }],

  // ---------- prodotti ----------
  ['GET', '/api/admin/products', async ({ env }) => {
    const { results } = await env.DB.prepare(`SELECT p.*, c.name AS category_name,
      (SELECT COUNT(*) FROM product_visibility v WHERE v.product_id = p.id) AS reserved_to
      FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.archived, c.sort, p.sort, p.name`).all();
    return json({ items: results.map(p => ({ ...p, image: p.image_key ? `/api/img/${p.image_key}` : p.image_url })) });
  }],
  ['POST', '/api/admin/products', async ({ env, request }) => {
    const f = productFields(await readJson(request));
    if (!f.name) fail(400, 'Inserisci il nome del prodotto.');
    const r = await env.DB.prepare(`INSERT INTO products (${Object.keys(f).join(',')}) VALUES (${Object.keys(f).map(() => '?').join(',')}) RETURNING id`)
      .bind(...Object.values(f)).first();
    return json({ id: r.id });
  }],
  ['PUT', '/api/admin/products/:id', async ({ env, request, params }) => {
    const f = productFields(await readJson(request));
    if (!f.name) fail(400, 'Inserisci il nome del prodotto.');
    await env.DB.prepare(`UPDATE products SET ${upd(f)} WHERE id = ?`).bind(...Object.values(f), int(params.id)).run();
    return json({ ok: true });
  }],
  ['PATCH', '/api/admin/products/:id', async ({ env, request, params }) => {
    const b = await readJson(request);
    const allowed = { available: v => (v ? 1 : 0), price: v => Math.max(0, int(v)), stock: v => (v === '' || v === null ? null : num(v)), featured: v => (v ? 1 : 0) };
    const sets = [], args = [];
    for (const [k, fn] of Object.entries(allowed)) if (k in b) { sets.push(`${k} = ?`); args.push(fn(b[k])); }
    if (!sets.length) fail(400, 'Nessuna modifica.');
    await env.DB.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).bind(...args, int(params.id)).run();
    return json({ ok: true });
  }],
  ['DELETE', '/api/admin/products/:id', async ({ env, params }) => {
    const used = await env.DB.prepare('SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1').bind(int(params.id)).first();
    if (used) {
      await env.DB.prepare('UPDATE products SET archived = 1, available = 0 WHERE id = ?').bind(int(params.id)).run();
      return json({ archived: true });
    }
    const p = await env.DB.prepare('SELECT image_key FROM products WHERE id = ?').bind(int(params.id)).first();
    if (p?.image_key && env.IMAGES) await env.IMAGES.delete(p.image_key);
    await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(int(params.id)).run();
    return json({ deleted: true });
  }],
  ['POST', '/api/admin/products/:id/image', async ({ env, request, params }) => {
    if (!env.IMAGES) fail(500, 'Archivio immagini R2 non configurato.');
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') fail(400, 'Seleziona un\'immagine.');
    if (!/^image\/(jpeg|png|webp|avif)$/.test(file.type)) fail(400, 'Formato non supportato: usa JPG, PNG o WebP.');
    if (file.size > 4 * 1024 * 1024) fail(400, 'L\'immagine supera 4 MB.');
    const id = int(params.id);
    const old = await env.DB.prepare('SELECT image_key FROM products WHERE id = ?').bind(id).first();
    if (!old) fail(404, 'Prodotto non trovato.');
    const key = `p${id}-${Date.now().toString(36)}.${file.type.split('/')[1]}`;
    await env.IMAGES.put(key, file.stream(), { httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' } });
    if (old.image_key) await env.IMAGES.delete(old.image_key);
    await env.DB.prepare('UPDATE products SET image_key = ? WHERE id = ?').bind(key, id).run();
    return json({ image: `/api/img/${key}` });
  }],
  ['DELETE', '/api/admin/products/:id/image', async ({ env, params }) => {
    const p = await env.DB.prepare('SELECT image_key FROM products WHERE id = ?').bind(int(params.id)).first();
    if (p?.image_key && env.IMAGES) await env.IMAGES.delete(p.image_key);
    await env.DB.prepare('UPDATE products SET image_key = NULL WHERE id = ?').bind(int(params.id)).run();
    return json({ ok: true });
  }],
  ['GET', '/api/admin/products/:id/visibility', async ({ env, params }) => {
    const { results } = await env.DB.prepare('SELECT customer_id FROM product_visibility WHERE product_id = ?').bind(int(params.id)).all();
    return json({ customer_ids: results.map(r => r.customer_id) });
  }],
  ['PUT', '/api/admin/products/:id/visibility', async ({ env, request, params }) => {
    const b = await readJson(request);
    const pid = int(params.id);
    const ids = [...new Set((b.customer_ids || []).map(Number).filter(Boolean))];
    await env.DB.batch([
      env.DB.prepare('DELETE FROM product_visibility WHERE product_id = ?').bind(pid),
      ...ids.map(cid => env.DB.prepare('INSERT INTO product_visibility (product_id, customer_id) VALUES (?, ?)').bind(pid, cid)),
    ]);
    return json({ ok: true });
  }],
  // import listino da CSV (già interpretato nel browser): upsert per codice
  ['POST', '/api/admin/products/import', async ({ env, request }) => {
    const b = await readJson(request);
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 2000) : [];
    if (!rows.length) fail(400, 'Il file non contiene righe.');
    const { results: cats } = await env.DB.prepare('SELECT id, name FROM categories').all();
    const catByName = new Map(cats.map(c => [c.name.toLowerCase(), c.id]));
    let created = 0, updated = 0;
    for (const r of rows) {
      let catId = null;
      if (r.category) {
        const k = String(r.category).trim().toLowerCase();
        catId = catByName.get(k);
        if (!catId) {
          const c = await env.DB.prepare('INSERT INTO categories (name, sort) VALUES (?, 99) RETURNING id').bind(String(r.category).trim()).first();
          catId = c.id; catByName.set(k, catId);
        }
      }
      const existing = r.sku ? await env.DB.prepare('SELECT * FROM products WHERE sku = ?').bind(String(r.sku).trim()).first() : null;
      if (existing) {
        await env.DB.prepare(`UPDATE products SET name = COALESCE(?, name), price = COALESCE(?, price), vat_rate = COALESCE(?, vat_rate),
          unit = COALESCE(?, unit), pack = COALESCE(?, pack), category_id = COALESCE(?, category_id), stock = CASE WHEN ? THEN ? ELSE stock END WHERE id = ?`)
          .bind(str(r.name, 150), r.price != null ? int(r.price) : null, r.vat_rate != null ? num(r.vat_rate) : null, str(r.unit, 20), str(r.pack, 60),
            catId, r.stock !== undefined ? 1 : 0, r.stock === '' || r.stock == null ? null : num(r.stock), existing.id).run();
        updated++;
      } else if (r.name) {
        await env.DB.prepare(`INSERT INTO products (sku, name, category_id, unit, pack, price, vat_rate, stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(str(r.sku, 40), str(r.name, 150), catId, str(r.unit, 20) || 'pz', str(r.pack, 60), int(r.price), r.vat_rate != null ? num(r.vat_rate) : 10,
            r.stock === '' || r.stock == null ? null : num(r.stock)).run();
        created++;
      }
    }
    return json({ created, updated });
  }],

  // ---------- categorie ----------
  ['GET', '/api/admin/categories', async ({ env }) => {
    const { results } = await env.DB.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.archived = 0) AS products
      FROM categories c ORDER BY c.sort, c.name`).all();
    return json({ items: results });
  }],
  ['POST', '/api/admin/categories', async ({ env, request }) => {
    const b = await readJson(request);
    if (!str(b.name)) fail(400, 'Inserisci il nome.');
    const r = await env.DB.prepare('INSERT INTO categories (name, sort) VALUES (?, ?) RETURNING id').bind(str(b.name, 80), int(b.sort)).first();
    return json({ id: r.id });
  }],
  ['PUT', '/api/admin/categories/:id', async ({ env, request, params }) => {
    const b = await readJson(request);
    await env.DB.prepare('UPDATE categories SET name = ?, sort = ? WHERE id = ?').bind(str(b.name, 80), int(b.sort), int(params.id)).run();
    return json({ ok: true });
  }],
  ['DELETE', '/api/admin/categories/:id', async ({ env, params }) => {
    await env.DB.prepare('DELETE FROM categories WHERE id = ?').bind(int(params.id)).run();
    return json({ ok: true });
  }],

  // ---------- clienti ----------
  ['GET', '/api/admin/customers', async ({ env, url }) => {
    const q = url.searchParams.get('q');
    const { results } = await env.DB.prepare(`
      SELECT c.*, z.name AS zone_name,
        (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status != 'annullato') AS orders_count,
        (SELECT MAX(created_at) FROM orders o WHERE o.customer_id = c.id AND o.status != 'annullato') AS last_order,
        (SELECT COALESCE(SUM(subtotal),0) FROM orders o WHERE o.customer_id = c.id AND o.status != 'annullato' AND date(o.created_at) >= date('now','-365 days')) AS revenue_year,
        (SELECT COUNT(*) FROM users u WHERE u.customer_id = c.id AND u.password_hash IS NOT NULL) AS active_users,
        (SELECT COUNT(*) FROM users u WHERE u.customer_id = c.id) AS users_count
      FROM customers c LEFT JOIN zones z ON z.id = c.zone_id
      ${q ? 'WHERE c.business_name LIKE ?1 OR c.vat LIKE ?1 OR c.city LIKE ?1 OR c.email LIKE ?1' : ''}
      ORDER BY c.business_name`).bind(...(q ? [`%${q}%`] : [])).all();
    return json({ items: results });
  }],
  ['GET', '/api/admin/customers/:id', async ({ env, params }) => {
    const id = int(params.id);
    const c = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
    if (!c) fail(404, 'Cliente non trovato.');
    const [{ results: users }, { results: prices }, stats] = await Promise.all([
      env.DB.prepare(`SELECT u.id, u.name, u.email, u.active, u.last_login, u.password_hash IS NOT NULL AS activated,
        (SELECT COUNT(*) FROM push_subscriptions s WHERE s.user_id = u.id) AS push_devices FROM users u WHERE u.customer_id = ?`).bind(id).all(),
      env.DB.prepare('SELECT product_id, price FROM customer_prices WHERE customer_id = ?').bind(id).all(),
      env.DB.prepare(`SELECT COUNT(*) AS ordini, COALESCE(SUM(subtotal),0) AS imponibile, MAX(created_at) AS ultimo,
        COALESCE(SUM(CASE WHEN paid = 0 AND status = 'consegnato' THEN total END),0) AS da_incassare
        FROM orders WHERE customer_id = ? AND status != 'annullato'`).bind(id).first(),
    ]);
    return json({ customer: c, users, prices, stats });
  }],
  ['POST', '/api/admin/customers', async ({ env, request }) => {
    const b = await readJson(request);
    const f = customerFields(b);
    if (!f.business_name) fail(400, 'Inserisci la ragione sociale.');
    const loginEmail = b.create_login ? String(b.login_email || f.email || '').trim() : '';
    if (b.create_login) {
      if (!isEmail(loginEmail)) fail(400, 'Per creare l\'accesso serve un\'email valida.');
      const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(loginEmail).first();
      if (exists) fail(409, `Esiste già un accesso con ${loginEmail}. Usa un'altra email o togli la spunta "Crea l'accesso".`);
    }
    const r = await env.DB.prepare(`INSERT INTO customers (${Object.keys(f).join(',')}) VALUES (${Object.keys(f).map(() => '?').join(',')}) RETURNING id`)
      .bind(...Object.values(f)).first();
    let invite = null;
    if (loginEmail) {
      const email = loginEmail;
      const u = await env.DB.prepare("INSERT INTO users (email, name, role, customer_id) VALUES (?, ?, 'cliente', ?) RETURNING id, email, name")
        .bind(email, f.contact_name, r.id).first();
      invite = await sendInvite(env, request, u, await getSettings(env));
    }
    return json({ id: r.id, invite });
  }],
  ['PUT', '/api/admin/customers/:id', async ({ env, request, params }) => {
    const f = customerFields(await readJson(request));
    if (!f.business_name) fail(400, 'Inserisci la ragione sociale.');
    await env.DB.prepare(`UPDATE customers SET ${upd(f)} WHERE id = ?`).bind(...Object.values(f), int(params.id)).run();
    return json({ ok: true });
  }],
  ['DELETE', '/api/admin/customers/:id', async ({ env, params }) => {
    const used = await env.DB.prepare('SELECT 1 FROM orders WHERE customer_id = ? LIMIT 1').bind(int(params.id)).first();
    if (used) fail(409, 'Il cliente ha degli ordini: bloccalo invece di eliminarlo, così lo storico resta.');
    await env.DB.prepare('DELETE FROM customers WHERE id = ?').bind(int(params.id)).run();
    return json({ ok: true });
  }],
  ['POST', '/api/admin/customers/:id/users', async ({ env, request, params }) => {
    const b = await readJson(request);
    if (!isEmail(b.email)) fail(400, 'Inserisci un indirizzo email valido.');
    const exists = await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(b.email.trim()).first();
    if (exists) fail(409, 'Esiste già un accesso con questa email.');
    const u = await env.DB.prepare("INSERT INTO users (email, name, role, customer_id) VALUES (?, ?, 'cliente', ?) RETURNING id, email, name")
      .bind(b.email.trim(), str(b.name, 100), int(params.id)).first();
    return json({ invite: await sendInvite(env, request, u, await getSettings(env)) });
  }],
  ['POST', '/api/admin/users/:id/invite', async ({ env, request, params }) => {
    const u = await env.DB.prepare('SELECT id, email, name FROM users WHERE id = ?').bind(int(params.id)).first();
    if (!u) fail(404, 'Utente non trovato.');
    return json({ invite: await sendInvite(env, request, u, await getSettings(env)) });
  }],
  ['PATCH', '/api/admin/users/:id', async ({ env, request, params, user }) => {
    const b = await readJson(request);
    if (int(params.id) === user.id && b.active === false) fail(400, 'Non puoi disattivare il tuo stesso accesso.');
    await env.DB.prepare('UPDATE users SET active = ? WHERE id = ?').bind(b.active ? 1 : 0, int(params.id)).run();
    if (!b.active) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(int(params.id)).run();
    return json({ ok: true });
  }],
  ['DELETE', '/api/admin/users/:id', async ({ env, params, user }) => {
    if (int(params.id) === user.id) fail(400, 'Non puoi eliminare il tuo stesso accesso.');
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(int(params.id)).run();
    return json({ ok: true });
  }],
  ['PUT', '/api/admin/customers/:id/prices', async ({ env, request, params }) => {
    const b = await readJson(request);
    const cid = int(params.id);
    const entries = (b.prices || []).filter(p => p.price !== '' && p.price !== null && p.price !== undefined);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM customer_prices WHERE customer_id = ?').bind(cid),
      ...entries.map(p => env.DB.prepare('INSERT INTO customer_prices (customer_id, product_id, price) VALUES (?, ?, ?)').bind(cid, int(p.product_id), Math.max(0, int(p.price)))),
    ]);
    return json({ ok: true, count: entries.length });
  }],
  ['GET', '/api/admin/customers/:id/catalog', async ({ env, params }) => {
    const c = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(int(params.id)).first();
    if (!c) fail(404, 'Cliente non trovato.');
    const settings = await getSettings(env);
    const zone = await zoneFor(env, c);
    const items = (await adminCatalogFor(env, c)).map(p => ({ id: p.id, name: p.name, pack: p.pack, unit: p.unit, sku: p.sku, price: p.price, vat_rate: p.vat_rate, available: p.available, stock: p.stock }));
    return json({ items, delivery_dates: deliveryOptions(zone, settings, 10) });
  }],

  // ---------- zone ----------
  ['GET', '/api/admin/zones', async ({ env }) => {
    const { results } = await env.DB.prepare(`SELECT z.*, (SELECT COUNT(*) FROM customers c WHERE c.zone_id = z.id) AS customers FROM zones z ORDER BY sort, name`).all();
    return json({ items: results });
  }],
  ['POST', '/api/admin/zones', async ({ env, request }) => saveZone(env, await readJson(request))],
  ['PUT', '/api/admin/zones/:id', async ({ env, request, params }) => saveZone(env, await readJson(request), int(params.id))],
  ['DELETE', '/api/admin/zones/:id', async ({ env, params }) => {
    await env.DB.prepare('DELETE FROM zones WHERE id = ?').bind(int(params.id)).run();
    return json({ ok: true });
  }],

  // ---------- comunicazioni ----------
  ['GET', '/api/admin/announcements', async ({ env }) => {
    const { results } = await env.DB.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 50').all();
    return json({ items: results });
  }],
  ['POST', '/api/admin/announcements', async ({ env, request }) => {
    const b = await readJson(request);
    const title = str(b.title, 120);
    if (!title) fail(400, 'Inserisci un titolo.');
    const r = await env.DB.prepare('INSERT INTO announcements (title, body, kind, starts_on, ends_on, pushed) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(title, str(b.body, 1000), ['info', 'promo', 'avviso'].includes(b.kind) ? b.kind : 'info',
        isIsoDate(b.starts_on) ? b.starts_on : null, isIsoDate(b.ends_on) ? b.ends_on : null, b.push ? 1 : 0).first();
    let work = null;
    if (b.push) {
      const { results } = await env.DB.prepare(`SELECT u.id FROM users u JOIN customers c ON c.id = u.customer_id
        WHERE u.role = 'cliente' AND u.active = 1 AND c.blocked = 0`).all();
      work = notifyUsers(env, results.map(r => r.id), { title, body: str(b.body, 300) || '', url: '/' });
    }
    return { response: json({ id: r.id }), waitUntil: work };
  }],
  ['DELETE', '/api/admin/announcements/:id', async ({ env, params }) => {
    await env.DB.prepare('DELETE FROM announcements WHERE id = ?').bind(int(params.id)).run();
    return json({ ok: true });
  }],

  // ---------- impostazioni & staff ----------
  ['GET', '/api/admin/settings', async ({ env }) => {
    const settings = await getSettings(env);
    return json({
      settings,
      integrations: { email: Boolean(env.RESEND_API_KEY), push: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY), images: Boolean(env.IMAGES), cron: Boolean(env.CRON_SECRET) },
    });
  }],
  ['PUT', '/api/admin/settings', async ({ env, request }) => {
    const b = await readJson(request);
    const stmts = SETTINGS_KEYS.filter(k => k in b).map(k =>
      env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, b[k] === null ? '' : String(b[k]).slice(0, 4000)));
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true });
  }],
];

async function saveZone(env, b, id) {
  const name = str(b.name, 80);
  if (!name) fail(400, 'Inserisci il nome della zona.');
  const days = String(b.delivery_days || '').split(',').map(Number).filter(d => d >= 1 && d <= 7);
  if (!days.length) fail(400, 'Scegli almeno un giorno di consegna.');
  if (!/^\d{2}:\d{2}$/.test(b.cutoff_time || '')) fail(400, 'Orario limite non valido.');
  const vals = [name, [...new Set(days)].sort().join(','), b.cutoff_time, Math.max(0, int(b.lead_days, 1)), Math.max(0, int(b.delivery_fee)), Math.max(0, int(b.free_over)), int(b.sort)];
  if (id) await env.DB.prepare('UPDATE zones SET name = ?, delivery_days = ?, cutoff_time = ?, lead_days = ?, delivery_fee = ?, free_over = ?, sort = ? WHERE id = ?').bind(...vals, id).run();
  else await env.DB.prepare('INSERT INTO zones (name, delivery_days, cutoff_time, lead_days, delivery_fee, free_over, sort) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(...vals).run();
  return json({ ok: true });
}
