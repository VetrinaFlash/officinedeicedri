import {
  html, raw, mount, $, $$, api, euro, toCents, centsToInput, qty, dayLong, dayShort, dateTime, capFirst, relDays, todayIso, addDays,
  toast, showError, modal, confirmDialog, formData, withBusy, router, go, icon, statusPill, STATUS_LABEL, STATUS_FLOW,
  registerSW, pushState, enablePush, disablePush, pushHelp, bell, syncPush, waLink, debounce,
} from './common.js';

const app = $('#app');
const S = { me: null, config: null, zones: null, categories: null };
const DAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
const SOURCES = { app: 'App', telefono: 'Telefono', whatsapp: 'WhatsApp', email: 'Email', agente: 'Agente' };

const NAV = [
  ['/', 'Panoramica'],
  ['/ordini', 'Ordini', 'nuovi'],
  ['/preparazione', 'Preparazione e consegne'],
  ['/nuovo-ordine', 'Inserisci ordine'],
  null,
  ['/prodotti', 'Prodotti'],
  ['/clienti', 'Clienti'],
  ['/zone', 'Zone e consegne'],
  ['/comunicazioni', 'Comunicazioni'],
  null,
  ['/impostazioni', 'Impostazioni'],
];

async function start() {
  registerSW();
  window.addEventListener('auth:expired', () => location.reload());
  try {
    const [{ user }, config] = await Promise.all([api('/api/auth/me'), api('/api/public/config')]);
    S.config = config;
    if (!user || user.role !== 'admin') { adminLogin(); return; }
    S.me = user;
  } catch (e) { mount(app, html`<div class="loading">${e.message}</div>`); return; }
  shell();
  syncPush();
  const run = router([
    ['/', viewDashboard],
    ['/ordini', viewOrders],
    ['/ordini/:id', viewOrder],
    ['/preparazione', viewPicking],
    ['/nuovo-ordine', viewNewOrder],
    ['/prodotti', viewProducts],
    ['/clienti', viewCustomers],
    ['/clienti/:id', viewCustomer],
    ['/zone', viewZones],
    ['/comunicazioni', viewAnnouncements],
    ['/impostazioni', viewSettings],
  ], () => go('/'));
  const wrapped = () => { $$('.modal-wrap').forEach(m => m.remove()); markNav(); $('.side').classList.remove('open'); window.scrollTo(0, 0); run(); };
  window.removeEventListener('hashchange', run);
  window.addEventListener('hashchange', wrapped);
  wrapped();
}

// ---------- accesso pannello ----------
function adminLogin() {
  const c = S.config;
  mount(app, html`<div class="auth"><div class="auth-card">
    ${c.logo_url ? html`<img class="logo" src="${c.logo_url}" alt="${c.company_name}" onerror="this.remove()">` : ''}
    <h1>Gestionale</h1>
    <p class="lead">${c.company_name}</p>
    <form id="f">
      <input type="text" name="username" value="pannello" autocomplete="username" hidden>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus></div>
      <button class="btn primary block">Entra</button>
    </form></div></div>`);
  $('#f').onsubmit = e => {
    e.preventDefault();
    withBusy(e.submitter, async () => {
      await api('/api/auth/admin', { method: 'POST', body: { password: e.target.password.value } });
      location.reload();
    });
  };
}

