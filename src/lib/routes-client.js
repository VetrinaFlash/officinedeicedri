import { json, readJson, fail, str, nowRome } from './util.js';
import {
  getSettings, catalogFor, zoneFor, deliveryOptions, createOrder, getOrder, notifyNewOrder,
  notifyUsers, adminIds, orderNumber,
} from './core.js';

async function loadCustomer(env, user) {
  const c = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(user.customer_id).first();
  if (!c) fail(403, 'Account cliente non trovato.');
  return c;
}

export const clientRoutes = [
  ['GET', '/api/shop/bootstrap', async ({ env, user }) => {
    const customer = await loadCustomer(env, user);
    const settings = await getSettings(env);
    const zone = await zoneFor(env, customer);
    const today = nowRome().date;
    const [products, { results: categories }, { results: announcements }, last] = await Promise.all([
      catalogFor(env, customer),
      env.DB.prepare('SELECT id, name FROM categories ORDER BY sort, name').all(),
      env.DB.prepare(`SELECT id, title, body, kind FROM announcements
        WHERE (starts_on IS NULL OR starts_on <= ?1) AND (ends_on IS NULL OR ends_on >= ?1)
          AND (target = 'tutti' OR (target = 'zona' AND zone_id = ?2) OR (target = 'agente' AND agent_id = ?3) OR (target = 'cliente' AND customer_id = ?4))
        ORDER BY id DESC LIMIT 5`).bind(today, customer.zone_id ?? -1, customer.agent_id ?? -1, customer.id).all(),
      env.DB.prepare(`SELECT id FROM orders WHERE customer_id = ? AND status != 'annullato' ORDER BY created_at DESC LIMIT 1`).bind(customer.id).first(),
    ]);
    // prodotti ordinati più spesso dal cliente (per "I tuoi soliti")
    const { results: usual } = await env.DB.prepare(`
      SELECT i.product_id, COUNT(*) AS times, ROUND(AVG(i.qty), 2) AS avg_qty FROM order_items i
      JOIN orders o ON o.id = i.order_id
      WHERE o.customer_id = ? AND o.status != 'annullato' AND i.product_id IS NOT NULL
      GROUP BY i.product_id ORDER BY times DESC LIMIT 12`).bind(customer.id).all();
    return json({
      customer: {
        id: customer.id, business_name: customer.business_name, contact_name: customer.contact_name,
        delivery_address: customer.delivery_address || [customer.address, customer.zip, customer.city].filter(Boolean).join(', '),
        blocked: customer.blocked, blocked_reason: customer.blocked_reason, payment_terms: customer.payment_terms,
        min_order: customer.min_order ?? Number(settings.min_order || 0),
      },
      zone: { name: zone.name, delivery_fee: zone.delivery_fee, free_over: zone.free_over, cutoff_time: zone.cutoff_time },
      delivery_dates: deliveryOptions(zone, settings, 12),
      orders_open: settings.orders_open !== '0',
      orders_closed_message: settings.orders_closed_message,
      order_terms: settings.order_terms,
      categories, products, announcements, usual,
      last_order_id: last?.id || null,
    });
  }],

  ['POST', '/api/shop/favorites/:id', async ({ env, user, params }) => {
    const pid = Number(params.id);
    const exists = await env.DB.prepare('SELECT 1 FROM favorites WHERE customer_id = ? AND product_id = ?').bind(user.customer_id, pid).first();
    if (exists) await env.DB.prepare('DELETE FROM favorites WHERE customer_id = ? AND product_id = ?').bind(user.customer_id, pid).run();
    else await env.DB.prepare('INSERT INTO favorites (customer_id, product_id) VALUES (?, ?)').bind(user.customer_id, pid).run();
    return json({ favorite: !exists });
  }],

  ['POST', '/api/shop/orders', async ({ env, request, user }) => {
    const b = await readJson(request);
    const customer = await loadCustomer(env, user);
    const order = await createOrder(env, {
      customer, by: user, items: b.items, delivery_date: b.delivery_date, notes: str(b.notes, 1000), source: 'app',
    });
    const settings = await getSettings(env);
    const work = notifyNewOrder(env, request, order, settings, user);
    return { response: json({ order }), waitUntil: work };
  }],

  ['GET', '/api/shop/orders', async ({ env, user, url }) => {
    const page = Math.max(0, Number(url.searchParams.get('page') || 0));
    const { results } = await env.DB.prepare(`
      SELECT o.id, o.year, o.seq, o.status, o.delivery_date, o.total, o.created_at,
        (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS lines
      FROM orders o WHERE o.customer_id = ? ORDER BY o.created_at DESC LIMIT 30 OFFSET ?`).bind(user.customer_id, page * 30).all();
    return json({ items: results.map(o => ({ ...o, number: orderNumber(o) })) });
  }],

  ['GET', '/api/shop/orders/:id', async ({ env, user, params }) => {
    const order = await getOrder(env, params.id);
    if (!order || order.customer_id !== user.customer_id) fail(404, 'Ordine non trovato.');
    delete order.admin_notes;
    order.events = order.events.filter(e => e.type === 'status').map(({ status, created_at, note }) => ({ status, created_at, note }));
    return json({ order });
  }],

  ['POST', '/api/shop/orders/:id/cancel', async ({ env, user, params }) => {
    const order = await getOrder(env, params.id);
    if (!order || order.customer_id !== user.customer_id) fail(404, 'Ordine non trovato.');
    if (order.status !== 'nuovo') fail(409, 'L\'ordine è già stato preso in carico: per modificarlo contatta il fornitore.');
    await env.DB.batch([
      env.DB.prepare("UPDATE orders SET status = 'annullato', updated_at = datetime('now') WHERE id = ?").bind(order.id),
      env.DB.prepare("INSERT INTO order_events (order_id, type, status, note, user_id) VALUES (?, 'status', 'annullato', 'Annullato dal cliente', ?)").bind(order.id, user.id),
      ...order.items.filter(i => i.product_id).map(i =>
        env.DB.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL').bind(i.qty, i.product_id)),
    ]);
    const work = notifyUsers(env, [...await adminIds(env), order.customer_agent_id].filter(Boolean), {
      title: `Ordine annullato da ${order.business_name}`, body: `${order.number} è stato annullato dal cliente.`, url: `/admin/#/ordini/${order.id}`,
    });
    return { response: json({ ok: true }), waitUntil: work };
  }],

  ['GET', '/api/shop/account', async ({ env, user }) => {
    const c = await loadCustomer(env, user);
    const { results: users } = await env.DB.prepare('SELECT id, name, email FROM users WHERE customer_id = ? AND active = 1').bind(c.id).all();
    const s = await getSettings(env);
    const agent = c.agent_id ? await env.DB.prepare("SELECT name, phone, email FROM users WHERE id = ? AND active = 1").bind(c.agent_id).first() : null;
    return json({
      agent,
      customer: {
        business_name: c.business_name, vat: c.vat, tax_code: c.tax_code, sdi: c.sdi, pec: c.pec, contact_name: c.contact_name,
        phone: c.phone, email: c.email, address: c.address, city: c.city, province: c.province, zip: c.zip,
        delivery_address: c.delivery_address, delivery_notes: c.delivery_notes, payment_terms: c.payment_terms,
      },
      users,
      supplier: { name: s.company_name, phone: s.company_phone, email: s.company_email, address: s.company_address },
    });
  }],

  ['PUT', '/api/shop/account', async ({ env, request, user }) => {
    const b = await readJson(request);
    await env.DB.prepare('UPDATE customers SET contact_name = ?, phone = ?, delivery_notes = ? WHERE id = ?')
      .bind(str(b.contact_name, 100), str(b.phone, 40), str(b.delivery_notes, 500), user.customer_id).run();
    return json({ ok: true });
  }],
];
