// Email transazionali via Resend (opzionali: senza RESEND_API_KEY non parte nulla).
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function emailLayout({ company, title, intro, rows = [], button, footer }) {
  const tr = rows.map(r => `<tr><td style="padding:6px 0;color:#55605a">${escape(r[0])}</td><td style="padding:6px 0;text-align:right;color:#1c2420">${escape(r[1])}</td></tr>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#f7f8ee;font-family:Helvetica,Arial,sans-serif;color:#1c2420">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
  <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:6px;overflow:hidden">
  <tr><td style="background:#1f3b2d;color:#e8d44d;padding:20px 28px;font-size:18px;font-weight:bold">${escape(company)}</td></tr>
  <tr><td style="padding:28px">
    <h1 style="font-size:22px;margin:0 0 12px;font-weight:normal">${escape(title)}</h1>
    <p style="line-height:1.55;margin:0 0 16px">${escape(intro)}</p>
    ${tr ? `<table width="100%" style="border-top:1px solid #e3e6d6;margin:8px 0 16px;font-size:14px">${tr}</table>` : ''}
    ${button ? `<a href="${escape(button.url)}" style="display:inline-block;background:#1f3b2d;color:#fff;text-decoration:none;padding:12px 20px;border-radius:4px">${escape(button.label)}</a>` : ''}
    ${footer ? `<p style="font-size:13px;color:#6b6f66;margin-top:24px;line-height:1.5">${escape(footer)}</p>` : ''}
  </td></tr></table></td></tr></table></body></html>`;
}

export async function sendEmail(env, { to, subject, html, replyTo }) {
  if (!env.RESEND_API_KEY || !to || (Array.isArray(to) && !to.length)) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM || 'Ordini <onboarding@resend.dev>',
        to: Array.isArray(to) ? to : [to],
        subject, html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
