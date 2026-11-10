// Cloudflare Pages Functions: tutte le richieste /api/* passano da qui.
// La logica sta in src/ (la stessa usata da src/index.js se un domani si pubblica come Worker).
import { handleApi } from '../../src/api.js';

export const onRequest = context => handleApi({
  request: context.request,
  env: context.env,
  waitUntil: p => context.waitUntil(p),
});
