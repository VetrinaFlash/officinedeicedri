import {
  html, raw, mount, $, $$, api, euro, qty, dayLong, dayShort, dateTime, capFirst, toast, showError, modal, confirmDialog,
  formData, withBusy, store, router, go, icon, statusPill, STATUS_FLOW, STATUS_LABEL, registerSW, pushState,
  enablePush, disablePush, pushHelp, bell, syncPush, waLink, isIos, isStandalone,
} from './common.js';

const app = $('#app');
const S = { config: null, me: null, boot: null, cart: { items: {}, date: null, notes: '' }, filter: 'all', q: '' };
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });

// ---------- carrello ----------
const cartKey = () => `odc-cart-${S.boot?.customer.id}`;
const saveCart = () => store.set(cartKey(), S.cart);
const productById = id => S.boot.products.find(p => p.id === Number(id));
function cartLines() {
  return Object.entries(S.cart.items)
    .map(([id, q]) => ({ p: productById(id), q }))
    .filter(l => l.p && l.q > 0);
}
function cartTotals() {
  const lines = cartLines();
  let sub = 0; const byRate = {};
  for (const { p, q } of lines) { const lt = Math.round(p.price * q); sub += lt; byRate[p.vat_rate] = (byRate[p.vat_rate] || 0) + lt; }
  const z = S.boot.zone;
  let fee = 0;
  if (z.delivery_fee > 0 && !(z.free_over > 0 && sub >= z.free_over)) fee = z.delivery_fee;
  if (fee) byRate[22] = (byRate[22] || 0) + fee;
  const vat = Object.entries(byRate).reduce((a, [r, b]) => a + Math.round(b * Number(r) / 100), 0);
  return { lines, count: lines.length, sub, fee, vat, total: sub + fee + vat };
}
const round3 = n => Math.round(n * 1000) / 1000;
function stepQty(p, current, dir) {
  const step = p.step_qty || 1, min = p.min_qty || step;
  if (dir > 0) return current <= 0 ? min : round3(current + step);
  const next = round3(current - step);
  return next < min - 1e-9 ? 0 : next;
}
function snapQty(p, value) {
  const v = Number(String(value).replace(',', '.'));
  if (!(v > 0)) return 0;
  const step = p.step_qty || 1, min = p.min_qty || step;
  if (v <= min) return min;
  return round3(min + Math.ceil(round3((v - min) / step) - 1e-9) * step);
}
function setQty(id, q) {
  const p = productById(id);
  if (p && p.stock !== null && q > p.stock) { q = p.stock; toast(`Disponibili ${qty(p.stock)} ${p.unit}`, 'error'); }
  if (q > 0) S.cart.items[id] = q; else delete S.cart.items[id];
  saveCart();
  renderCartbar(true);
}
const selectedDelivery = () => S.boot.delivery_dates.find(d => d.date === S.cart.date) || S.boot.delivery_dates[0] || null;

// ---------- avvio ----------
async function start() {
  registerSW();
  window.addEventListener('auth:expired', () => { S.me = null; if (!location.hash.startsWith('#/accedi')) go('/accedi'); });
  try {
    [S.config, { user: S.me }] = await Promise.all([api('/api/public/config'), api('/api/auth/me')]);
  } catch (e) {
    mount(app, html`<div class="auth"><div class="auth-card"><h1>Impossibile caricare</h1><p class="lead">${e.message}</p><button class="btn primary block" onclick="location.reload()">Riprova</button></div></div>`);
    return;
  }
  const run = router([
    ['/accedi', viewLogin],
    ['/password-dimenticata', viewForgot],
    ['/password/:token', viewSetPassword],
    ['/', guard(viewCatalog)],
    ['/carrello', guard(viewCart)],
    ['/ordini', guard(viewOrders)],
    ['/ordini/:id', guard(viewOrder)],
    ['/account', guard(viewAccount)],
  ], () => go('/'));
  run();
}

function guard(view) {
  return async params => {
    if (!S.me) { go('/accedi'); return; }
    if (S.me.role !== 'cliente') { location.href = '/admin/'; return; }
    if (!S.boot) {
      try { await loadBoot(); } catch (e) { showError(e); return; }
    }
    shell();
    window.scrollTo(0, 0);
    view(params);
  };
}
async function loadBoot() {
  S.boot = await api('/api/shop/bootstrap');
  S.cart = store.get(cartKey(), { items: {}, date: null, notes: '' });
  if (!S.boot.delivery_dates.some(d => d.date === S.cart.date)) S.cart.date = S.boot.delivery_dates[0]?.date || null;
  syncPush();
}

