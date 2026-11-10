// Worker separato: ogni 30 minuti chiede al gestionale di inviare i promemoria "ordina entro il limite".
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetch(`${env.APP_URL}/api/cron/reminders`, {
      method: 'POST',
      headers: { 'x-cron-secret': env.CRON_SECRET },
    }).then(r => r.text()).then(t => console.log('promemoria', t)));
  },
};
