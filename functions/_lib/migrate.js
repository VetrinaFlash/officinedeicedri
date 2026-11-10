import { MIGRATIONS, SEED } from './schema.js';

// Applica le migrazioni mancanti (compatibile con "wrangler d1 migrations apply").
let ready = null;
export function ensureSchema(env) {
  if (!ready) ready = run(env).catch(e => { ready = null; throw e; });
  return ready;
}
async function run(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`).run();
  const { results } = await env.DB.prepare('SELECT name FROM d1_migrations').all();
  const done = new Set(results.map(r => r.name));
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    const first = m.name === MIGRATIONS[0].name;
    await env.DB.batch([
      ...m.statements.map(s => env.DB.prepare(s)),
      ...(first ? SEED.map(s => env.DB.prepare(s)) : []),
      env.DB.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(m.name),
    ]);
  }
}