// ---------- shell ----------
function shell() {
  const c = S.config;
  mount(app, html`
    <div class="admin">
      <aside class="side" id="side">
        <a class="brand" href="#/">${c.logo_url ? html`<img src="${c.logo_url}" alt="" onerror="this.remove()">` : ''}<span>${c.company_name}<small>Gestionale ordini</small></span></a>
        <nav aria-label="Menu">${NAV.map(n => n ? html`<a href="#${n[0]}" data-nav="${n[0]}">${n[1]}${n[2] ? html`<span class="count hidden" data-count="${n[2]}"></span>` : ''}</a>` : raw('<div class="sep"></div>'))}</nav>
        <div class="foot">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem">
            <span>Amministratore</span>
            <button class="icon-btn" id="bell" aria-label="Notifiche" style="color:#fff">${icon('bell')}</button>
          </div>
          <a href="/" target="_blank" style="color:var(--citron)">Vedi l'app clienti</a> ·
          <button id="logout">Esci</button>
        </div>
      </aside>
      <div class="content">
        <div class="mobilebar"><button class="icon-btn" id="menu" aria-label="Apri menu">${icon('menu')}</button><span>${c.company_name}</span></div>
        <div id="pushbanner"></div>
        <div id="view"></div>
      </div>
    </div>`);
  $('#menu').onclick = () => $('.side').classList.toggle('open');
  $('#logout').onclick = async () => { await disablePush().catch(() => {}); await api('/api/auth/logout', { method: 'POST' }); location.reload(); };
  bell($('#bell'));
  window.addEventListener('push:received', e => {
    const d = e.detail || {};
    if (d.title) toast(d.title);
    refreshCounts();
    const h = location.hash;
    if (h === '#/' || h === '' || h.startsWith('#/ordini')) window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  refreshCounts();
  setInterval(refreshCounts, 60000);
  pushBanner();
}
async function refreshCounts() {
  try {
    const { counts } = await api('/api/admin/dashboard');
    const el = $('[data-count="nuovi"]');
    el.textContent = counts.nuovi || '';
    el.classList.toggle('hidden', !counts.nuovi);
    document.title = `${counts.nuovi ? `(${counts.nuovi}) ` : ''}Gestionale · ${S.config.company_name}`;
  } catch { /* */ }
}
function markNav() {
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0] || '/';
  $$('[data-nav]').forEach(a => {
    const n = a.dataset.nav;
    const on = n === '/' ? path === '/' : path === n || path.startsWith(n + '/');
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
async function pushBanner() {
  const st = await pushState(S.config.vapid_public_key).catch(() => 'unsupported');
  const box = $('#pushbanner');
  if (st !== 'off') { mount(box, ''); return; }
  mount(box, html`<div class="push-banner"><span><strong>Ricevi i nuovi ordini in tempo reale.</strong> Attiva le notifiche su questo dispositivo.</span>
    <button class="btn primary small" id="pushon">Attiva notifiche</button></div>`);
  $('#pushon').onclick = e => withBusy(e.target, async () => { await enablePush(S.config.vapid_public_key); toast('Notifiche attivate'); pushBanner(); });
}
function page(title, actions, body) {
  mount($('#view'), html`<div class="head"><h1>${title}</h1>${actions || ''}</div><div class="page">${body}</div>`);
  return $('#view .page');
}
const loading = title => page(title, '', html`<div class="loading">Caricamento…</div>`);
async function zones() { if (!S.zones) S.zones = (await api('/api/admin/zones')).items; return S.zones; }
async function categories(force) { if (!S.categories || force) S.categories = (await api('/api/admin/categories')).items; return S.categories; }
const daysLabel = s => String(s || '').split(',').filter(Boolean).map(d => DAYS[d - 1]).join(' ');
const sel = (a, b) => String(a ?? '') === String(b ?? '') ? raw('selected') : '';
const chk = v => v ? raw('checked') : '';

// ---------- panoramica ----------
async function viewDashboard() {
  loading('Panoramica');
  let d;
  try { d = await api('/api/admin/dashboard'); } catch (e) { showError(e); return; }
  const c = d.counts;
  const diff = d.prev_month.imponibile ? Math.round((d.month.imponibile / d.prev_month.imponibile - 1) * 100) : null;
  const max = Math.max(1, ...d.series.map(s => s.imponibile));
  const W = 600, H = 150, bw = W / d.series.length;
  const chart = html`<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Imponibile degli ultimi 30 giorni">
    ${d.series.map((s, i) => { const h = Math.max(s.imponibile ? 2 : 0, (s.imponibile / max) * H); return raw(`<rect class="${s.d === d.today ? 'today' : ''}" x="${i * bw + 1.5}" y="${H - h}" width="${bw - 3}" height="${h}" rx="2"><title>${dayShort(s.d)}: ${euro(s.imponibile)} (${s.ordini} ordini)</title></rect>`); })}
    </svg><div class="chart-axis"><span>${dayShort(d.series[0].d)}</span><span>oggi</span></div>`;
  const body = page('Panoramica', html`<a class="btn primary" href="#/nuovo-ordine">Inserisci ordine</a>`, html`
    <div class="kpis">
      <a class="kpi ${c.nuovi ? 'alert' : ''}" href="#/ordini?status=nuovo"><b>${c.nuovi || 0}</b><span>da confermare</span></a>
      <a class="kpi" href="#/preparazione?date=${d.today}"><b>${c.oggi || 0}</b><span>in consegna oggi</span></a>
      <a class="kpi" href="#/preparazione?date=${d.tomorrow}"><b>${c.domani || 0}</b><span>in consegna domani</span></a>
      <div class="kpi"><b class="num">${euro(d.month.imponibile)}</b><span>imponibile del mese${diff !== null ? ` · ${diff >= 0 ? '+' : ''}${diff}% sul mese scorso` : ''}</span></div>
      <div class="kpi"><b>${d.month.clienti}</b><span>clienti che hanno ordinato nel mese</span></div>
    </div>
    <div class="grid2">
      <section class="panel"><h2>Ultimi 30 giorni <span class="muted small">${d.series.reduce((a, s) => a + s.ordini, 0)} ordini</span></h2>${chart}</section>
      <section class="panel"><h2>Ultimi ordini <a href="#/ordini">Tutti</a></h2>
        ${d.recent.length ? html`<ul class="list-plain">${d.recent.map(o => html`<li><a href="#/ordini/${o.id}"><strong>${o.business_name}</strong></a>
          <span class="muted small">${o.number} · ${dateTime(o.created_at)}</span>${statusPill(o.status)}</li>`)}</ul>`
          : html`<p class="muted">Nessun ordine ancora. Invita i tuoi clienti dalla sezione Clienti oppure inserisci un ordine ricevuto al telefono.</p>`}</section>
      <section class="panel"><h2>Prodotti più venduti <span class="muted small">30 giorni</span></h2>
        ${d.top_products.length ? html`<ul class="list-plain">${d.top_products.map(p => html`<li><span>${p.name}${p.pack ? html` <span class="muted small">${p.pack}</span>` : ''}</span><span class="num">${qty(p.qty)} ${p.unit} · ${euro(p.imponibile)}</span></li>`)}</ul>` : html`<p class="muted">Ancora nessun dato.</p>`}</section>
      <section class="panel"><h2>Migliori clienti <span class="muted small">30 giorni</span></h2>
        ${d.top_customers.length ? html`<ul class="list-plain">${d.top_customers.map(cu => html`<li><a href="#/clienti/${cu.id}">${cu.business_name}</a><span class="num">${cu.ordini} ord. · ${euro(cu.imponibile)}</span></li>`)}</ul>` : html`<p class="muted">Ancora nessun dato.</p>`}</section>
      <section class="panel"><h2>Clienti da sentire <span class="muted small">nessun ordine da 3 settimane</span></h2>
        ${d.dormant.length ? html`<ul class="list-plain">${d.dormant.map(cu => html`<li><a href="#/clienti/${cu.id}">${cu.business_name}</a>
          <span class="muted small">${relDays(cu.ultimo)}</span>${cu.phone ? html`<a class="btn small" href="tel:${cu.phone}">${icon('phone')} Chiama</a>` : ''}</li>`)}</ul>` : html`<p class="muted">Tutti i clienti attivi hanno ordinato di recente.</p>`}</section>
      ${d.low_stock.length ? html`<section class="panel"><h2>Scorte basse <a href="#/prodotti">Prodotti</a></h2><ul class="list-plain">${d.low_stock.map(p => html`<li><span>${p.name} <span class="muted small">${p.pack || ''}</span></span><span class="tag ${p.stock <= 0 ? 'warn' : ''}">${qty(p.stock)} ${p.unit}</span></li>`)}</ul></section>` : ''}
    </div>`);
  void body;
}

// ---------- ordini ----------
function hashParams() { return new URLSearchParams((location.hash.split('?')[1]) || ''); }
async function viewOrders() {
  const p = hashParams();
  const st = { status: p.get('status') ?? 'aperti', q: p.get('q') || '', delivery: p.get('delivery') || '', customer_id: p.get('customer_id') || '', offset: 0 };
  const body = page('Ordini', html`<a class="btn" href="/api/admin/export/orders.csv" id="csv">Esporta CSV</a><a class="btn primary" href="#/nuovo-ordine">Inserisci ordine</a>`, html`
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Stato">${[['aperti', 'Aperti'], ['nuovo', 'Da confermare'], ['confermato', 'Confermati'], ['in_consegna', 'In consegna'], ['consegnato', 'Consegnati'], ['annullato', 'Annullati'], ['', 'Tutti']]
        .map(([k, l]) => html`<button data-st="${k}" aria-pressed="${st.status === k}">${l}</button>`)}</div>
      <input type="search" class="grow" id="q" placeholder="Cerca cliente, numero o note" value="${st.q}" aria-label="Cerca">
      <label class="sr" for="dd">Data di consegna</label><input type="date" id="dd" value="${st.delivery}" title="Data di consegna">
    </div>
    <div id="bulk" class="toolbar hidden"></div>
    <div class="table-wrap"><table class="table"><thead><tr>
      <th><input type="checkbox" id="all" aria-label="Seleziona tutti"></th><th>Ordine</th><th>Cliente</th><th>Consegna</th><th>Stato</th><th>Origine</th><th class="num">Totale</th>
    </tr></thead><tbody id="rows"><tr><td colspan="7" class="loading">Caricamento…</td></tr></tbody></table></div>
    <p><button class="btn hidden" id="more">Mostra altri</button></p>`);
  let items = [];
  const load = async (append = false) => {
    const qs = new URLSearchParams({ limit: 50, offset: st.offset });
    for (const k of ['status', 'q', 'delivery', 'customer_id']) if (st[k]) qs.set(k, st[k]);
    try {
      const r = await api(`/api/admin/orders?${qs}`);
      items = append ? items.concat(r.items) : r.items;
      $('#more').classList.toggle('hidden', !r.more);
      renderRows();
    } catch (e) { showError(e); }
  };
  const renderRows = () => {
    mount($('#rows'), items.length ? html`${items.map(o => html`<tr class="click" data-id="${o.id}">
      <td><input type="checkbox" data-pick="${o.id}" aria-label="Seleziona ${o.number}"></td>
      <td><strong>${o.number}</strong><div class="muted small">${dateTime(o.created_at)}</div></td>
      <td>${o.business_name}${o.zone_name ? html`<div class="muted small">${o.zone_name}</div>` : ''}${o.notes ? html`<div class="small" title="${o.notes}">📝 ${o.notes.slice(0, 50)}</div>` : ''}</td>
      <td>${capFirst(dayShort(o.delivery_date))}</td>
      <td>${statusPill(o.status)}${o.paid ? html` <span class="tag">pagato</span>` : ''}</td>
      <td class="small">${SOURCES[o.source] || o.source}</td>
      <td class="num">${euro(o.total)}<div class="muted small">${o.lines} righe</div></td></tr>`)}`
      : html`<tr><td colspan="7"><div class="empty"><h3>Nessun ordine</h3><p>Cambia i filtri per vedere altri ordini.</p></div></td></tr>`);
    updateBulk();
  };
  const picked = () => $$('[data-pick]:checked').map(c => c.dataset.pick);
  const updateBulk = () => {
    const ids = picked();
    const box = $('#bulk');
    box.classList.toggle('hidden', !ids.length);
    if (!ids.length) return;
    mount(box, html`<strong>${ids.length} selezionati:</strong>${['confermato', 'in_preparazione', 'in_consegna', 'consegnato'].map(s => html`<button class="btn small" data-bulk="${s}">Segna ${STATUS_LABEL[s].toLowerCase()}</button>`)}`);
  };
  body.onclick = async e => {
    const segBtn = e.target.closest('[data-st]');
    if (segBtn) { st.status = segBtn.dataset.st; st.offset = 0; $$('[data-st]').forEach(b => b.setAttribute('aria-pressed', b === segBtn)); load(); return; }
    const bulkBtn = e.target.closest('[data-bulk]');
    if (bulkBtn) {
      withBusy(bulkBtn, async () => {
        const r = await api('/api/admin/orders/bulk-status', { method: 'POST', body: { ids: picked(), status: bulkBtn.dataset.bulk } });
        toast(`${r.updated} ordini aggiornati, clienti avvisati`); refreshCounts(); load();
      });
      return;
    }
    if (e.target.id === 'more') { st.offset += 50; load(true); return; }
    if (e.target.matches('input[type=checkbox]')) { if (e.target.id === 'all') $$('[data-pick]').forEach(c => { c.checked = e.target.checked; }); updateBulk(); return; }
    const row = e.target.closest('tr[data-id]');
    if (row) go(`/ordini/${row.dataset.id}`);
  };
  $('#q').oninput = debounce(e => { st.q = e.target.value; st.offset = 0; load(); }, 300);
  $('#dd').onchange = e => { st.delivery = e.target.value; st.offset = 0; load(); };
  $('#csv').onclick = e => {
    e.preventDefault();
    const m = modal(html`<h2>Esporta ordini</h2><p class="muted small">Un file CSV con una riga per prodotto, apribile in Excel. Gli ordini annullati sono esclusi.</p>
      <div class="field-row"><div class="field"><label for="ef">Dal</label><input type="date" id="ef" value="${addDays(todayIso(), -30)}"></div>
      <div class="field"><label for="et">Al</label><input type="date" id="et" value="${todayIso()}"></div></div>
      <div class="modal-actions"><button class="btn ghost" data-close>Annulla</button><a class="btn primary" id="dl">Scarica CSV</a></div>`);
    const upd = () => { m.el.querySelector('#dl').href = `/api/admin/export/orders.csv?from=${m.el.querySelector('#ef').value}&to=${m.el.querySelector('#et').value}`; };
    m.el.oninput = upd; upd();
    m.el.querySelector('#dl').addEventListener('click', () => setTimeout(m.close, 300));
  };
  load();
}

function printHeader(title) {
  const c = S.config;
  return html`<div class="print-only" style="margin-bottom:1rem"><strong style="font-size:14pt">${c.company_name}</strong><br>
    <span class="small">${c.company_address} · Tel. ${c.company_phone} · ${c.company_email}</span><h1 style="margin-top:.75rem">${title}</h1></div>`;
}

async function viewOrder({ id }) {
  loading('Ordine');
  let order;
  try { ({ order } = await api(`/api/admin/orders/${id}`)); } catch (e) { page('Ordine', '', html`<div class="empty"><h3>${e.message}</h3><a href="#/ordini">Torna agli ordini</a></div>`); return; }
  const o = order;
  const idx = STATUS_FLOW.indexOf(o.status);
  const next = o.status !== 'annullato' ? STATUS_FLOW[idx + 1] : null;
  const addr = o.delivery_address || [o.address, o.zip, o.city, o.province].filter(Boolean).join(', ');
  const body = page(`Ordine ${o.number}`, html`
      <button class="btn" onclick="window.print()">${icon('print')} Stampa</button>
      ${o.phone ? html`<a class="btn" href="${waLink(o.phone, `Buongiorno, vi scriviamo per l'ordine ${o.number}.`)}" target="_blank" rel="noopener">${icon('wa')} WhatsApp</a>` : ''}
      ${next ? html`<button class="btn primary" data-status="${next}">Segna come ${STATUS_LABEL[next].toLowerCase()}</button>` : ''}`, html`
    ${printHeader(`Ordine ${o.number} · consegna ${dayLong(o.delivery_date)}`)}
    <div class="grid2" style="grid-template-columns:minmax(0,2fr) minmax(280px,1fr)">
      <div style="display:grid;gap:1.25rem;min-width:0">
        <section class="panel">
          <div class="order-head">
            <div><h2 style="margin:0"><a href="#/clienti/${o.customer_id}">${o.business_name}</a></h2>
              <p class="muted small" style="margin:.25rem 0 0">${[o.contact_name, o.phone].filter(Boolean).join(' · ')}${o.vat ? ` · P.IVA ${o.vat}` : ''}</p></div>
            ${statusPill(o.status)}
          </div>
          <dl class="kv" style="margin-top:1rem">
            <dt>Consegna</dt><dd>${capFirst(dayLong(o.delivery_date))}${o.zone_name ? html` <span class="muted">· ${o.zone_name}</span>` : ''}</dd>
            <dt>Indirizzo</dt><dd>${addr || '—'}${o.delivery_notes ? html`<div class="muted small">${o.delivery_notes}</div>` : ''}</dd>
            <dt>Ricevuto</dt><dd>${dateTime(o.created_at)} · ${SOURCES[o.source] || o.source}${o.user_name ? ` · ${o.user_name}` : ''}</dd>
            ${o.notes ? html`<dt>Note cliente</dt><dd><strong>${o.notes}</strong></dd>` : ''}
          </dl>
        </section>
        <section class="panel" id="lines"></section>
      </div>
      <div style="display:grid;gap:1.25rem;min-width:0" class="no-print">
        <section class="panel"><h2>Stato</h2>
          <div class="status-steps">${[...STATUS_FLOW, 'annullato'].map(s => html`<button data-status="${s}" aria-pressed="${o.status === s}" class="${s === next ? 'next' : ''}">${STATUS_LABEL[s]}</button>`)}</div>
          <p class="hint">Il cliente riceve una notifica a ogni cambio di stato.</p>
        </section>
        <section class="panel"><h2>Gestione</h2>
          <form id="meta">
            <div class="field"><label for="dd">Data di consegna</label><input type="date" id="dd" name="delivery_date" value="${o.delivery_date || ''}"></div>
            <div class="field"><label for="an">Note interne</label><textarea id="an" name="admin_notes" placeholder="Visibili solo a voi">${o.admin_notes || ''}</textarea></div>
            <div class="field"><label for="inv">Riferimento fattura / DDT</label><input id="inv" name="invoice_ref" value="${o.invoice_ref || ''}"></div>
            <label class="check"><input type="checkbox" name="paid" ${chk(o.paid)}> Pagato</label>
            <button class="btn">Salva</button>
          </form>
        </section>
        <section class="panel"><h2>Scrivi al cliente</h2>
          <form id="msg"><div class="field"><label for="mt" class="sr">Messaggio</label><textarea id="mt" name="text" placeholder="Es. Il cedro candito arriva giovedì, il resto domani." required></textarea></div>
          <button class="btn">Invia notifica</button></form>
        </section>
        <section class="panel"><h2>Storico</h2><ul class="events">${o.events.map(e => html`<li><time>${dateTime(e.created_at)}${e.user_name ? ` · ${e.user_name}` : ''}</time>
          ${e.type === 'status' ? html`${STATUS_LABEL[e.status]}${e.note ? ` — ${e.note}` : ''}` : e.type === 'message' ? html`Messaggio: ${e.note}` : e.note}</li>`)}</ul></section>
      </div>
    </div>`);
  renderLines(o, false);
  body.addEventListener('click', e => {
    const sb = e.target.closest('[data-status]');
    if (sb) changeStatus(o, sb.dataset.status, sb);
  });
  $('#view .head').addEventListener('click', e => { const sb = e.target.closest('[data-status]'); if (sb) changeStatus(o, sb.dataset.status, sb); });
  $('#meta').onsubmit = e => {
    e.preventDefault();
    withBusy(e.submitter, async () => {
      const b = formData(e.target);
      await api(`/api/admin/orders/${o.id}`, { method: 'PUT', body: b });
      toast(b.delivery_date !== o.delivery_date ? 'Salvato, cliente avvisato del cambio data' : 'Salvato');
      viewOrder({ id: o.id });
    });
  };
  $('#msg').onsubmit = e => {
    e.preventDefault();
    withBusy(e.submitter, async () => { await api(`/api/admin/orders/${o.id}/message`, { method: 'POST', body: formData(e.target) }); toast('Messaggio inviato'); viewOrder({ id: o.id }); });
  };
}
async function changeStatus(o, status, btn) {
  if (status === o.status) return;
  let note = null;
  if (status === 'annullato') {
    const ok = await confirmDialog({ title: `Annullare l'ordine ${o.number}?`, text: 'Il cliente riceve una notifica e le giacenze vengono ripristinate.', confirm: 'Annulla ordine', danger: true });
    if (!ok) return;
  }
  withBusy(btn, async () => {
    await api(`/api/admin/orders/${o.id}/status`, { method: 'POST', body: { status, note } });
    toast(`Ordine ${STATUS_LABEL[status].toLowerCase()}, cliente avvisato`);
    refreshCounts();
    viewOrder({ id: o.id });
  });
}
async function renderLines(o, editing) {
  const box = $('#lines');
  if (!editing) {
    mount(box, html`<h2>Prodotti <button class="btn small no-print" id="edit">Modifica righe</button></h2>
      <table class="items"><thead><tr><th>Prodotto</th><th class="num">Q.tà</th><th class="num">Prezzo</th><th class="num">IVA</th><th class="num">Totale</th></tr></thead>
      <tbody>${o.items.map(i => html`<tr><td>${i.name}<div class="muted small">${[i.sku, i.pack].filter(Boolean).join(' · ')}</div></td>
        <td class="num"><strong>${qty(i.qty)}</strong> ${i.unit}</td><td class="num">${euro(i.price)}</td><td class="num">${i.vat_rate}%</td><td class="num">${euro(i.line_total)}</td></tr>`)}</tbody></table>
      <table class="totals" style="max-width:320px;margin:1rem 0 0 auto">
        <tr><td>Imponibile</td><td class="num">${euro(o.subtotal)}</td></tr>
        ${o.delivery_fee ? html`<tr><td>Consegna</td><td class="num">${euro(o.delivery_fee)}</td></tr>` : ''}
        <tr><td>IVA</td><td class="num">${euro(o.vat_total)}</td></tr>
        <tr class="grand"><td>Totale</td><td class="num">${euro(o.total)}</td></tr></table>`);
    $('#edit').onclick = () => renderLines(o, true);
    return;
  }
  const { items: catalog } = await api(`/api/admin/customers/${o.customer_id}/catalog`);
  const lines = o.items.map(i => ({ id: i.id, product_id: i.product_id, name: i.name, pack: i.pack, unit: i.unit, qty: i.qty, price: i.price }));
  const draw = () => {
    mount(box, html`<h2>Modifica prodotti</h2>
      <p class="muted small">Correggi le quantità effettive (es. peso reale), sostituisci o aggiungi prodotti. I prezzi sono IVA esclusa.</p>
      <div style="overflow-x:auto"><table class="items"><thead><tr><th>Prodotto</th><th class="num">Q.tà</th><th class="num">Prezzo €</th><th></th></tr></thead>
      <tbody>${lines.map((l, i) => html`<tr><td>${l.name}<div class="muted small">${l.pack || ''}</div></td>
        <td class="num"><input style="width:90px" inputmode="decimal" data-q="${i}" value="${String(l.qty).replace('.', ',')}" aria-label="Quantità"></td>
        <td class="num"><input style="width:100px" inputmode="decimal" data-p="${i}" value="${centsToInput(l.price)}" aria-label="Prezzo"></td>
        <td><button class="btn small ghost" data-rm="${i}" aria-label="Rimuovi">${icon('close')}</button></td></tr>`)}</tbody></table></div>
      <div class="field" style="margin-top:.75rem"><label for="addp">Aggiungi prodotto</label>
        <select id="addp"><option value="">Scegli…</option>${catalog.map(p => html`<option value="${p.id}">${p.name}${p.pack ? ` · ${p.pack}` : ''} — ${euro(p.price)}</option>`)}</select></div>
      <div class="field"><label for="enote">Nota per il cliente (facoltativa)</label><input id="enote" placeholder="Es. Sostituito il formato 50 cl con il 70 cl"></div>
      <label class="check"><input type="checkbox" id="enotify" checked> Avvisa il cliente della modifica</label>
      <div class="actions"><button class="btn primary" id="save">Salva righe</button><button class="btn ghost" id="cancel">Annulla</button></div>`);
  };
  draw();
  box.oninput = e => {
    const i = e.target.dataset.q ?? e.target.dataset.p;
    if (i === undefined) return;
    if (e.target.dataset.q !== undefined) lines[i].qty = Number(e.target.value.replace(',', '.'));
    else lines[i].price = toCents(e.target.value);
  };
  box.onchange = e => {
    if (e.target.id !== 'addp' || !e.target.value) return;
    const p = catalog.find(x => x.id === Number(e.target.value));
    const existing = lines.find(l => l.product_id === p.id);
    if (existing) { existing.qty = Math.round((Number(existing.qty) + 1) * 1000) / 1000; toast(`${p.name} era già nell'ordine: quantità aumentata`); }
    else lines.push({ product_id: p.id, name: p.name, pack: p.pack, unit: p.unit, qty: 1, price: p.price });
    draw();
  };
  box.onclick = e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { lines.splice(Number(rm.dataset.rm), 1); draw(); return; }
    if (e.target.id === 'cancel') { box.oninput = box.onchange = box.onclick = null; renderLines(o, false); return; }
    if (e.target.id === 'save') {
      withBusy(e.target, async () => {
        const { order } = await api(`/api/admin/orders/${o.id}/items`, { method: 'PUT', body: {
          items: lines.map(l => ({ id: l.id, product_id: l.product_id, qty: l.qty, price: l.price })),
          note: $('#enote').value || undefined, notify: $('#enotify').checked,
        } });
        toast('Righe aggiornate');
        viewOrder({ id: order.id });
      });
    }
  };
}

// ---------- preparazione ----------
async function viewPicking() {
  const p = hashParams();
  const st = { date: p.get('date') || addDays(todayIso(), 1), tab: p.get('tab') || 'totali' };
  const body = page('Preparazione e consegne', html`<button class="btn" onclick="window.print()">${icon('print')} Stampa</button>`, html`
    <div class="toolbar">
      <button class="btn small" data-shift="-1" aria-label="Giorno precedente">‹</button>
      <input type="date" id="pd" value="${st.date}" aria-label="Data di consegna">
      <button class="btn small" data-shift="1" aria-label="Giorno successivo">›</button>
      <div class="seg"><button data-tab="totali" aria-pressed="${st.tab === 'totali'}">Da preparare</button><button data-tab="giro" aria-pressed="${st.tab === 'giro'}">Giro consegne</button></div>
    </div>
    <div id="pick"><div class="loading">Caricamento…</div></div>`);
  let data;
  const load = async () => {
    try { data = await api(`/api/admin/picking?date=${st.date}`); draw(); } catch (e) { showError(e); }
  };
  const draw = () => {
    const box = $('#pick');
    if (!data.orders.length) { mount(box, html`<div class="empty"><h3>Nessuna consegna per ${dayLong(st.date)}</h3><p>Gli ordini aperti con questa data compariranno qui.</p></div>`); return; }
    const pending = data.orders.filter(o => o.status === 'nuovo').length;
    const head = html`${printHeader(`${st.tab === 'totali' ? 'Da preparare' : 'Giro consegne'} · ${dayLong(st.date)}`)}
      <p class="no-print"><strong>${data.orders.length} ordini</strong> per ${dayLong(st.date)} · ${euro(data.orders.reduce((a, o) => a + o.total, 0))} totale
      ${pending ? html` · <span class="tag warn">${pending} ancora da confermare</span>` : ''}</p>
      <div class="actions no-print" style="margin-bottom:1rem">
        <button class="btn small" data-all="confermato">Conferma tutti</button>
        <button class="btn small" data-all="in_preparazione">Tutti in preparazione</button>
        <button class="btn small" data-all="in_consegna">Tutti in consegna</button>
        <button class="btn small" data-all="consegnato">Tutti consegnati</button></div>`;
    if (st.tab === 'totali') {
      mount(box, html`${head}<div class="table-wrap"><table class="table"><thead><tr><th style="width:36px"></th><th>Prodotto</th><th>Formato</th><th class="num">Quantità</th><th class="num">Ordini</th></tr></thead>
        <tbody>${data.products.map(pr => html`<tr><td><input type="checkbox" aria-label="Preparato"></td><td><strong>${pr.name}</strong>${pr.sku ? html`<div class="muted small">${pr.sku}</div>` : ''}</td><td>${pr.pack || ''}</td>
        <td class="num"><span class="pick-total">${qty(pr.qty)}</span> ${pr.unit}</td><td class="num">${pr.orders}</td></tr>`)}</tbody></table></div>`);
    } else {
      const byZone = {};
      for (const o of data.orders) (byZone[o.zone_name] ||= []).push(o);
      mount(box, html`${head}${Object.entries(byZone).map(([z, list]) => html`<h2 class="zone-title">${z} <span class="muted small">${list.length} consegne</span></h2>
        ${list.map((o, n) => html`<article class="stop">
          <div class="order-head"><div><h3>${n + 1}. ${o.business_name}</h3>
            <p class="small" style="margin:.2rem 0">${o.address || ''}${o.delivery_notes ? html` · <em>${o.delivery_notes}</em>` : ''}</p>
            <p class="small muted" style="margin:0">${[o.contact_name, o.phone].filter(Boolean).join(' · ')}${o.payment_terms ? ` · ${o.payment_terms}` : ''}</p></div>
            <div class="right"><a href="#/ordini/${o.id}">${o.number}</a><br>${statusPill(o.status)}<div class="num" style="margin-top:.3rem"><strong>${euro(o.total)}</strong>${o.paid ? ' · pagato' : ''}</div></div></div>
          <table class="items" style="margin-top:.5rem"><tbody>${o.items.map(i => html`<tr><td style="width:36px"><input type="checkbox" aria-label="Caricato"></td><td>${i.name} <span class="muted small">${i.pack || ''}</span></td><td class="num"><strong>${qty(i.qty)}</strong> ${i.unit}</td></tr>`)}</tbody></table>
          ${o.notes ? html`<p class="small" style="margin:.5rem 0 0"><strong>Note:</strong> ${o.notes}</p>` : ''}
          <p class="print-only small" style="margin-top:1rem">Firma per ricevuta: ______________________</p>
        </article>`)}`)}`);
    }
  };
  body.onclick = e => {
    const sh = e.target.closest('[data-shift]');
    if (sh) { st.date = addDays(st.date, Number(sh.dataset.shift)); $('#pd').value = st.date; load(); return; }
    const tb = e.target.closest('[data-tab]');
    if (tb) { st.tab = tb.dataset.tab; $$('[data-tab]').forEach(b => b.setAttribute('aria-pressed', b === tb)); draw(); return; }
    const all = e.target.closest('[data-all]');
    if (all) {
      withBusy(all, async () => {
        const r = await api('/api/admin/orders/bulk-status', { method: 'POST', body: { ids: data.orders.map(o => o.id), status: all.dataset.all } });
        toast(`${r.updated} ordini aggiornati`); refreshCounts(); load();
      });
    }
  };
  $('#pd').onchange = e => { st.date = e.target.value; load(); };
  load();
}

// ---------- inserisci ordine (telefono / WhatsApp) ----------
async function viewNewOrder() {
  const body = page('Inserisci ordine', '', html`<div class="loading">Caricamento…</div>`);
  const { items: customers } = await api('/api/admin/customers');
  const preset = hashParams().get('customer_id');
  const st = { customer: null, catalog: [], dates: [], lines: new Map(), q: '' };
  mount(body, html`
    <p class="muted">Per gli ordini ricevuti al telefono, su WhatsApp o dall'agente: niente vincoli di orario o minimo d'ordine.</p>
    <div class="grid2" style="grid-template-columns:minmax(0,3fr) minmax(280px,2fr)">
      <section class="panel">
        <div class="field"><label for="cust">Cliente</label>
          <select id="cust"><option value="">Scegli il cliente…</option>${customers.map(c => html`<option value="${c.id}" ${sel(c.id, preset)}>${c.business_name}${c.city ? ` — ${c.city}` : ''}${c.blocked ? ' (bloccato)' : ''}</option>`)}</select></div>
        <div id="prods"><p class="muted">Scegli un cliente per vedere il suo listino.</p></div>
      </section>
      <section class="panel" id="summary" style="position:sticky;top:1rem"></section>
    </div>`);
  const loadCustomer = async id => {
    st.customer = customers.find(c => c.id === Number(id)) || null;
    st.lines.clear();
    if (!st.customer) { mount($('#prods'), html`<p class="muted">Scegli un cliente per vedere il suo listino.</p>`); drawSummary(); return; }
    const r = await api(`/api/admin/customers/${id}/catalog`);
    st.catalog = r.items; st.dates = r.delivery_dates;
    drawProducts(); drawSummary();
  };
  const drawProducts = () => {
    const q = st.q.toLowerCase();
    const list = st.catalog.filter(p => !q || `${p.name} ${p.pack || ''} ${p.sku || ''}`.toLowerCase().includes(q));
    mount($('#prods'), html`<div class="searchbar">${icon('search')}<input type="search" id="pq" placeholder="Cerca prodotto" value="${st.q}" aria-label="Cerca prodotto"></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Prodotto</th><th class="num">Prezzo</th><th class="num">Quantità</th></tr></thead><tbody>
      ${list.map(p => html`<tr><td>${p.name}<div class="muted small">${[p.sku, p.pack].filter(Boolean).join(' · ')}${!p.available ? ' · non disponibile' : ''}${p.stock !== null ? ` · giacenza ${qty(p.stock)}` : ''}</div></td>
        <td class="num">${euro(p.price)}<div class="muted small">/ ${p.unit}</div></td>
        <td class="num"><input style="width:90px" inputmode="decimal" data-pid="${p.id}" value="${st.lines.get(p.id) ? String(st.lines.get(p.id)).replace('.', ',') : ''}" aria-label="Quantità ${p.name}"></td></tr>`)}
      </tbody></table></div>`);
    $('#pq').oninput = debounce(e => { st.q = e.target.value; drawProducts(); $('#pq').focus(); }, 200);
  };
  const drawSummary = () => {
    const box = $('#summary');
    if (!st.customer) { mount(box, html`<h2>Riepilogo</h2><p class="muted">Nessun cliente scelto.</p>`); return; }
    const lines = [...st.lines].map(([id, q]) => ({ p: st.catalog.find(x => x.id === id), q })).filter(l => l.p && l.q > 0);
    const sub = lines.reduce((a, l) => a + Math.round(l.p.price * l.q), 0);
    const listTpl = lines.length ? html`<ul class="list-plain">${lines.map(l => html`<li><span>${qty(l.q)} × ${l.p.name} <span class="muted small">${l.p.pack || ''}</span></span><span class="num">${euro(Math.round(l.p.price * l.q))}</span></li>`)}</ul>
        <p class="num right"><strong>Imponibile ${euro(sub)}</strong></p>` : html`<p class="muted">Inserisci le quantità a sinistra.</p>`;
    if ($('#nf') && box.dataset.cust === String(st.customer.id)) {
      mount($('#sumlist'), listTpl);
      $('#nf button.primary').disabled = !lines.length;
      return;
    }
    box.dataset.cust = st.customer.id;
    mount(box, html`<h2>Riepilogo</h2><div id="sumlist">${listTpl}</div>
      <form id="nf">
        <div class="field"><label for="nd">Consegna</label>
          <select id="nd" name="delivery_date">${st.dates.map(d => html`<option value="${d.date}">${dayLong(d.date)}</option>`)}<option value="__other">Altra data…</option></select>
          <input type="date" id="ndo" class="hidden" style="margin-top:.5rem" aria-label="Altra data"></div>
        <div class="field-row">
          <div class="field"><label for="ns">Ricevuto via</label><select id="ns" name="source">${['telefono', 'whatsapp', 'email', 'agente'].map(s => html`<option value="${s}">${SOURCES[s]}</option>`)}</select></div>
          <div class="field"><label for="nst">Stato iniziale</label><select id="nst" name="status"><option value="confermato">Confermato</option><option value="nuovo">Da confermare</option></select></div>
        </div>
        <div class="field"><label for="nn">Note</label><textarea id="nn" name="notes"></textarea></div>
        <label class="check"><input type="checkbox" name="notify_customer" checked> Invia conferma al cliente (notifica)</label>
        <button class="btn primary block" ${lines.length ? '' : raw('disabled')}>Salva ordine</button>
      </form>`);
    $('#nd').onchange = e => $('#ndo').classList.toggle('hidden', e.target.value !== '__other');
    $('#nf').onsubmit = e => {
      e.preventDefault();
      withBusy(e.submitter, async () => {
        const b = formData(e.target);
        if (b.delivery_date === '__other') { b.delivery_date = $('#ndo').value; if (!b.delivery_date) throw new Error('Scegli la data di consegna.'); }
        b.customer_id = st.customer.id;
        b.items = [...st.lines].filter(([, q]) => q > 0).map(([id, q]) => ({ product_id: id, qty: q }));
        const { order } = await api('/api/admin/orders', { method: 'POST', body: b });
        toast(`Ordine ${order.number} salvato`); refreshCounts();
        go(`/ordini/${order.id}`);
      });
    };
  };
  body.addEventListener('input', e => {
    if (e.target.dataset.pid) {
      const v = Number(e.target.value.replace(',', '.'));
      if (v > 0) st.lines.set(Number(e.target.dataset.pid), v); else st.lines.delete(Number(e.target.dataset.pid));
      drawSummary();
    }
  });
  body.addEventListener('change', e => {
    if (e.target.id === 'cust') { delete $('#summary').dataset.cust; loadCustomer(e.target.value).catch(showError); }
    if (e.target.dataset.pid) {
      const v = Number(e.target.value.replace(',', '.'));
      if (v > 0) st.lines.set(Number(e.target.dataset.pid), v); else st.lines.delete(Number(e.target.dataset.pid));
      drawSummary();
    }
  });
  drawSummary();
  if (preset) loadCustomer(preset).catch(showError);
}

// ---------- prodotti ----------
async function viewProducts() {
  const body = page('Prodotti', html`<button class="btn" id="cats">Categorie</button><button class="btn" id="imp">Importa listino</button><button class="btn primary" id="new">Nuovo prodotto</button>`, html`
    <div class="toolbar"><input type="search" class="grow" id="q" placeholder="Cerca per nome o codice" aria-label="Cerca"><select id="cf" aria-label="Categoria"><option value="">Tutte le categorie</option></select>
    <label class="check" style="margin:0"><input type="checkbox" id="arch"> Mostra archiviati</label><button class="btn small ghost" id="exp">Esporta CSV</button></div>
    <div class="table-wrap"><table class="table"><thead><tr><th></th><th>Prodotto</th><th>Categoria</th><th class="num">Prezzo base</th><th class="num">IVA</th><th class="num">Giacenza</th><th>Ordinabile</th><th></th></tr></thead>
    <tbody id="rows"><tr><td colspan="8" class="loading">Caricamento…</td></tr></tbody></table></div>`);
  let items = [];
  const cats = await categories(true);
  mount($('#cf'), html`<option value="">Tutte le categorie</option>${cats.map(c => html`<option value="${c.id}">${c.name}</option>`)}`);
  const load = async () => { items = (await api('/api/admin/products')).items; draw(); };
  const draw = () => {
    const q = $('#q').value.toLowerCase(), cf = $('#cf').value, arch = $('#arch').checked;
    const list = items.filter(p => (arch || !p.archived) && (!cf || String(p.category_id) === cf) && (!q || `${p.name} ${p.sku || ''} ${p.pack || ''}`.toLowerCase().includes(q)));
    mount($('#rows'), list.length ? html`${list.map(p => html`<tr>
      <td>${p.image ? html`<img src="${p.image}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:4px">` : ''}</td>
      <td><strong>${p.name}</strong>${p.featured ? html` <span class="tag">in evidenza</span>` : ''}${p.reserved_to ? html` <span class="tag">riservato a ${p.reserved_to}</span>` : ''}${p.archived ? html` <span class="tag warn">archiviato</span>` : ''}
        <div class="muted small">${[p.sku, p.pack, `${p.unit}${p.min_qty > 1 ? `, min ${qty(p.min_qty)}` : ''}`].filter(Boolean).join(' · ')}</div></td>
      <td class="small">${p.category_name || '—'}</td>
      <td class="num">${euro(p.price)}</td><td class="num">${p.vat_rate}%</td>
      <td class="num">${p.stock === null ? html`<span class="muted">—</span>` : html`<span class="${p.stock <= 0 ? 'tag warn' : ''}">${qty(p.stock)}</span>`}</td>
      <td><label class="switch"><input type="checkbox" data-av="${p.id}" ${chk(p.available)} aria-label="Ordinabile"><span></span></label></td>
      <td><button class="btn small" data-edit="${p.id}">Modifica</button></td></tr>`)}`
      : html`<tr><td colspan="8"><div class="empty"><h3>Nessun prodotto</h3><p>Aggiungi il primo prodotto o importa il listino da un file CSV.</p></div></td></tr>`);
  };
  body.onchange = e => {
    if (e.target.dataset.av) api(`/api/admin/products/${e.target.dataset.av}`, { method: 'PATCH', body: { available: e.target.checked } })
      .then(() => { items.find(p => p.id === Number(e.target.dataset.av)).available = e.target.checked ? 1 : 0; toast(e.target.checked ? 'Ora è ordinabile' : 'Nascosto agli ordini'); }).catch(showError);
    if (e.target.id === 'cf' || e.target.id === 'arch') draw();
  };
  body.onclick = e => { const b = e.target.closest('[data-edit]'); if (b) productModal(items.find(p => p.id === Number(b.dataset.edit)), load); };
  $('#q').oninput = debounce(draw, 150);
  $('#new').onclick = () => productModal(null, load);
  $('#cats').onclick = () => categoriesModal(load);
  $('#imp').onclick = () => importModal(load);
  $('#exp').onclick = () => {
    const head = ['codice', 'nome', 'categoria', 'unita', 'formato', 'prezzo', 'iva', 'giacenza'];
    const rows = items.filter(p => !p.archived).map(p => [p.sku, p.name, p.category_name, p.unit, p.pack, (p.price / 100).toFixed(2).replace('.', ','), p.vat_rate, p.stock ?? '']);
    const cell = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const blob = new Blob(['﻿' + [head, ...rows].map(r => r.map(cell).join(';')).join('\r\n')], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `listino_${todayIso()}.csv` });
    a.click(); URL.revokeObjectURL(a.href);
  };
  load().catch(showError);
}
async function productModal(p, done) {
  const cats = await categories();
  const isNew = !p;
  p = p || { available: 1, unit: 'pz', vat_rate: 10, min_qty: 1, step_qty: 1, price: 0, sort: 0 };
  const m = modal(html`<h2>${isNew ? 'Nuovo prodotto' : p.name}</h2>
    <form id="pf">
      <div class="field-row">
        <div class="field" style="grid-column:span 2"><label for="pn">Nome</label><input id="pn" name="name" value="${p.name || ''}" required></div>
        <div class="field"><label for="ps">Codice</label><input id="ps" name="sku" value="${p.sku || ''}"></div>
      </div>
      <div class="field"><label for="pd">Descrizione</label><textarea id="pd" name="description" style="min-height:60px">${p.description || ''}</textarea></div>
      <div class="field-row">
        <div class="field"><label for="pc">Categoria</label><select id="pc" name="category_id"><option value="">—</option>${cats.map(c => html`<option value="${c.id}" ${sel(c.id, p.category_id)}>${c.name}</option>`)}</select></div>
        <div class="field"><label for="pk">Formato</label><input id="pk" name="pack" value="${p.pack || ''}" placeholder="es. 70 cl, 6 × 250 g"></div>
        <div class="field"><label for="pu">Unità di vendita</label><input id="pu" name="unit" value="${p.unit}" list="units" required>
          <datalist id="units"><option>pz</option><option>bottiglia</option><option>cartone</option><option>kg</option><option>vasetto</option><option>confezione</option></datalist></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="pp">Prezzo base € (IVA esclusa)</label><input id="pp" name="price" inputmode="decimal" value="${centsToInput(p.price)}" required></div>
        <div class="field"><label for="pv">IVA %</label><select id="pv" name="vat_rate">${[4, 5, 10, 22].map(v => html`<option ${sel(v, p.vat_rate)}>${v}</option>`)}</select></div>
        <div class="field"><label for="pst">Giacenza</label><input id="pst" name="stock" inputmode="decimal" value="${p.stock ?? ''}" placeholder="vuoto = non gestita"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="pmin">Quantità minima</label><input id="pmin" name="min_qty" inputmode="decimal" value="${p.min_qty}"></div>
        <div class="field"><label for="pstep">Multipli di</label><input id="pstep" name="step_qty" inputmode="decimal" value="${p.step_qty}"></div>
        <div class="field"><label for="psort">Ordine in elenco</label><input id="psort" name="sort" type="number" value="${p.sort}"></div>
      </div>
      <label class="check"><input type="checkbox" name="available" ${chk(p.available)}> Ordinabile dai clienti</label>
      <label class="check"><input type="checkbox" name="featured" ${chk(p.featured)}> In evidenza in cima al catalogo</label>
      ${!isNew ? html`<label class="check"><input type="checkbox" name="archived" ${chk(p.archived)}> Archiviato (non compare più da nessuna parte)</label>` : ''}
      <div class="field"><label for="piu">Immagine da URL (facoltativa)</label><input id="piu" name="image_url" value="${p.image_url || ''}" placeholder="https://officinedeicedri.it/wp-content/uploads/…"></div>
      ${!isNew ? html`<div class="field"><label for="pimg">Oppure carica una foto</label>
        <div style="display:flex;gap:.75rem;align-items:center">${p.image ? html`<img src="${p.image}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:6px">` : ''}
        <input type="file" id="pimg" accept="image/jpeg,image/png,image/webp">${p.image_key ? html`<button type="button" class="btn small ghost" id="rmimg">Rimuovi</button>` : ''}</div></div>
        <button type="button" class="btn small" id="vis">Riservato a clienti specifici…</button>` : ''}
      <div class="modal-actions">
        ${!isNew ? html`<button type="button" class="btn ghost" id="del" style="margin-right:auto;color:var(--fig)">Elimina</button>` : ''}
        <button type="button" class="btn ghost" data-close>Annulla</button><button class="btn primary">Salva</button></div>
    </form>`, { wide: true });
  const f = m.el.querySelector('#pf');
  f.onsubmit = e => {
    e.preventDefault();
    withBusy(e.submitter, async () => {
      const b = formData(f);
      b.price = toCents(b.price);
      if (b.price === null) throw new Error('Prezzo non valido.');
      for (const k of ['min_qty', 'step_qty', 'stock']) b[k] = b[k] === '' ? '' : String(b[k]).replace(',', '.');
      if (isNew) await api('/api/admin/products', { method: 'POST', body: b });
      else await api(`/api/admin/products/${p.id}`, { method: 'PUT', body: b });
      toast('Prodotto salvato'); m.close(); done();
    });
  };
  m.el.querySelector('#pimg')?.addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    withBusy(null, async () => { await api(`/api/admin/products/${p.id}/image`, { method: 'POST', form: fd }); toast('Immagine caricata'); m.close(); done(); });
  });
  m.el.querySelector('#rmimg')?.addEventListener('click', () => withBusy(null, async () => { await api(`/api/admin/products/${p.id}/image`, { method: 'DELETE' }); m.close(); done(); }));
  m.el.querySelector('#del')?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: `Eliminare ${p.name}?`, text: 'Se è già stato ordinato verrà archiviato, così lo storico resta corretto.', confirm: 'Elimina', danger: true }))) return;
    const r = await api(`/api/admin/products/${p.id}`, { method: 'DELETE' }).catch(showError);
    if (r) { toast(r.archived ? 'Prodotto archiviato' : 'Prodotto eliminato'); m.close(); done(); }
  });
  m.el.querySelector('#vis')?.addEventListener('click', () => visibilityModal(p));
}
async function visibilityModal(p) {
  const [{ items: customers }, { customer_ids }] = await Promise.all([api('/api/admin/customers'), api(`/api/admin/products/${p.id}/visibility`)]);
  const set = new Set(customer_ids);
  const m = modal(html`<h2>Chi vede ${p.name}?</h2>
    <p class="muted small">Se non scegli nessuno, il prodotto è visibile a tutti. Se scegli dei clienti, lo vedono solo loro (es. formati o prezzi dedicati).</p>
    <div style="max-height:50vh;overflow:auto">${customers.map(c => html`<label class="check"><input type="checkbox" name="c" value="${c.id}" ${chk(set.has(c.id))}> ${c.business_name}</label>`)}</div>
    <div class="modal-actions"><button class="btn ghost" data-close>Annulla</button><button class="btn primary" id="ok">Salva</button></div>`);
  m.el.querySelector('#ok').onclick = e => withBusy(e.target, async () => {
    const ids = $$('input[name=c]:checked', m.el).map(i => Number(i.value));
    await api(`/api/admin/products/${p.id}/visibility`, { method: 'PUT', body: { customer_ids: ids } });
    toast(ids.length ? `Visibile solo a ${ids.length} clienti` : 'Visibile a tutti'); m.close();
  });
}
async function categoriesModal(done) {
  const cats = await categories(true);
  const m = modal(html`<h2>Categorie</h2>
    <ul class="list-plain">${cats.map(c => html`<li><input value="${c.name}" data-name="${c.id}" aria-label="Nome categoria"><input type="number" value="${c.sort}" data-sort="${c.id}" style="width:70px" aria-label="Ordine">
      <span class="muted small" style="white-space:nowrap">${c.products} prod.</span><button class="btn small ghost" data-del="${c.id}" aria-label="Elimina">${icon('close')}</button></li>`)}</ul>
    <form id="nc" class="toolbar" style="margin-top:1rem"><input name="name" placeholder="Nuova categoria" class="grow" required aria-label="Nuova categoria"><button class="btn">Aggiungi</button></form>
    <div class="modal-actions"><button class="btn primary" data-close>Fatto</button></div>`, { onClose: done });
  m.el.onchange = e => {
    const id = e.target.dataset.name || e.target.dataset.sort; if (!id) return;
    api(`/api/admin/categories/${id}`, { method: 'PUT', body: { name: m.el.querySelector(`[data-name="${id}"]`).value, sort: m.el.querySelector(`[data-sort="${id}"]`).value } }).then(() => toast('Salvato')).catch(showError);
  };
  m.el.onclick = async e => {
    const d = e.target.closest('[data-del]'); if (!d) return;
    if (!(await confirmDialog({ title: 'Eliminare la categoria?', text: 'I prodotti restano, senza categoria.', confirm: 'Elimina', danger: true }))) return;
    await api(`/api/admin/categories/${d.dataset.del}`, { method: 'DELETE' }); m.close(); categoriesModal(done);
  };
  m.el.querySelector('#nc').onsubmit = e => { e.preventDefault(); withBusy(e.submitter, async () => { await api('/api/admin/categories', { method: 'POST', body: formData(e.target) }); m.close(); categoriesModal(done); }); };
}
function parseCsv(text) {
  const sep = (text.split('\n')[0].match(/;/g) || []).length >= (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
function importModal(done) {
  const m = modal(html`<h2>Importa listino</h2>
    <p class="muted small">File CSV (anche esportato da Excel) con intestazioni: <b>codice, nome, categoria, unita, formato, prezzo, iva, giacenza</b>. I prodotti con un codice già presente vengono aggiornati, gli altri creati. Prezzi in euro IVA esclusa (es. 12,50).</p>
    <input type="file" id="csvf" accept=".csv,text/csv"><div id="prev" style="margin-top:1rem"></div>
    <div class="modal-actions"><button class="btn ghost" data-close>Annulla</button><button class="btn primary" id="go" disabled>Importa</button></div>`, { wide: true });
  let rows = [];
  m.el.querySelector('#csvf').onchange = async e => {
    const text = (await e.target.files[0].text()).replace(/^﻿/, '');
    const [head, ...data] = parseCsv(text);
    const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
    const map = { codice: 'sku', sku: 'sku', nome: 'name', prodotto: 'name', categoria: 'category', unita: 'unit', formato: 'pack', prezzo: 'price', iva: 'vat_rate', giacenza: 'stock' };
    const cols = head.map(h => map[norm(h)] || null);
    if (!cols.includes('name') && !cols.includes('sku')) { mount(m.el.querySelector('#prev'), html`<p class="notice error">Non trovo le colonne "nome" o "codice" nella prima riga.</p>`); return; }
    rows = data.map(r => {
      const o = {};
      cols.forEach((k, i) => { if (!k) return; let v = (r[i] ?? '').trim(); if (k === 'price') { v = v ? toCents(v.replace('€', '').trim()) : null; } if (k === 'vat_rate') v = v ? Number(v.replace('%', '').replace(',', '.')) : null; if (k === 'stock' && v !== '') v = v.replace(',', '.'); o[k] = v === '' && k !== 'stock' ? null : v; });
      if (!cols.includes('stock')) delete o.stock;
      return o;
    }).filter(o => o.name || o.sku);
    mount(m.el.querySelector('#prev'), html`<p><strong>${rows.length} righe</strong> pronte. Anteprima:</p>
      <div class="table-wrap"><table class="table"><tbody>${rows.slice(0, 5).map(r => html`<tr><td>${r.sku || ''}</td><td>${r.name || ''}</td><td>${r.pack || ''}</td><td class="num">${r.price != null ? euro(r.price) : ''}</td></tr>`)}</tbody></table></div>`);
    m.el.querySelector('#go').disabled = !rows.length;
  };
  m.el.querySelector('#go').onclick = e => withBusy(e.target, async () => {
    const r = await api('/api/admin/products/import', { method: 'POST', body: { rows } });
    toast(`${r.created} creati, ${r.updated} aggiornati`); m.close(); S.categories = null; done();
  });
}

// ---------- clienti ----------
async function viewCustomers() {
  const body = page('Clienti', html`<button class="btn primary" id="new">Nuovo cliente</button>`, html`
    <div class="toolbar"><input type="search" class="grow" id="q" placeholder="Cerca per nome, città, P.IVA" aria-label="Cerca"></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>Cliente</th><th>Zona</th><th>Accesso</th><th class="num">Ordini</th><th>Ultimo ordine</th><th class="num">Imponibile 12 mesi</th></tr></thead>
    <tbody id="rows"><tr><td colspan="6" class="loading">Caricamento…</td></tr></tbody></table></div>`);
  let items = [];
  const draw = () => {
    const q = $('#q').value.toLowerCase();
    const list = items.filter(c => !q || `${c.business_name} ${c.city || ''} ${c.vat || ''} ${c.email || ''}`.toLowerCase().includes(q));
    mount($('#rows'), list.length ? html`${list.map(c => html`<tr class="click" data-id="${c.id}">
      <td><strong>${c.business_name}</strong>${c.blocked ? html` <span class="tag warn">bloccato</span>` : ''}<div class="muted small">${[c.city, c.contact_name].filter(Boolean).join(' · ')}</div></td>
      <td class="small">${c.zone_name || '—'}</td>
      <td>${c.active_users ? html`<span class="tag">attivo</span>` : c.users_count ? html`<span class="tag warn">invito in attesa</span>` : html`<span class="muted small">nessuno</span>`}</td>
      <td class="num">${c.orders_count}</td><td class="small">${c.last_order ? relDays(c.last_order) : '—'}</td><td class="num">${euro(c.revenue_year)}</td></tr>`)}`
      : html`<tr><td colspan="6"><div class="empty"><h3>Nessun cliente</h3><p>Crea il primo cliente e mandagli l'invito: sceglierà la sua password e potrà ordinare.</p></div></td></tr>`);
  };
  body.onclick = e => { const r = e.target.closest('tr[data-id]'); if (r) go(`/clienti/${r.dataset.id}`); };
  $('#q').oninput = debounce(draw, 150);
  $('#new').onclick = () => customerModal();
  items = (await api('/api/admin/customers')).items; draw();
}
function customerForm(c, zs) {
  return html`
    <div class="field-row">
      <div class="field" style="grid-column:span 2"><label for="bn">Ragione sociale / insegna</label><input id="bn" name="business_name" value="${c.business_name || ''}" required></div>
      <div class="field"><label for="vat">P.IVA</label><input id="vat" name="vat" value="${c.vat || ''}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="cn">Referente</label><input id="cn" name="contact_name" value="${c.contact_name || ''}"></div>
      <div class="field"><label for="ph">Telefono</label><input id="ph" name="phone" type="tel" value="${c.phone || ''}"></div>
      <div class="field"><label for="em">Email</label><input id="em" name="email" type="email" value="${c.email || ''}"></div>
    </div>
    <div class="field-row">
      <div class="field" style="grid-column:span 2"><label for="ad">Indirizzo</label><input id="ad" name="address" value="${c.address || ''}"></div>
      <div class="field"><label for="zp">CAP</label><input id="zp" name="zip" value="${c.zip || ''}"></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="ci">Città</label><input id="ci" name="city" value="${c.city || ''}"></div>
      <div class="field"><label for="pr">Provincia</label><input id="pr" name="province" value="${c.province || ''}" maxlength="2"></div>
      <div class="field"><label for="zo">Zona di consegna</label><select id="zo" name="zone_id"><option value="">—</option>${zs.map(z => html`<option value="${z.id}" ${sel(z.id, c.zone_id)}>${z.name}</option>`)}</select></div>
    </div>
    <div class="field"><label for="da">Indirizzo di consegna (se diverso)</label><input id="da" name="delivery_address" value="${c.delivery_address || ''}"></div>
    <div class="field"><label for="dn">Indicazioni per la consegna</label><input id="dn" name="delivery_notes" value="${c.delivery_notes || ''}" placeholder="es. dal retro, chiuso il lunedì"></div>
    <div class="field-row">
      <div class="field"><label for="ds">Sconto sul listino %</label><input id="ds" name="discount" inputmode="decimal" value="${c.discount ?? 0}"></div>
      <div class="field"><label for="mo">Ordine minimo € (vuoto = generale)</label><input id="mo" name="min_order" inputmode="decimal" value="${c.min_order != null ? centsToInput(c.min_order) : ''}"></div>
      <div class="field"><label for="pt">Pagamento</label><input id="pt" name="payment_terms" value="${c.payment_terms || ''}" list="pts" placeholder="es. Bonifico 30 gg">
        <datalist id="pts"><option>Contanti alla consegna</option><option>Bonifico anticipato</option><option>Bonifico 30 gg d.f.</option><option>RiBa 60 gg</option></datalist></div>
    </div>
    <details><summary class="small" style="cursor:pointer;margin-bottom:.75rem">Dati di fatturazione</summary>
      <div class="field-row">
        <div class="field"><label for="cf">Codice fiscale</label><input id="cf" name="tax_code" value="${c.tax_code || ''}"></div>
        <div class="field"><label for="sdi">Codice SDI</label><input id="sdi" name="sdi" value="${c.sdi || ''}" maxlength="7"></div>
        <div class="field"><label for="pec">PEC</label><input id="pec" name="pec" value="${c.pec || ''}"></div>
      </div></details>
    <div class="field"><label for="nt">Note interne</label><textarea id="nt" name="notes">${c.notes || ''}</textarea></div>
    <label class="check"><input type="checkbox" name="blocked" ${chk(c.blocked)}> Blocca gli ordini online</label>
    <div class="field"><label for="br">Messaggio mostrato al cliente se bloccato</label><input id="br" name="blocked_reason" value="${c.blocked_reason || ''}" placeholder="es. Saldo in sospeso, contattaci"></div>`;
}
function customerPayload(form) {
  const b = formData(form);
  b.discount = String(b.discount || 0).replace(',', '.');
  b.min_order = b.min_order === '' ? null : toCents(b.min_order);
  return b;
}
async function customerModal() {
  const zs = await zones();
  const m = modal(html`<h2>Nuovo cliente</h2><form id="cf2">${customerForm({}, zs)}
    <div class="panel" style="background:var(--pith)">
      <label class="check"><input type="checkbox" name="create_login" checked> Crea l'accesso per ordinare online</label>
      <div class="field" style="margin:0"><label for="le">Email di accesso (se diversa da quella sopra)</label><input id="le" name="login_email" type="email"></div>
    </div>
    <div class="modal-actions"><button type="button" class="btn ghost" data-close>Annulla</button><button class="btn primary">Crea cliente</button></div></form>`, { wide: true });
  m.el.querySelector('form').onsubmit = e => {
    e.preventDefault();
    withBusy(e.submitter, async () => {
      const b = customerPayload(e.target);
      if (b.create_login && !b.login_email && !b.email) throw new Error('Per creare l\'accesso serve un\'email.');
      const r = await api('/api/admin/customers', { method: 'POST', body: b });
      m.close();
      go(`/clienti/${r.id}`);
      if (r.invite) setTimeout(() => inviteModal(r.invite, b.phone, b.business_name), 300);
    });
  };
}
function inviteModal(invite, phone, name) {
  const msg = `Ciao! Da oggi puoi ordinare i prodotti di ${S.config.company_name} online, con i tuoi prezzi. Scegli la password da qui: ${invite.link}`;
  const m = modal(html`<h2>Invito pronto</h2>
    <p>${invite.emailed ? 'Abbiamo inviato l\'email con il link.' : 'Manda il link al cliente: con questo sceglie la password.'} Il link vale 14 giorni.</p>
    <div class="linkbox"><input readonly value="${invite.link}" aria-label="Link di invito"><button class="btn" id="cp">Copia</button></div>
    <div class="actions"><a class="btn primary" href="${waLink(phone, msg)}" target="_blank" rel="noopener">${icon('wa')} Invia su WhatsApp${name ? ` a ${name}` : ''}</a></div>
    <div class="modal-actions"><button class="btn ghost" data-close>Chiudi</button></div>`);
  m.el.querySelector('#cp').onclick = async () => { try { await navigator.clipboard.writeText(invite.link); toast('Link copiato'); } catch { m.el.querySelector('input').select(); } };
}
async function viewCustomer({ id }) {
  loading('Cliente');
  let d, zs, prods;
  try { [d, zs, { items: prods }] = await Promise.all([api(`/api/admin/customers/${id}`), zones(), api('/api/admin/products')]); }
  catch (e) { page('Cliente', '', html`<div class="empty"><h3>${e.message}</h3></div>`); return; }
  const c = d.customer;
  const priceMap = new Map(d.prices.map(p => [p.product_id, p.price]));
  const active = prods.filter(p => !p.archived);
  const body = page(c.business_name, html`
    ${c.phone ? html`<a class="btn" href="tel:${c.phone}">${icon('phone')} Chiama</a><a class="btn" href="${waLink(c.phone)}" target="_blank" rel="noopener">${icon('wa')} WhatsApp</a>` : ''}
    <a class="btn" href="#/ordini?customer_id=${c.id}&status=">Ordini</a><a class="btn primary" href="#/nuovo-ordine?customer_id=${c.id}">Inserisci ordine</a>`, html`
    <div class="kpis">
      <div class="kpi"><b>${d.stats.ordini}</b><span>ordini</span></div>
      <div class="kpi"><b class="num">${euro(d.stats.imponibile)}</b><span>imponibile totale</span></div>
      <div class="kpi"><b>${d.stats.ultimo ? relDays(d.stats.ultimo) : '—'}</b><span>ultimo ordine</span></div>
      <div class="kpi ${d.stats.da_incassare ? 'alert' : ''}"><b class="num">${euro(d.stats.da_incassare)}</b><span>consegnato e non segnato pagato</span></div>
    </div>
    <div class="grid2" style="grid-template-columns:minmax(0,3fr) minmax(300px,2fr)">
      <section class="panel"><h2>Anagrafica e condizioni</h2><form id="cf3">${customerForm(c, zs)}
        <div class="actions"><button class="btn primary">Salva</button><button type="button" class="btn ghost" id="delc" style="color:var(--fig)">Elimina cliente</button></div></form></section>
      <div style="display:grid;gap:1.25rem;min-width:0">
        <section class="panel"><h2>Accessi all'app</h2>
          ${d.users.length ? html`<ul class="list-plain">${d.users.map(u => html`<li style="flex-wrap:wrap"><span><strong>${u.name || u.email}</strong><div class="muted small">${u.email}</div>
            <div class="small">${!u.active ? html`<span class="tag warn">disattivato</span>` : u.activated ? html`<span class="tag">attivo</span> <span class="muted">${u.last_login ? `ultimo accesso ${relDays(u.last_login)}` : ''}${u.push_devices ? ` · notifiche su ${u.push_devices} disp.` : ''}</span>` : html`<span class="tag warn">invito in attesa</span>`}</div></span>
            <span class="actions"><button class="btn small" data-inv="${u.id}">${u.activated ? 'Link nuova password' : 'Reinvia invito'}</button>
            <button class="btn small ghost" data-act="${u.id}" data-on="${u.active ? 0 : 1}">${u.active ? 'Disattiva' : 'Riattiva'}</button></span></li>`)}</ul>`
            : html`<p class="muted">Nessun accesso: il cliente può ordinare solo tramite voi.</p>`}
          <form id="nu" class="toolbar" style="margin-top:1rem"><input name="name" placeholder="Nome" style="flex:1;min-width:120px" aria-label="Nome"><input name="email" type="email" placeholder="Email" required style="flex:2;min-width:160px" aria-label="Email"><button class="btn">Aggiungi accesso</button></form>
        </section>
        <section class="panel"><h2>Listino personalizzato</h2>
          <p class="muted small">Prezzo base meno lo sconto del ${c.discount || 0}%. Scrivi un prezzo per fissarlo solo per questo cliente; lascia vuoto per usare quello calcolato.</p>
          <div style="max-height:480px;overflow:auto"><table class="items"><thead><tr><th>Prodotto</th><th class="num">Calcolato</th><th class="num">Prezzo fisso €</th></tr></thead>
          <tbody>${active.map(p => html`<tr><td>${p.name}<div class="muted small">${p.pack || ''}</div></td><td class="num">${euro(Math.round(p.price * (1 - (c.discount || 0) / 100)))}</td>
            <td class="num"><input style="width:90px" inputmode="decimal" data-cp="${p.id}" value="${centsToInput(priceMap.get(p.id))}" aria-label="Prezzo fisso ${p.name}"></td></tr>`)}</tbody></table></div>
          <button class="btn primary" id="savep" style="margin-top:1rem">Salva listino</button>
        </section>
      </div>
    </div>`);
  $('#cf3').onsubmit = e => { e.preventDefault(); withBusy(e.submitter, async () => { await api(`/api/admin/customers/${c.id}`, { method: 'PUT', body: customerPayload(e.target) }); toast('Cliente salvato'); viewCustomer({ id }); }); };
  $('#delc').onclick = async () => {
    if (!(await confirmDialog({ title: `Eliminare ${c.business_name}?`, text: 'Possibile solo se non ha ordini. In alternativa bloccalo.', confirm: 'Elimina', danger: true }))) return;
    try { await api(`/api/admin/customers/${c.id}`, { method: 'DELETE' }); toast('Cliente eliminato'); go('/clienti'); } catch (e) { showError(e); }
  };
  $('#nu').onsubmit = e => {
    e.preventDefault();
    withBusy(e.submitter, async () => { const r = await api(`/api/admin/customers/${c.id}/users`, { method: 'POST', body: formData(e.target) }); await viewCustomer({ id }); inviteModal(r.invite, c.phone, c.business_name); });
  };
  $('#savep').onclick = e => withBusy(e.target, async () => {
    const prices = $$('[data-cp]').map(i => ({ product_id: Number(i.dataset.cp), price: i.value.trim() ? toCents(i.value) : '' }));
    const r = await api(`/api/admin/customers/${c.id}/prices`, { method: 'PUT', body: { prices } });
    toast(`Listino salvato · ${r.count} prezzi fissi`);
  });
  body.addEventListener('click', e => {
    const inv = e.target.closest('[data-inv]');
    if (inv) withBusy(inv, async () => { const r = await api(`/api/admin/users/${inv.dataset.inv}/invite`, { method: 'POST' }); inviteModal(r.invite, c.phone, c.business_name); });
    const act = e.target.closest('[data-act]');
    if (act) withBusy(act, async () => { await api(`/api/admin/users/${act.dataset.act}`, { method: 'PATCH', body: { active: act.dataset.on === '1' } }); viewCustomer({ id }); });
  });
}

// ---------- zone ----------
async function viewZones() {
  S.zones = null;
  const zs = await zones();
  const body = page('Zone e consegne', html`<button class="btn primary" id="new">Nuova zona</button>`, html`
    <p class="muted">Per ogni zona scegli i giorni del giro e fino a quando il cliente può ordinare. Esempio: consegna mercoledì, 1 giorno di anticipo, entro le 17:00 → ordina entro martedì alle 17.</p>
    <div class="table-wrap"><table class="table"><thead><tr><th>Zona</th><th>Giorni di consegna</th><th>Ordina entro</th><th class="num">Costo consegna</th><th class="num">Clienti</th><th></th></tr></thead><tbody>
    ${zs.length ? zs.map(z => html`<tr><td><strong>${z.name}</strong></td><td>${daysLabel(z.delivery_days)}</td>
      <td>${z.lead_days ? `${z.lead_days} ${z.lead_days === 1 ? 'giorno' : 'giorni'} prima, ` : 'stesso giorno, '}ore ${z.cutoff_time}</td>
      <td class="num">${z.delivery_fee ? html`${euro(z.delivery_fee)}${z.free_over ? html`<div class="muted small">gratis da ${euro(z.free_over)}</div>` : ''}` : 'gratuita'}</td>
      <td class="num">${z.customers}</td><td><button class="btn small" data-edit="${z.id}">Modifica</button></td></tr>`)
      : html`<tr><td colspan="6"><div class="empty"><h3>Nessuna zona</h3><p>Senza zone i clienti possono ricevere dal lunedì al venerdì, ordinando entro le 18 del giorno prima.</p></div></td></tr>`}
    </tbody></table></div>`);
  body.onclick = e => { const b = e.target.closest('[data-edit]'); if (b) zoneModal(zs.find(z => z.id === Number(b.dataset.edit))); };
  $('#new').onclick = () => zoneModal(null);
}
function zoneModal(z) {
  const isNew = !z;
  z = z || { delivery_days: '1,2,3,4,5', cutoff_time: '17:00', lead_days: 1, delivery_fee: 0, free_over: 0, sort: 0 };
  const days = String(z.delivery_days).split(',').map(Number);
  const m = modal(html`<h2>${isNew ? 'Nuova zona' : z.name}</h2><form id="zf">
    <div class="field"><label for="zn">Nome</label><input id="zn" name="name" value="${z.name || ''}" placeholder="es. Scalea e Praia" required></div>
    <div class="field"><span class="small muted" style="display:block;margin-bottom:.3rem">Giorni di consegna</span><div class="daypick">${DAYS.map((d, i) => html`<label><input type="checkbox" name="d" value="${i + 1}" data-multi ${chk(days.includes(i + 1))}><span>${d}</span></label>`)}</div></div>
    <div class="field-row">
      <div class="field"><label for="zl">Giorni di anticipo</label><input id="zl" name="lead_days" type="number" min="0" max="14" value="${z.lead_days}"></div>
      <div class="field"><label for="zc">Entro le ore</label><input id="zc" name="cutoff_time" type="time" value="${z.cutoff_time}" required></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="zfee">Costo consegna € (IVA escl.)</label><input id="zfee" name="delivery_fee" inputmode="decimal" value="${centsToInput(z.delivery_fee)}"></div>
      <div class="field"><label for="zfo">Gratuita da € di imponibile</label><input id="zfo" name="free_over" inputmode="decimal" value="${z.free_over ? centsToInput(z.free_over) : ''}"></div>
      <div class="field"><label for="zs">Ordine nel giro</label><input id="zs" name="sort" type="number" value="${z.sort}"></div>
    </div>
    <div class="modal-actions">${!isNew ? html`<button type="button" class="btn ghost" id="del" style="margin-right:auto;color:var(--fig)">Elimina</button>` : ''}
      <button type="button" class="btn ghost" data-close>Annulla</button><button class="btn primary">Salva</button></div></form>`);
  m.el.querySelector('form').onsubmit = e => {
    e.preventDefault();
    withBusy(e.submitter, async () => {
      const b = formData(e.target);
      const payload = { ...b, delivery_days: (b.d || []).join(','), delivery_fee: toCents(b.delivery_fee || 0) || 0, free_over: toCents(b.free_over || 0) || 0 };
      await api(isNew ? '/api/admin/zones' : `/api/admin/zones/${z.id}`, { method: isNew ? 'POST' : 'PUT', body: payload });
      toast('Zona salvata'); m.close(); viewZones();
    });
  };
  m.el.querySelector('#del')?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: `Eliminare ${z.name}?`, text: 'I clienti della zona useranno le regole standard finché non ne scegli un\'altra.', confirm: 'Elimina', danger: true }))) return;
    await api(`/api/admin/zones/${z.id}`, { method: 'DELETE' }); m.close(); viewZones();
  });
}

