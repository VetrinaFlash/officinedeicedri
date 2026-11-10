-- Officine dei Cedri · Gestionale ordini Ho.Re.Ca.
-- Importi in centesimi di euro, IVA esclusa.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  delivery_days TEXT NOT NULL DEFAULT '1,2,3,4,5', -- 1=lun ... 7=dom
  cutoff_time TEXT NOT NULL DEFAULT '18:00',
  lead_days INTEGER NOT NULL DEFAULT 1,           -- giorni di anticipo rispetto alla consegna
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  free_over INTEGER NOT NULL DEFAULT 0,           -- consegna gratuita sopra questo imponibile (0 = sempre applicata se fee > 0)
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  vat TEXT,
  tax_code TEXT,
  sdi TEXT,
  pec TEXT,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  province TEXT,
  zip TEXT,
  delivery_address TEXT,
  delivery_notes TEXT,
  zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- agente di riferimento
  discount REAL NOT NULL DEFAULT 0,               -- sconto % su listino base
  payment_terms TEXT,
  min_order INTEGER,                              -- null = usa impostazione generale
  blocked INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin','cliente','agente')),
  phone TEXT,
  commission REAL NOT NULL DEFAULT 0,             -- provvigione % (solo agenti)
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 1,
  last_login TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_customer ON users(customer_id);
CREATE INDEX idx_customers_agent ON customers(agent_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,                          -- invite | reset
  expires_at TEXT NOT NULL
);

CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_login_attempts ON login_attempts(email, created_at);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT,
  name TEXT NOT NULL,
  description TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  unit TEXT NOT NULL DEFAULT 'pz',                -- pz, kg, cartone, bottiglia...
  pack TEXT,                                      -- es. "vasetto 250 g", "cartone da 6"
  price INTEGER NOT NULL DEFAULT 0,               -- listino base, centesimi IVA esclusa
  vat_rate REAL NOT NULL DEFAULT 10,
  min_qty REAL NOT NULL DEFAULT 1,
  step_qty REAL NOT NULL DEFAULT 1,
  stock REAL,                                     -- null = non gestita
  available INTEGER NOT NULL DEFAULT 1,
  featured INTEGER NOT NULL DEFAULT 0,
  image_key TEXT,
  image_url TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_products_cat ON products(category_id);

CREATE TABLE customer_prices (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price INTEGER NOT NULL,
  PRIMARY KEY (customer_id, product_id)
);

-- prodotti visibili solo a certi clienti (se un prodotto ha righe qui, è riservato)
CREATE TABLE product_visibility (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, customer_id)
);

CREATE TABLE favorites (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (customer_id, product_id)
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- agente del cliente al momento dell'ordine
  commission_rate REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'app',             -- app | telefono | whatsapp | email | agente
  status TEXT NOT NULL DEFAULT 'nuovo',           -- nuovo, confermato, in_preparazione, in_consegna, consegnato, annullato
  delivery_date TEXT,
  notes TEXT,
  admin_notes TEXT,
  subtotal INTEGER NOT NULL DEFAULT 0,
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  vat_total INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  invoice_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (year, seq)
);
CREATE INDEX idx_orders_customer ON orders(customer_id, created_at);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_delivery ON orders(delivery_date);
CREATE INDEX idx_orders_agent ON orders(agent_id, created_at);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  sku TEXT,
  name TEXT NOT NULL,
  unit TEXT,
  pack TEXT,
  qty REAL NOT NULL,
  price INTEGER NOT NULL,
  vat_rate REAL NOT NULL,
  line_total INTEGER NOT NULL,
  list_price INTEGER,                             -- prezzo che avrebbe pagato senza promozione
  promo_id INTEGER
);
CREATE INDEX idx_items_order ON order_items(order_id);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                             -- status | edit | note
  status TEXT,
  note TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_order ON order_events(order_id);

CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read);

CREATE TABLE announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT,
  kind TEXT NOT NULL DEFAULT 'info',              -- info | promo | avviso
  starts_on TEXT,
  ends_on TEXT,
  target TEXT NOT NULL DEFAULT 'tutti',           -- tutti | zona | agente | cliente
  zone_id INTEGER REFERENCES zones(id) ON DELETE CASCADE,
  agent_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  pushed INTEGER NOT NULL DEFAULT 0,
  push_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- promozioni: prezzo speciale o sconto % su un prodotto, per un periodo, per tutti o per una zona
CREATE TABLE promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title TEXT,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'sconto',            -- sconto (%) | prezzo (centesimi IVA escl.)
  value REAL NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  zone_id INTEGER REFERENCES zones(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 1,
  pushed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_promotions_product ON promotions(product_id, starts_on, ends_on);

CREATE TABLE reminder_log (
  customer_id INTEGER NOT NULL,
  delivery_date TEXT NOT NULL,
  PRIMARY KEY (customer_id, delivery_date)
);

INSERT INTO settings (key, value) VALUES
 ('company_name', 'Officine dei Cedri'),
 ('company_address', 'Via dell''Arco Piccolo, 18 · 87020 Santa Maria del Cedro (CS)'),
 ('company_phone', '+39 0985 5543'),
 ('company_email', 'info@officinedeicedri.it'),
 ('company_vat', '03212450781'),
 ('logo_url', 'https://officinedeicedri.it/wp-content/uploads/2017/03/logo_alto.png'),
 ('site_url', 'https://officinedeicedri.it'),
 ('order_notify_emails', 'info@officinedeicedri.it'),
 ('min_order', '0'),
 ('closed_dates', ''),
 ('orders_open', '1'),
 ('orders_closed_message', ''),
 ('reminder_hours', '3'),
 ('auto_confirm', '0'),
 ('show_prices_with_vat', '0'),
 ('order_terms', 'I prezzi indicati sono IVA esclusa. Il fornitore può modificare quantità e prodotti in base alla disponibilità e ti avviserà.');
