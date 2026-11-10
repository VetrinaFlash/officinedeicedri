// Rigenera src/lib/schema.js dopo aver modificato le migrazioni o il seed: node scripts/build-schema.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const split = f => readFileSync(f, 'utf8').split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
  .split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
const migrations = readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()
  .map(name => ({ name, statements: split(`migrations/${name}`) }));
writeFileSync('src/lib/schema.js',
  '// Generato da migrations/*.sql e seed.sql (node scripts/build-schema.mjs).\n// Al primo avvio il database viene creato e popolato da solo.\n' +
  `export const MIGRATIONS = ${JSON.stringify(migrations, null, 2)};\nexport const SEED = ${JSON.stringify(split('seed.sql'), null, 2)};\n`);
console.log(`${migrations.length} migrazioni, schema.js aggiornato`);