// ---------- shell ----------
let refreshBell = null;
function shell() {
  if ($('#view')) { markTab(); return; }
  const c = S.config;
  mount(app, html`
    <div class="shop">
      <header class="topbar">
        <a class="brand" href="#/">
          ${c.logo_url ? html`<img src="${c.logo_url}" alt="" onerror="this.remove()">` : ''}
          <span>${S.boot.customer.business_name}<small>Ordini ${c.company_name}</small></span>
        </a>
        <button class="icon-btn" id="bell" aria-label="Notifiche">${icon('bell')}</button>
      </header>
      <main class="main" id="view"></main>
    </div>
    <div class="cartbar hidden" id="cartbar"></div>
    <nav class="tabbar" aria-label="Sezioni">
      <a href="#/" data-tab="/">Ordina</a>
      <a href="#/ordini" data-tab="/ordini">I miei ordini</a>
      <a href="#/account" data-tab="/account">Account</a>
    </nav>`);
  refreshBell = bell($('#bell'));
  window.addEventListener('push:received', e => {
    const d = e.detail || {};
    if (d.title) toast(d.title);
    const m = location.hash.match(/^#\/ordini\/(\w+)/);
    if (m) viewOrder({ id: m[1] });
  });
  markTab();
}
function markTab() {
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  const base = path.startsWith('/ordini') ? '/ordini' : path.startsWith('/account') ? '/account' : '/';
  $$('.tabbar a').forEach(a => { if (a.dataset.tab === base) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  renderCartbar();
}

let deadlineTimer;
function deadlineText(opt) {
  if (!opt) return null;
  const [d, t] = opt.deadline.split('T');
  const now = new Date();
  const romeNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
  const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number);
  const mins = Math.round((new Date(y, m - 1, dd, hh, mm) - romeNow) / 60000);
  const when = mins <= 0 ? 'scaduto' : mins < 60 ? `tra ${mins} min` : mins < 24 * 60 ? `tra ${Math.floor(mins / 60)} h ${mins % 60} min` : `entro ${dayShort(d)}, ${t}`;
  return { when, urgent: mins > 0 && mins < 180, expired: mins <= 0, time: t, date: d };
}
function renderCartbar(bump = false) {
  const bar = $('#cartbar');
  if (!bar || !S.boot) return;
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0] || '/';
  const t = cartTotals();
  const show = t.count > 0 && path === '/';
  bar.classList.toggle('hidden', !show);
  document.body.classList.toggle('has-cart', show);
  if (!show) return;
  const opt = selectedDelivery();
  const dl = deadlineText(opt);
  mount(bar, html`
    <div class="cartbar-inner">
      ${opt ? html`<div class="deadline"><span>Consegna ${dayShort(opt.date)}</span><span>Ordina <b>${dl.when}</b></span></div>` : ''}
      <a href="#/carrello">
        <span class="count">${t.count}</span>
        <span class="tot num">${euro(t.sub)}<small>${t.count === 1 ? '1 prodotto' : `${t.count} prodotti`} · IVA esclusa</small></span>
        <span class="go">Rivedi e invia</span>
      </a>
    </div>`);
  if (bump) { bar.classList.remove('bump'); void bar.offsetWidth; bar.classList.add('bump'); }
  clearTimeout(deadlineTimer);
  deadlineTimer = setTimeout(() => renderCartbar(), 60000);
}

// ---------- accesso ----------
function authCard(inner) {
  const c = S.config;
  mount(app, html`
    <div class="auth"><div>
      <div class="auth-card">
        ${c.logo_url ? html`<img class="logo" src="${c.logo_url}" alt="${c.company_name}" onerror="this.remove()">` : html`<p class="lead" style="font:400 1.3rem var(--serif);color:var(--leaf)">${c.company_name}</p>`}
        ${inner}
      </div>
      <p class="auth-contact">Non hai un accesso? Chiamaci al <a href="tel:${c.company_phone}">${c.company_phone}</a> o scrivi a <a href="mailto:${c.company_email}">${c.company_email}</a></p>
    </div></div>`);
}
function viewLogin() {
  if (S.me) { location.href = S.me.role === 'cliente' ? '/#/' : '/admin/'; return; }
  authCard(html`
    <h1>Area riservata</h1>
    <p class="lead">Ordina i prodotti con i tuoi prezzi e segui le consegne.</p>
    <form id="f">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn primary block">Accedi</button>
    </form>
    <p class="auth-foot"><a href="#/password-dimenticata">Password dimenticata?</a></p>`);
  $('#f').onsubmit = e => {
    e.preventDefault();
    withBusy(e.submitter, async () => {
      const r = await api('/api/auth/login', { method: 'POST', body: formData(e.target) });
      if (r.role !== 'cliente') { location.href = '/admin/'; return; }
      S.me = (await api('/api/auth/me')).user; S.boot = null;
      go('/');
    });
  };
}
function viewForgot() {
  authCard(html`
    <h1>Recupera l'accesso</h1>
    <p class="lead">Ti mandiamo un link per scegliere una nuova password.</p>
    <form id="f">
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required></div>
      <button class="btn primary block">Invia il link</button>
    </form>
    <p class="auth-foot"><a href="#/accedi">Torna all'accesso</a></p>`);
  $('#f').onsubmit = e => {
    e.preventDefault();
    withBusy(e.submitter, async () => {
      const r = await api('/api/auth/forgot', { method: 'POST', body: formData(e.target) });
      mount($('.auth-card'), html`<h1>Controlla la posta</h1><p class="lead">${r.email_enabled
        ? 'Se l\'indirizzo è registrato, riceverai a breve un\'email con il link.'
        : `L'invio email non è attivo: chiedi a ${S.config.company_name} un nuovo link di accesso.`}</p>
        <a class="btn block" href="#/accedi">Torna all'accesso</a>`);
    });
  };
}
async function viewSetPassword({ token }) {
  authCard(html`<p class="lead">Verifico il link…</p>`);
  let info;
  try { info = await api(`/api/auth/token?t=${encodeURIComponent(token)}`); }
  catch (e) { authCard(html`<h1>Link non valido</h1><p class="lead">${e.message}</p><a class="btn block" href="#/accedi">Vai all'accesso</a>`); return; }
  authCard(html`
    <h1>${info.purpose === 'invite' ? 'Benvenuto' : 'Nuova password'}</h1>
    <p class="lead">${info.purpose === 'invite' ? 'Scegli la password per il tuo accesso.' : 'Scegli una nuova password.'}<br><b>${info.email}</b></p>
    <form id="f">
      <input type="email" value="${info.email}" autocomplete="username" hidden>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" minlength="8" autocomplete="new-password" required>
      <p class="hint">Almeno 8 caratteri.</p></div>
      <button class="btn primary block">Salva e accedi</button>
    </form>`);
  $('#f').onsubmit = e => {
    e.preventDefault();
    withBusy(e.submitter, async () => {
      const r = await api('/api/auth/set-password', { method: 'POST', body: { token, password: e.target.password.value } });
      if (r.role !== 'cliente') { location.href = '/admin/'; return; }
      S.me = (await api('/api/auth/me')).user; S.boot = null;
      history.replaceState(null, '', '/#/');
      go('/');
    });
  };
}
// ---------- catalogo ----------
function priceLine(p) {
  if (p.promo) return html`${euro(p.price)} <span class="muted" style="font-weight:400">/ ${p.unit}</span>
    <span class="list">invece di <s>${euro(p.regular_price)}</s></span><span class="offer">Offerta fino al ${dayShort(p.promo.ends_on)}</span>`;
  return html`${euro(p.price)} <span class="muted" style="font-weight:400">/ ${p.unit}</span>${p.price < p.list_price ? html`<span class="list">listino ${euro(p.list_price)}</span>` : ''}`;
}
function stepperHtml(p) {
  const q = S.cart.items[p.id] || 0;
  if (!p.available) return html`<span class="tag">Non disponibile</span>`;
  if (!q) return html`<button class="btn small add-btn" data-act="plus" data-id="${p.id}" aria-label="Aggiungi ${p.name}">${icon('plus')} Aggiungi</button>`;
  return html`<div class="stepper has">
    <button data-act="minus" data-id="${p.id}" aria-label="Togli uno">${icon('minus')}</button>
    <input inputmode="decimal" value="${qty(q)}" data-id="${p.id}" aria-label="Quantità ${p.name}">
    <button data-act="plus" data-id="${p.id}" aria-label="Aggiungi uno">${icon('plus')}</button></div>`;
}
function productRow(p) {
  const initial = p.name.replace(/[^A-Za-zÀ-ú]/g, '').charAt(0);
  return html`<li class="prow ${p.available ? '' : 'off'} ${p.promo ? 'is-promo' : ''}" data-row="${p.id}">
    ${p.image ? html`<img class="thumb" src="${p.image}" alt="" loading="lazy">` : html`<div class="thumb" aria-hidden="true">${initial}</div>`}
    <div class="pinfo">
      <div class="pname">${p.name}</div>${p.promo?.title ? html`<div class="pmeta" style="color:var(--leaf)">${p.promo.title}</div>` : ''}
      <div class="pmeta">${[p.pack, p.min_qty > 1 ? `min. ${qty(p.min_qty)}` : null, p.stock !== null && p.stock <= 10 && p.stock > 0 ? `ultimi ${qty(p.stock)}` : null].filter(Boolean).join(' · ')}</div>
      <div class="pprice num">${priceLine(p)}</div>
    </div>
    <div class="pside">
      <button class="icon-btn fav" data-act="fav" data-id="${p.id}" aria-pressed="${p.favorite ? 'true' : 'false'}" aria-label="${p.favorite ? 'Togli dai preferiti' : 'Aggiungi ai preferiti'}">${icon('star')}</button>
      <div data-stepper="${p.id}">${stepperHtml(p)}</div>
    </div>
  </li>`;
}

function viewCatalog() {
  const b = S.boot;
  const view = $('#view');
  const opt = selectedDelivery();
  const promoCount = b.products.filter(p => p.promo && p.available).length;
  if (location.hash.includes('offerte') && promoCount) S.filter = 'promo';
  const chips = [['all', 'Tutto'], ...(promoCount ? [['promo', `Offerte (${promoCount})`]] : []), ['fav', 'Preferiti'], ...(b.usual.length ? [['usual', 'I soliti']] : []), ...b.categories.map(c => [`c${c.id}`, c.name])];
  mount(view, html`
    ${b.announcements.map(a => html`<div class="notice ${a.kind}"><strong>${a.title}</strong>${a.body || ''}</div>`)}
    ${b.customer.blocked ? html`<div class="notice error"><strong>Ordini sospesi</strong>${b.customer.blocked_reason || `Contatta ${S.config.company_name} per riattivare gli ordini.`}</div>` : ''}
    ${!b.orders_open ? html`<div class="notice avviso"><strong>Ordini online in pausa</strong>${b.orders_closed_message || 'Puoi preparare il carrello e inviarlo appena riapriamo.'}</div>` : ''}
    ${opt ? html`<button class="delivery" id="pickdate">${icon('truck')}
        <span><span class="sub">Consegna</span><span class="when" style="display:block">${capFirst(dayLong(opt.date))}</span>
        <span class="sub">${b.zone.name} · ordina entro ${dayShort(opt.deadline_date)} alle ${opt.cutoff}</span></span>
        <span class="change">Cambia</span></button>`
      : html`<div class="notice avviso"><strong>Nessuna data di consegna disponibile</strong>Contatta ${S.config.company_name} per concordare la consegna.</div>`}
    ${b.last_order_id && !cartLines().length ? html`<p><a class="btn small" href="#/ordini/${b.last_order_id}">Ripeti l'ultimo ordine</a></p>` : ''}
    <div class="searchbar">${icon('search')}<input type="search" id="q" placeholder="Cerca un prodotto" value="${S.q}" aria-label="Cerca un prodotto"></div>
    <div class="chips" role="toolbar" aria-label="Filtra">${chips.map(([k, l]) => html`<button class="chip ${k === 'promo' ? 'promo-chip' : ''}" data-filter="${k}" aria-pressed="${S.filter === k}">${l}</button>`)}</div>
    <div id="plist"></div>`);
  renderProducts();
  $('#q').oninput = e => { S.q = e.target.value; renderProducts(); };
  $('#pickdate')?.addEventListener('click', pickDate);
  view.onclick = e => {
    const chip = e.target.closest('[data-filter]');
    if (chip) {
      S.filter = chip.dataset.filter;
      $$('.chip').forEach(c => c.setAttribute('aria-pressed', c === chip));
      renderProducts();
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id), p = productById(id);
    if (btn.dataset.act === 'fav') {
      api(`/api/shop/favorites/${id}`, { method: 'POST' }).then(r => { p.favorite = r.favorite ? 1 : 0; btn.setAttribute('aria-pressed', r.favorite); if (S.filter === 'fav') renderProducts(); }).catch(showError);
      return;
    }
    setQty(id, stepQty(p, S.cart.items[id] || 0, btn.dataset.act === 'plus' ? 1 : -1));
    refreshStepper(id, btn.dataset.act);
  };
  view.onchange = e => {
    if (e.target.matches('.stepper input')) {
      const id = Number(e.target.dataset.id), p = productById(id);
      const v = snapQty(p, e.target.value);
      setQty(id, v);
      refreshStepper(id);
    }
  };
}
function refreshStepper(id, focusAct) {
  const holder = $(`[data-stepper="${id}"]`);
  if (!holder) return;
  mount(holder, stepperHtml(productById(id)));
  const target = holder.querySelector(`[data-act="${focusAct}"]`) || holder.querySelector('[data-act="plus"]');
  target?.focus({ preventScroll: true });
}
function renderProducts() {
  const b = S.boot;
  const q = S.q.trim().toLowerCase();
  let list = b.products;
  if (q) list = list.filter(p => `${p.name} ${p.pack || ''} ${p.sku || ''} ${p.description || ''}`.toLowerCase().includes(q));
  const holder = $('#plist');
  if (S.filter === 'fav') list = list.filter(p => p.favorite);
  if (S.filter === 'promo') list = list.filter(p => p.promo);
  if (S.filter === 'usual') {
    const order = new Map(b.usual.map((u, i) => [u.product_id, i]));
    list = list.filter(p => order.has(p.id)).sort((a, z) => order.get(a.id) - order.get(z.id));
  }
  if (S.filter.startsWith('c')) list = list.filter(p => `c${p.category_id}` === S.filter);
  if (!list.length) {
    mount(holder, html`<div class="empty">${S.filter === 'fav' && !q
      ? html`<h3>Nessun preferito</h3><p>Tocca la stella accanto a un prodotto per ritrovarlo qui.</p>`
      : html`<h3>Nessun prodotto trovato</h3><p>Prova con un'altra parola o mostra tutto il catalogo.</p>`}</div>`);
    return;
  }
  if (S.filter === 'all' && !q) {
    const groups = [...b.categories, { id: null, name: 'Altri prodotti' }]
      .map(c => ({ c, items: list.filter(p => (p.category_id ?? null) === c.id || (c.id === null && !b.categories.some(x => x.id === p.category_id))) }))
      .filter(g => g.items.length);
    const offers = list.filter(p => p.promo && p.available);
    const featured = list.filter(p => p.featured && p.available && !p.promo);
    mount(holder, html`
      ${offers.length ? html`<h2 class="cat-title">In offerta</h2><ul class="plist">${offers.map(productRow)}</ul>` : ''}
      ${featured.length ? html`<h2 class="cat-title">In evidenza</h2><ul class="plist">${featured.map(productRow)}</ul>` : ''}
      ${groups.map(g => html`<h2 class="cat-title">${g.c.name}</h2><ul class="plist">${g.items.map(productRow)}</ul>`)}`);
  } else {
    mount(holder, html`<ul class="plist" style="margin-top:.5rem">${list.map(productRow)}</ul>`);
  }
}

function dateOptionsHtml(limit = 12) {
  const shortDay = iso => new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z'));
  let list = S.boot.delivery_dates.slice(0, limit);
  if (S.cart.date && !list.some(d => d.date === S.cart.date)) list = list.concat(S.boot.delivery_dates.filter(d => d.date === S.cart.date));
  return html`<div class="dates" role="radiogroup" aria-label="Data di consegna">${list.map(d => html`
    <label class="date-opt"><input type="radio" name="date" value="${d.date}" ${d.date === S.cart.date ? raw('checked') : ''}>
    <span><b>${dayShort(d.date)}</b><small>entro ${shortDay(d.deadline_date)}, ${d.cutoff}</small></span></label>`)}</div>`;
}
function pickDate() {
  const m = modal(html`<h2>Quando ti serve?</h2>
    <p class="muted small">Le date dipendono dai giri di consegna della tua zona (${S.boot.zone.name}).</p>
    ${dateOptionsHtml()}
    <div class="modal-actions"><button class="btn ghost" data-close>Chiudi</button></div>`);
  m.el.onchange = e => { S.cart.date = e.target.value; saveCart(); m.close(); viewCatalog(); renderCartbar(); };
}

// ---------- carrello ----------
function viewCart() {
  const view = $('#view');
  const t = cartTotals();
  const b = S.boot;
  if (!t.count) {
    mount(view, html`<div class="empty"><h3>Il carrello è vuoto</h3><p>Aggiungi i prodotti dal catalogo o ripeti un ordine precedente.</p>
      <a class="btn primary" href="#/">Vai al catalogo</a></div>`);
    return;
  }
  const min = b.customer.min_order || 0;
  const underMin = min > 0 && t.sub < min;
  const z = b.zone;
  mount(view, html`
    <a class="back" href="#/">‹ Continua a ordinare</a>
    <h1>Il tuo ordine</h1>
    <section class="sheet">
      ${t.lines.map(({ p, q }) => html`<div class="cart-line">
        <div><div class="pname">${p.name}</div><div class="pmeta">${[p.pack, `${euro(p.price)} / ${p.unit}`].filter(Boolean).join(' · ')}</div>${p.promo ? html`<span class="offer">Offerta</span>` : ''}</div>
        <div data-stepper="${p.id}">${stepperHtml(p)}</div>
        <div class="muted small">${!p.available ? 'Non più disponibile: rimuovilo' : ''}</div>
        <div class="lt num">${euro(Math.round(p.price * q))}</div></div>`)}
    </section>
    <section class="sheet">
      <h2>Consegna</h2>
      ${b.delivery_dates.length ? dateOptionsHtml(6) : html`<p class="muted">Nessuna data disponibile per la tua zona: contatta ${S.config.company_name}.</p>`}
      <p class="small muted" style="margin:.75rem 0 0">${b.customer.delivery_address ? html`Indirizzo: ${b.customer.delivery_address}` : ''}</p>
    </section>
    <section class="sheet">
      <div class="field" style="margin:0"><label for="notes">Note per il fornitore</label>
      <textarea id="notes" placeholder="Es. consegnare dopo le 10, sostituzioni gradite…">${S.cart.notes || ''}</textarea></div>
    </section>
    <section class="sheet">
      <table class="totals">
        <tr><td>Imponibile</td><td class="num">${euro(t.sub)}</td></tr>
        ${t.fee || z.delivery_fee ? html`<tr><td>Consegna${z.free_over && !t.fee ? ' (gratuita)' : ''}</td><td class="num">${euro(t.fee)}</td></tr>` : ''}
        <tr><td>IVA</td><td class="num">${euro(t.vat)}</td></tr>
        <tr class="grand"><td>Totale</td><td class="num">${euro(t.total)}</td></tr>
      </table>
      ${z.delivery_fee && z.free_over && t.fee ? html`<p class="small muted" style="margin:.5rem 0 0">Consegna gratuita da ${euro(z.free_over)} di imponibile: mancano ${euro(z.free_over - t.sub)}.</p>` : ''}
      ${underMin ? html`<p class="notice error" style="margin:.75rem 0 0"><strong>Ordine minimo ${euro(min)}</strong>Aggiungi ancora ${euro(min - t.sub)} IVA esclusa.</p>` : ''}
      ${b.customer.payment_terms ? html`<p class="small muted" style="margin:.75rem 0 0">Pagamento: ${b.customer.payment_terms}</p>` : ''}
      <button class="btn primary block" id="send" style="margin-top:1rem" ${underMin || !b.delivery_dates.length || b.customer.blocked || !b.orders_open ? raw('disabled') : ''}>Invia l'ordine · ${euro(t.total)}</button>
      ${b.order_terms ? html`<p class="small muted" style="margin:.75rem 0 0">${b.order_terms}</p>` : ''}
      <button class="btn ghost small" id="empty" style="margin-top:.5rem">Svuota il carrello</button>
    </section>`);
  $('#notes').oninput = e => { S.cart.notes = e.target.value; saveCart(); };
  view.onchange = e => {
    if (e.target.name === 'date') { S.cart.date = e.target.value; saveCart(); }
    if (e.target.matches('.stepper input')) { const p = productById(e.target.dataset.id); setQty(p.id, snapQty(p, e.target.value)); viewCart(); }
  };
  view.onclick = async e => {
    const btn = e.target.closest('[data-act]');
    if (btn) { const p = productById(btn.dataset.id); setQty(p.id, stepQty(p, S.cart.items[p.id] || 0, btn.dataset.act === 'plus' ? 1 : -1)); viewCart(); return; }
    if (e.target.id === 'empty') {
      if (await confirmDialog({ title: 'Svuotare il carrello?', confirm: 'Svuota', danger: true })) { S.cart.items = {}; S.cart.notes = ''; saveCart(); go('/'); }
    }
    if (e.target.closest('#send')) sendOrder(e.target.closest('#send'));
  };
}
function sendOrder(btn) {
  withBusy(btn, async () => {
    const items = cartLines().map(({ p, q }) => ({ product_id: p.id, qty: q }));
    try {
      const { order } = await api('/api/shop/orders', { method: 'POST', body: { items, delivery_date: S.cart.date, notes: S.cart.notes } });
      S.cart = { items: {}, date: S.cart.date, notes: '' };
      saveCart();
      S.boot = null; await loadBoot();
      go(`/ordini/${order.id}?nuovo`);
      setTimeout(() => offerPushAfterOrder(), 600);
    } catch (e) {
      if (e.status === 400 || e.status === 409) { S.boot = null; await loadBoot().catch(() => {}); }
      throw e;
    }
  });
}
async function offerPushAfterOrder() {
  const st = await pushState(S.config.vapid_public_key).catch(() => 'unsupported');
  if (st !== 'off' && st !== 'ios-install') return;
  const m = modal(html`<h2>Vuoi sapere quando arriva?</h2>
    <p class="muted">${st === 'ios-install' ? pushHelp(st) : 'Attiva le notifiche: ti avvisiamo quando l\'ordine è confermato e quando parte per la consegna.'}</p>
    <div class="modal-actions"><button class="btn ghost" data-close>Non ora</button>${st === 'off' ? html`<button class="btn primary" id="on">Attiva notifiche</button>` : ''}</div>`);
  m.el.querySelector('#on')?.addEventListener('click', e => withBusy(e.target, async () => { await enablePush(S.config.vapid_public_key); toast('Notifiche attivate'); m.close(); }));
}

// ---------- ordini ----------
async function viewOrders() {
  const view = $('#view');
  mount(view, html`<h1>I miei ordini</h1><div class="loading">Caricamento…</div>`);
  try {
    const { items } = await api('/api/shop/orders');
    mount(view, html`<h1>I miei ordini</h1>
      ${items.length ? html`<ul class="olist">${items.map(o => html`<li><a href="#/ordini/${o.id}">
          <span class="on">Ordine ${o.number}</span>${statusPill(o.status)}
          <span class="muted small">Consegna ${dayShort(o.delivery_date)} · ${o.lines} ${o.lines === 1 ? 'prodotto' : 'prodotti'}</span>
          <span class="num right">${euro(o.total)}</span></a></li>`)}</ul>`
        : html`<div class="empty"><h3>Nessun ordine ancora</h3><p>Il primo ordine che invii comparirà qui, con lo stato della consegna.</p><a class="btn primary" href="#/">Vai al catalogo</a></div>`}`);
  } catch (e) { showError(e); }
}
async function viewOrder({ id }) {
  const view = $('#view');
  const isNew = location.hash.includes('?nuovo');
  id = id.split('?')[0];
  let order;
  try { ({ order } = await api(`/api/shop/orders/${id}`)); } catch (e) { mount(view, html`<div class="empty"><h3>${e.message}</h3><a href="#/ordini">Torna agli ordini</a></div>`); return; }
  const idx = STATUS_FLOW.indexOf(order.status);
  const c = S.config;
  mount(view, html`
    <a class="back" href="#/ordini">‹ I miei ordini</a>
    ${isNew ? html`<div class="notice promo"><strong>Ordine inviato</strong>${c.company_name} lo ha ricevuto. Ti avvisiamo appena viene confermato.</div>` : ''}
    <h1>Ordine ${order.number}</h1>
    <section class="sheet">
      ${order.status === 'annullato' ? html`<p>${statusPill('annullato')}</p>` : html`<ol class="timeline" aria-label="Stato: ${STATUS_LABEL[order.status]}">${STATUS_FLOW.map((s, i) => html`<li class="${i <= idx ? 'done' : ''}">${{ nuovo: 'Ricevuto', confermato: 'Confermato', in_preparazione: 'Preparato', in_consegna: 'In viaggio', consegnato: 'Consegnato' }[s]}</li>`)}</ol>`}
      <dl class="kv" style="margin-top:1rem">
        <dt>Consegna</dt><dd>${capFirst(dayLong(order.delivery_date))}</dd>
        <dt>Inviato</dt><dd>${dateTime(order.created_at)}</dd>
        ${order.notes ? html`<dt>Note</dt><dd>${order.notes}</dd>` : ''}
      </dl>
    </section>
    ${order.events.filter(e => e.note && e.status !== 'nuovo').length ? html`<section class="sheet"><h2>Aggiornamenti</h2><ul class="events">${order.events.filter(e => e.note && e.status !== 'nuovo').map(e => html`<li><time>${dateTime(e.created_at)}</time>${e.note}</li>`)}</ul></section>` : ''}
    <section class="sheet">
      <table class="items"><thead><tr><th>Prodotto</th><th class="num">Q.tà</th><th class="num">Totale</th></tr></thead>
      <tbody>${order.items.map(i => html`<tr><td>${i.name}${i.promo_id ? html` <span class="offer">Offerta</span>` : ''}<div class="muted small">${[i.pack, `${euro(i.price)} / ${i.unit}`].filter(Boolean).join(' · ')}</div></td><td class="num">${qty(i.qty)}</td><td class="num">${euro(i.line_total)}</td></tr>`)}</tbody></table>
      <table class="totals" style="margin-top:.75rem">
        <tr><td>Imponibile</td><td class="num">${euro(order.subtotal)}</td></tr>
        ${order.delivery_fee ? html`<tr><td>Consegna</td><td class="num">${euro(order.delivery_fee)}</td></tr>` : ''}
        <tr><td>IVA</td><td class="num">${euro(order.vat_total)}</td></tr>
        <tr class="grand"><td>Totale</td><td class="num">${euro(order.total)}</td></tr>
      </table>
    </section>
    <div class="actions">
      <button class="btn primary" id="reorder">Ordina di nuovo questi prodotti</button>
      ${order.status === 'nuovo' ? html`<button class="btn" id="cancel">Annulla l'ordine</button>` : ''}
      <a class="btn ghost" href="${waLink(c.company_phone, `Ciao, vi scrivo per l'ordine ${order.number} di ${S.boot.customer.business_name}.`)}" target="_blank" rel="noopener">${icon('wa')} Scrivici</a>
    </div>
    ${order.status !== 'nuovo' && order.status !== 'annullato' && order.status !== 'consegnato' ? html`<p class="small muted" style="margin-top:1rem">L'ordine è già in lavorazione: per modifiche chiama il ${c.company_phone}.</p>` : ''}`);
  $('#reorder').onclick = () => {
    let missing = 0;
    for (const i of order.items) {
      const p = i.product_id && productById(i.product_id);
      if (!p || !p.available) { missing++; continue; }
      S.cart.items[p.id] = snapQty(p, i.qty);
    }
    saveCart();
    if (missing) toast(`${missing} ${missing === 1 ? 'prodotto non è disponibile' : 'prodotti non sono disponibili'}`, 'error');
    go('/carrello');
  };
  $('#cancel')?.addEventListener('click', async e => {
    if (!(await confirmDialog({ title: `Annullare l'ordine ${order.number}?`, text: 'Il fornitore riceverà subito l\'avviso.', confirm: 'Annulla ordine', danger: true }))) return;
    withBusy(e.target, async () => { await api(`/api/shop/orders/${order.id}/cancel`, { method: 'POST' }); toast('Ordine annullato'); viewOrder({ id: order.id }); });
  });
}

