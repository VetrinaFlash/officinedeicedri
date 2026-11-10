// Calcola l'impronta per ADMIN_PASSWORD_HASH: node scripts/hash-password.mjs "la-tua-password"
const pw = process.argv[2];
if (!pw || pw.length < 12) { console.error('Usa una password di almeno 12 caratteri.'); process.exit(1); }
const b64u = b => Buffer.from(b).toString('base64url');
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
console.log(`ADMIN_PASSWORD_HASH = "pbkdf2$100000$${b64u(salt)}$${b64u(bits)}"`);