// ---------- comunicazioni ----------
async function viewAnnouncements() {
  const { items } = await api('/api/admin/announcements');
  const today = todayIso();
  const body = page('Comunicazioni', '', html`
    <div class="grid2">
      <section class="panel"><h2>Nuova comunicazione</h2>
        <p class="muted small">Compare in cima al catalogo dei clienti. Con la notifica arriva anche sul telefono di chi l'ha attivata.</p>
        <form id="af">
          <div class="field"><label for="at">Titolo</label><input id="at" name="title" required placeholder="es. Arrivato il cedro candito nuovo raccolto"></div>
          <div class="field"><label for="ab">Testo</label><textarea id="ab" name="body"></textarea></div>
          <div class="field-row">
            <div class="field"><label for="ak">Tipo</label><select id="ak" name="kind"><option value="info">Informazione</option><option value="promo">Promozione</option><option value="avviso">Avviso importante</option></select></div>
            <div class="field"><label for="as">Dal</label><input id="as" type="date" name="starts_on" value="${today}"></div>
            <div class="field"><label for="ae">Al</label><input id="ae" type="date" name="ends_on"></div>
          </div>
          <label class="check"><input type="checkbox" name="push" checked> Invia anche come notifica push a tutti i clienti</label>
          <button class="btn primary">Pubblica</button>
        </form></section>
      <section class="panel"><h2>Pubblicate</h2>
        ${items.length ? html`<ul class="list-plain">${items.map(a => html`<li><span><strong>${a.title}</strong>
          <div class="muted small">${a.starts_on ? `dal ${dayShort(a.starts_on)}` : ''}${a.ends_on ? ` al ${dayShort(a.ends_on)}` : ''}${a.pushed ? ' · notificata' : ''}${a.ends_on && a.ends_on < today ? ' · scaduta' : ''}</div></span>
          <button class="btn small ghost" data-del="${a.id}">Elimina</button></li>`)}</ul>` : html`<p class="muted">Nessuna comunicazione. Usale per ferie, novità di stagione o offerte.</p>`}
      </section>
    </div>`);
  $('#af').onsubmit = e => {
    e.preventDefault();
    withBusy(e.submitter, async () => { await api('/api/admin/announcements', { method: 'POST', body: formData(e.target) }); toast('Comunicazione pubblicata'); viewAnnouncements(); });
  };
  body.onclick = async e => {
    const d = e.target.closest('[data-del]'); if (!d) return;
    if (await confirmDialog({ title: 'Eliminare la comunicazione?', confirm: 'Elimina', danger: true })) { await api(`/api/admin/announcements/${d.dataset.del}`, { method: 'DELETE' }); viewAnnouncements(); }
  };
}

