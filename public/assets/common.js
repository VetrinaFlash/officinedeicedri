// Utility condivise tra app cliente e pannello admin.

// ---------- template sicuri ----------
export class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Raw(s ?? '');
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s; if (i < vals.length) out += render(vals[i]); });
  return new Raw(out);
}
export const mount = (el, tpl) => { el.innerHTML = tpl instanceof Raw ? tpl.s : String(tpl); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- API ----------
export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); }
  catch { throw new ApiError(0, 'Connessione assente. Controlla la rete e riprova.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, data.error || `Errore ${res.status}`);
    if (res.status === 401) window.dispatchEvent(new CustomEvent('auth:expired'));
    throw err;
  }
  return data;
}

// ---------- formati ----------
const eurFmt = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
export const euro = cents => eurFmt.format((cents || 0) / 100);
export const toCents = v => {
  let t = String(v ?? '').trim().replace(/[€\s]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  if (t === '') return 0;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
export const centsToInput = c => (c === null || c === undefined || c === '') ? '' : (c / 100).toFixed(2).replace('.', ',');
export const qty = q => Number(q).toLocaleString('it-IT', { maximumFractionDigits: 3 });
const parseIso = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const dayLong = iso => iso ? new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(parseIso(iso)) : '—';
export const capFirst = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
export const dayShort = iso => iso ? new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(parseIso(iso)) : '—';
export const dateTime = s => {
  if (!s) return '';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }).format(d);
};
export const relDays = s => {
  if (!s) return 'mai';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  const days = Math.floor((Date.now() - d) / 864e5);
  return days <= 0 ? 'oggi' : days === 1 ? 'ieri' : `${days} giorni fa`;
};
export const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
export const addDays = (iso, n) => { const d = parseIso(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export const STATUS_LABEL = {
  nuovo: 'Ricevuto', confermato: 'Confermato', in_preparazione: 'In preparazione',
  in_consegna: 'In consegna', consegnato: 'Consegnato', annullato: 'Annullato',
};
export const STATUS_FLOW = ['nuovo', 'confermato', 'in_preparazione', 'in_consegna', 'consegnato'];
export const statusPill = s => html`<span class="pill st-${s}">${STATUS_LABEL[s] || s}</span>`;

// ---------- feedback ----------
let toastTimer;
export function toast(message, kind = 'ok') {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.className = `toast show ${kind}`;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 5000 : 2800);
}
export const showError = e => toast(e?.message || 'Qualcosa è andato storto.', 'error');

export function modal(content, { wide = false, onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${content instanceof Raw ? content.s : content}</div>`;
  const prevFocus = document.activeElement;
  const close = () => {
    wrap.classList.add('closing');
    setTimeout(() => wrap.remove(), 160);
    document.removeEventListener('keydown', onKey);
    onClose?.();
    prevFocus?.focus?.();
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
  wrap.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(wrap);
  const first = wrap.querySelector('input:not([type=hidden]), select, textarea, button:not([data-close])');
  setTimeout(() => first?.focus(), 30);
  return { el: wrap.firstElementChild, close };
}

export function confirmDialog({ title, text, confirm = 'Conferma', danger = false }) {
  return new Promise(resolve => {
    let done = false;
    const m = modal(html`
      <h2>${title}</h2>${text ? html`<p class="muted">${text}</p>` : ''}
      <div class="modal-actions">
        <button class="btn ghost" data-close>Annulla</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${confirm}</button>
      </div>`, { onClose: () => { if (!done) resolve(false); } });
    m.el.querySelector('[data-ok]').onclick = () => { done = true; resolve(true); m.close(); };
  });
}

export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') {
      if (el.dataset.multi !== undefined) { (out[el.name] ||= []); if (el.checked) out[el.name].push(el.value); }
      else out[el.name] = el.checked;
    } else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}

export async function withBusy(btn, fn) {
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  try { return await fn(); }
  catch (e) { showError(e); }
  finally { if (btn) { btn.disabled = false; btn.classList.remove('busy'); } }
}

export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage non disponibile */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* */ } },
};

// ---------- router hash ----------
export function router(routes, notFound) {
  const run = () => {
    const path = (location.hash.replace(/^#/, '') || '/').split('?')[0] || '/';
    for (const [pattern, view] of routes) {
      const keys = [];
      const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
      const m = path.match(re);
      if (m) { view(Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]))); return; }
    }
    notFound?.(path);
  };
  window.addEventListener('hashchange', run);
  return run;
}
export const go = path => { if (location.hash !== '#' + path) location.hash = path; else window.dispatchEvent(new HashChangeEvent('hashchange')); };

// ---------- push ----------
const urlB64ToUint8 = s => { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { return null; }
}
/** Stato delle notifiche: 'unsupported' | 'ios-install' | 'denied' | 'on' | 'off' | 'disabled' */
export async function pushState(vapidKey) {
  if (!vapidKey) return 'disabled';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIos() && !isStandalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'on' : 'off';
}
export async function enablePush(vapidKey) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permesso negato: puoi riattivarlo dalle impostazioni del browser.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(vapidKey) });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  return sub;
}
export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
}
// ri-sincronizza la sottoscrizione (es. dopo login con altro utente sullo stesso dispositivo)
export async function syncPush() {
  try {
    if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  } catch { /* */ }
}

export function pushHelp(state) {
  return {
    'ios-install': 'Su iPhone le notifiche funzionano solo dall\'app installata: tocca Condividi e poi "Aggiungi alla schermata Home", quindi apri l\'app da lì.',
    denied: 'Le notifiche sono bloccate per questo sito. Riattivale dalle impostazioni del browser (icona del lucchetto accanto all\'indirizzo).',
    unsupported: 'Questo browser non supporta le notifiche. Prova con Chrome, Edge, Firefox o Safari aggiornati.',
    disabled: 'Le notifiche push non sono ancora configurate sul server.',
  }[state] || '';
}

// ---------- campanella notifiche ----------
export function bell(button, { onOpen } = {}) {
  const refresh = async () => {
    try {
      const { unread } = await api('/api/notifications');
      button.querySelector('.badge')?.remove();
      if (unread) button.insertAdjacentHTML('beforeend', `<span class="badge">${unread > 9 ? '9+' : unread}</span>`);
    } catch { /* */ }
  };
  button.onclick = async () => {
    const { items } = await api('/api/notifications');
    const m = modal(html`
      <h2>Notifiche</h2>
      ${items.length ? html`<ul class="notif-list">${items.map(n => html`
        <li class="${n.read ? '' : 'unread'}"><a href="${n.url || '#'}" data-close>
          <strong>${n.title}</strong>${n.body ? html`<span>${n.body}</span>` : ''}<time>${dateTime(n.created_at)}</time></a></li>`)}</ul>`
        : html`<p class="muted">Qui trovi gli aggiornamenti sugli ordini.</p>`}
      <div class="modal-actions"><button class="btn ghost" data-close>Chiudi</button></div>`);
    void m;
    await api('/api/notifications/read', { method: 'POST' }).catch(() => {});
    refresh();
    onOpen?.();
  };
  refresh();
  navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'push') { refresh(); window.dispatchEvent(new CustomEvent('push:received', { detail: e.data.payload })); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  return refresh;
}

export const icon = name => raw({
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z M10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z" fill="var(--star-fill, none)" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h3l1.5 4-2 1.5a11 11 0 0 0 7 7l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  truck: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h11v10H3zM14 9h4l3 3.5V16h-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="7" cy="17.5" r="1.8" fill="var(--bg,#fff)" stroke="currentColor" stroke-width="1.6"/><circle cx="17" cy="17.5" r="1.8" fill="var(--bg,#fff)" stroke="currentColor" stroke-width="1.6"/></svg>',
  print: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V4h10v5M7 17H4v-7h16v7h-3M7 14h10v6H7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  wa: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1.2-3.6A8 8 0 1 1 8 19.2L4 20Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 9c0 3 2.5 6 6 6l1-1.5-2-1-1 .8c-1-.4-2-1.4-2.3-2.3l.8-1-1-2L9 9Z" fill="currentColor"/></svg>',
}[name] || '');

export const waLink = (phone, text) => {
  let p = String(phone || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1); else if (p.startsWith('00')) p = p.slice(2); else if (p) p = '39' + p;
  return `https://wa.me/${p}${text ? '?text=' + encodeURIComponent(text) : ''}`;
};