// ---------- account ----------
async function viewAccount() {
  const view = $('#view');
  const [{ customer, users, supplier, agent }, pst] = await Promise.all([
    api('/api/shop/account'),
    pushState(S.config.vapid_public_key).catch(() => 'unsupported'),
  ]);
  const showInstall = !isStandalone() && (installPrompt || isIos());
  mount(view, html`
    <h1>Account</h1>
    <section class="sheet">
      <h2>Notifiche</h2>
      ${pst === 'on' ? html`<p>Le notifiche sono attive su questo dispositivo.</p><div class="actions"><button class="btn small" id="ptest">Invia una prova</button><button class="btn small ghost" id="poff">Disattiva</button></div>`
        : pst === 'off' ? html`<p class="muted">Ricevi un avviso quando l'ordine è confermato, quando parte e per le promozioni.</p><button class="btn primary" id="pon">Attiva le notifiche</button>`
        : html`<p class="muted">${pushHelp(pst)}</p>`}
    </section>
    ${showInstall ? html`<section class="install-tip"><strong>Aggiungi l'app alla schermata Home</strong><br>
      ${installPrompt ? html`Ordini più veloci, senza aprire il browser. <button class="btn small primary" id="install" style="margin-top:.5rem">Installa</button>`
        : 'Su iPhone: tocca Condividi, poi "Aggiungi alla schermata Home".'}</section>` : ''}
    <section class="sheet">
      <h2>${customer.business_name}</h2>
      <dl class="kv">
        ${customer.vat ? html`<dt>P.IVA</dt><dd>${customer.vat}</dd>` : ''}
        <dt>Indirizzo</dt><dd>${[customer.address, customer.zip, customer.city, customer.province].filter(Boolean).join(', ') || '—'}</dd>
        ${customer.delivery_address ? html`<dt>Consegna</dt><dd>${customer.delivery_address}</dd>` : ''}
        ${customer.payment_terms ? html`<dt>Pagamento</dt><dd>${customer.payment_terms}</dd>` : ''}
        <dt>Accessi</dt><dd>${users.map(u => u.name || u.email).join(', ')}</dd>
      </dl>
      <form id="contact" style="margin-top:1rem">
        <div class="field-row">
          <div class="field"><label for="cn">Referente</label><input id="cn" name="contact_name" value="${customer.contact_name || ''}"></div>
          <div class="field"><label for="ph">Telefono</label><input id="ph" name="phone" type="tel" value="${customer.phone || ''}"></div>
        </div>
        <div class="field"><label for="dn">Indicazioni per la consegna</label><textarea id="dn" name="delivery_notes" placeholder="Es. ingresso dal retro, orari di apertura…">${customer.delivery_notes || ''}</textarea></div>
        <button class="btn">Salva</button>
      </form>
      <p class="hint">Per cambiare ragione sociale o dati di fatturazione contatta ${supplier.name}.</p>
    </section>
    <section class="sheet">
      <h2>Password</h2>
      <form id="pw">
        <input type="email" value="${S.me.email}" autocomplete="username" hidden>
        <div class="field-row">
          <div class="field"><label for="old">Password attuale</label><input id="old" name="old" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="np">Nuova password</label><input id="np" name="password" type="password" minlength="8" autocomplete="new-password" required></div>
        </div>
        <button class="btn">Cambia password</button>
      </form>
    </section>
    ${agent ? html`<section class="sheet">
      <h2>Il tuo agente</h2>
      <p style="margin-bottom:.75rem"><strong>${agent.name}</strong></p>
      <div class="actions">
        ${agent.phone ? html`<a class="btn" href="tel:${agent.phone}">${icon('phone')} Chiama</a><a class="btn" href="${waLink(agent.phone)}" target="_blank" rel="noopener">${icon('wa')} WhatsApp</a>` : ''}
        ${agent.email ? html`<a class="btn" href="mailto:${agent.email}">Email</a>` : ''}
      </div>
    </section>` : ''}
    <section class="sheet">
      <h2>${supplier.name}</h2>
      <p class="muted small">${supplier.address}</p>
      <div class="actions">
        <a class="btn" href="tel:${supplier.phone}">${icon('phone')} Chiama</a>
        <a class="btn" href="${waLink(supplier.phone)}" target="_blank" rel="noopener">${icon('wa')} WhatsApp</a>
        <a class="btn" href="mailto:${supplier.email}">Email</a>
      </div>
    </section>
    <button class="btn ghost" id="logout">Esci da ${S.me.email}</button>`);
  $('#pon')?.addEventListener('click', e => withBusy(e.target, async () => { await enablePush(S.config.vapid_public_key); toast('Notifiche attivate'); viewAccount(); }));
  $('#poff')?.addEventListener('click', e => withBusy(e.target, async () => { await disablePush(); toast('Notifiche disattivate'); viewAccount(); }));
  $('#ptest')?.addEventListener('click', e => withBusy(e.target, async () => { await api('/api/push/test', { method: 'POST' }); toast('Notifica di prova inviata'); refreshBell?.(); }));
  $('#install')?.addEventListener('click', async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; viewAccount(); });
  $('#contact').onsubmit = e => { e.preventDefault(); withBusy(e.submitter, async () => { await api('/api/shop/account', { method: 'PUT', body: formData(e.target) }); toast('Dati salvati'); }); };
  $('#pw').onsubmit = e => { e.preventDefault(); withBusy(e.submitter, async () => { await api('/api/auth/change-password', { method: 'POST', body: formData(e.target) }); e.target.reset(); toast('Password cambiata'); }); };
  $('#logout').onclick = async () => {
    await disablePush().catch(() => {});
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/#/accedi'; location.reload();
  };
}

start();