// ---------- impostazioni ----------
async function viewSettings() {
  const [{ settings: s, integrations: ig }, pst] = await Promise.all([api('/api/admin/settings'), pushState(S.config.vapid_public_key).catch(() => 'unsupported')]);
  const okTag = (on, label) => html`<li><span>${label}</span><span class="tag ${on ? '' : 'warn'}">${on ? 'attivo' : 'non configurato'}</span></li>`;
  page('Impostazioni', '', html`
    <div class="grid2">
      <section class="panel"><h2>Ordini online</h2><form id="so">
        <label class="check"><input type="checkbox" name="orders_open" ${chk(s.orders_open !== '0')}> Accetta ordini dall'app</label>
        <div class="field"><label for="ocm">Messaggio quando gli ordini sono sospesi</label><input id="ocm" name="orders_closed_message" value="${s.orders_closed_message || ''}" placeholder="es. Chiusi per ferie fino al 26 agosto"></div>
        <div class="field"><label for="cd">Giorni di chiusura (niente consegne)</label><textarea id="cd" name="closed_dates" style="min-height:60px" placeholder="2026-12-25, 2026-12-26, 2027-01-01">${s.closed_dates || ''}</textarea><p class="hint">Date nel formato AAAA-MM-GG, separate da virgola.</p></div>
        <div class="field-row">
          <div class="field"><label for="mo">Ordine minimo € (IVA escl.)</label><input id="mo" name="min_order" inputmode="decimal" value="${centsToInput(Number(s.min_order || 0))}"></div>
          <div class="field"><label for="rh">Promemoria prima del limite (ore)</label><input id="rh" name="reminder_hours" type="number" min="0" max="24" value="${s.reminder_hours || 0}"><p class="hint">0 = nessun promemoria.</p></div>
        </div>
        <label class="check"><input type="checkbox" name="auto_confirm" ${chk(s.auto_confirm === '1')}> Conferma automaticamente gli ordini ricevuti</label>
        <div class="field"><label for="ot">Condizioni mostrate nel carrello</label><textarea id="ot" name="order_terms">${s.order_terms || ''}</textarea></div>
        <div class="field"><label for="one">Email che ricevono i nuovi ordini</label><input id="one" name="order_notify_emails" value="${s.order_notify_emails || ''}"><p class="hint">Separate da virgola.</p></div>
        <button class="btn primary">Salva</button></form></section>
      <div style="display:grid;gap:1.25rem;min-width:0">
        <section class="panel"><h2>Notifiche su questo dispositivo</h2>
          ${pst === 'on' ? html`<p>Attive: ricevi qui ogni nuovo ordine.</p><div class="actions"><button class="btn small" id="ptest">Invia una prova</button><button class="btn small ghost" id="poff">Disattiva</button></div>`
            : pst === 'off' ? html`<button class="btn primary" id="pon">Attiva le notifiche</button>` : html`<p class="muted">${pushHelp(pst)}</p>`}
        </section>
        <section class="panel"><h2>Accesso al pannello</h2>
          <p class="muted small">Si entra con una sola password, impostata su Cloudflare come secret <b>ADMIN_PASSWORD</b>. Se la cambi, tutti i dispositivi collegati al pannello vengono disconnessi.</p></section>
        <section class="panel"><h2>Servizi collegati</h2><ul class="list-plain">
          ${okTag(ig.push, 'Notifiche push')}${okTag(ig.email, 'Email (Resend)')}${okTag(ig.images, 'Foto prodotti (R2)')}${okTag(ig.cron, 'Promemoria automatici')}</ul></section>
      </div>
      <section class="panel"><h2>Dati aziendali</h2><form id="sc">
        <div class="field"><label for="sn">Nome</label><input id="sn" name="company_name" value="${s.company_name || ''}"></div>
        <div class="field"><label for="sa">Indirizzo</label><input id="sa" name="company_address" value="${s.company_address || ''}"></div>
        <div class="field-row">
          <div class="field"><label for="sp">Telefono</label><input id="sp" name="company_phone" value="${s.company_phone || ''}"></div>
          <div class="field"><label for="se">Email</label><input id="se" name="company_email" value="${s.company_email || ''}"></div>
          <div class="field"><label for="sv">P.IVA</label><input id="sv" name="company_vat" value="${s.company_vat || ''}"></div>
        </div>
        <div class="field"><label for="sl">Logo (URL)</label><input id="sl" name="logo_url" value="${s.logo_url || ''}"></div>
        <div class="field"><label for="sw">Sito web</label><input id="sw" name="site_url" value="${s.site_url || ''}"></div>
        <button class="btn primary">Salva</button></form></section>
    </div>`);
  $('#so').onsubmit = e => {
    e.preventDefault();
    withBusy(e.submitter, async () => {
      const b = formData(e.target);
      b.orders_open = b.orders_open ? '1' : '0'; b.auto_confirm = b.auto_confirm ? '1' : '0';
      b.min_order = String(toCents(b.min_order || 0) || 0);
      const bad = String(b.closed_dates).split(/[\s,;]+/).filter(Boolean).find(x => !/^\d{4}-\d{2}-\d{2}$/.test(x));
      if (bad) throw new Error(`Data non valida: ${bad}`);
      await api('/api/admin/settings', { method: 'PUT', body: b }); toast('Impostazioni salvate');
    });
  };
  $('#sc').onsubmit = e => { e.preventDefault(); withBusy(e.submitter, async () => { await api('/api/admin/settings', { method: 'PUT', body: formData(e.target) }); S.config = await api('/api/public/config'); toast('Dati salvati'); }); };
  $('#pon')?.addEventListener('click', e => withBusy(e.target, async () => { await enablePush(S.config.vapid_public_key); toast('Notifiche attivate'); pushBanner(); viewSettings(); }));
  $('#poff')?.addEventListener('click', e => withBusy(e.target, async () => { await disablePush(); toast('Notifiche disattivate'); viewSettings(); }));
  $('#ptest')?.addEventListener('click', e => withBusy(e.target, async () => { await api('/api/push/test', { method: 'POST' }); toast('Notifica di prova inviata'); }));
}

start();
