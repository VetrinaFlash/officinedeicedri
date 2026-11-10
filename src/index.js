// Worker: API su /api/*, tutto il resto sono file statici (app clienti e pannello).
import { handleApi, runReminders } from './api.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi({ request, env, waitUntil: p => ctx.waitUntil(p) });
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env).then(n => console.log(`promemoria inviati: ${n}`)));
  },
};
