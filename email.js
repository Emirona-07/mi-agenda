'use strict';
const nodemailer = require('nodemailer');
const { Resend } = require('resend');

/* ─── Providers ───────────────────────────────────────────────────── */

// Resend (preferido en Railway — usa HTTPS, no SMTP)
function getResendClient() {
  const key = process.env.RESEND_API_KEY || '';
  return key ? new Resend(key) : null;
}

// SMTP fallback (nodemailer)
function buildTransporter(settings) {
  const host = settings?.email_host || '';
  const port = parseInt(settings?.email_port || '587');
  const user = settings?.email_user || process.env.GMAIL_USER || '';
  const pass = settings?.email_pass || process.env.GMAIL_APP_PASSWORD || '';
  if (!user || !pass) return null;
  if (!host || host === 'smtp.gmail.com') {
    return nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass },
    });
  }
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

function fromAddress(settings) {
  const name = settings?.business_name || 'Mi Negocio';
  // Resend requiere dominio verificado; si no hay, usa su dirección de onboarding
  const resendKey = process.env.RESEND_API_KEY || '';
  const resendFrom = process.env.RESEND_FROM || '';
  if (resendKey) {
    const addr = resendFrom || `onboarding@resend.dev`;
    return `${name} <${addr}>`;
  }
  const addr = settings?.email_from || settings?.email_user || process.env.GMAIL_USER || '';
  return addr ? `${name} <${addr}>` : name;
}

/* ─── HTML templates ──────────────────────────────────────────────── */

function btnMP(url, label) {
  return `<a href="${url}" style="display:inline-block;background:#009ee3;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:.95rem">${label}</a>`;
}

function fmtPeso(n) { return '$ ' + Number(n).toLocaleString('es-UY'); }

function confirmacionHTML({ name, bizName, serviceName, profName, date, time, price, deposit, mp_url_deposit, mp_url_full, payment_method, bank_account }) {
  const hasMP = mp_url_deposit || mp_url_full;
  const resto = (price || 0) - (deposit || 0);

  const paySection = hasMP ? `
    <div style="margin-top:20px">
      <p style="font-weight:600;margin:0 0 12px;color:#333">Opciones de pago:</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${mp_url_deposit && deposit ? `<div style="margin-bottom:8px">${btnMP(mp_url_deposit, `Pagar seña ${fmtPeso(deposit)}`)}</div>` : ''}
        ${mp_url_full && price ? `<div style="margin-bottom:8px">${btnMP(mp_url_full, `Pagar total ${fmtPeso(price)}`)}</div>` : ''}
      </div>
      ${deposit && resto > 0 ? `<p style="font-size:.82rem;color:#888;margin:8px 0 0">Si pagás la seña, el saldo restante de ${fmtPeso(resto)} se abona el día del turno.</p>` : ''}
    </div>` : payment_method === 'transfer' && bank_account ? `
    <div style="margin-top:20px;background:#f0f7f3;border-left:4px solid #2d6a4f;border-radius:4px;padding:14px">
      <p style="font-weight:600;margin:0 0 8px;color:#2d6a4f">🏦 Datos para transferencia:</p>
      <p style="font-size:.9rem;color:#333;margin:0;line-height:1.8;white-space:pre-line">${bank_account}</p>
    </div>` : '';

  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px">
<div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
  <div style="background:#2d6a4f;padding:24px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:22px">✅ Reserva confirmada</h1>
  </div>
  <div style="padding:24px">
    <p style="margin:0 0 12px">Hola <strong>${name}</strong>,</p>
    <p style="margin:0 0 20px;color:#555">Tu reserva en <strong>${bizName}</strong> está confirmada.</p>
    <div style="background:#f5faf7;border-left:4px solid #2d6a4f;border-radius:4px;padding:16px;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem;width:40%">Servicio</td><td style="padding:5px 0;font-weight:600">${serviceName}</td></tr>
        ${profName ? `<tr><td style="padding:5px 0;color:#777;font-size:.88rem">Profesional</td><td style="padding:5px 0;font-weight:600">${profName}</td></tr>` : ''}
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">Fecha</td><td style="padding:5px 0;font-weight:600">${date}</td></tr>
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">Hora</td><td style="padding:5px 0;font-weight:600">${time}</td></tr>
        ${price ? `<tr><td style="padding:5px 0;color:#777;font-size:.88rem">Precio total</td><td style="padding:5px 0;font-weight:600">${fmtPeso(price)}</td></tr>` : ''}
        ${deposit ? `<tr><td style="padding:5px 0;color:#777;font-size:.88rem">Seña</td><td style="padding:5px 0;font-weight:600">${fmtPeso(deposit)}</td></tr>` : ''}
      </table>
    </div>
    ${paySection}
    <p style="font-size:.85rem;color:#999;margin:${hasMP ? '16px' : '0'} 0 0">Si necesitás cancelar, escribinos con anticipación.</p>
  </div>
  <div style="background:#f9f9f9;padding:14px;text-align:center;font-size:.8rem;color:#bbb">${bizName}</div>
</div></body></html>`;
}

function pagoConfirmadoHTML({ name, bizName, serviceName, date, time, amountPaid, payType, totalPrice, mp_url_full }) {
  const resto = totalPrice - amountPaid;
  const esSena = payType === 'deposit';

  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px">
<div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
  <div style="background:#1a5c38;padding:24px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:22px">💳 Pago recibido</h1>
  </div>
  <div style="padding:24px">
    <p style="margin:0 0 12px">Hola <strong>${name}</strong>,</p>
    <p style="margin:0 0 20px;color:#555">Recibimos tu pago para <strong>${bizName}</strong>.</p>
    <div style="background:#f5faf7;border-left:4px solid #1a5c38;border-radius:4px;padding:16px;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem;width:40%">Servicio</td><td style="padding:5px 0;font-weight:600">${serviceName}</td></tr>
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">Fecha</td><td style="padding:5px 0;font-weight:600">${date}</td></tr>
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">Hora</td><td style="padding:5px 0;font-weight:600">${time}</td></tr>
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">${esSena ? 'Seña abonada' : 'Total abonado'}</td><td style="padding:5px 0;font-weight:600;color:#1a5c38">${fmtPeso(amountPaid)}</td></tr>
        ${esSena && resto > 0 ? `<tr><td style="padding:5px 0;color:#777;font-size:.88rem">Saldo restante</td><td style="padding:5px 0;font-weight:600;color:#e07b00">${fmtPeso(resto)}</td></tr>` : ''}
      </table>
    </div>
    ${esSena && resto > 0 && mp_url_full ? `
    <div style="text-align:center;margin-bottom:20px">
      <p style="color:#555;margin:0 0 12px">¿Querés pagar el saldo ahora?</p>
      ${btnMP(mp_url_full, `Pagar saldo restante ${fmtPeso(resto)}`)}
    </div>` : ''}
    <p style="font-size:.85rem;color:#999;margin:0">¡Gracias! Te esperamos el ${date} a las ${time}.</p>
  </div>
  <div style="background:#f9f9f9;padding:14px;text-align:center;font-size:.8rem;color:#bbb">${bizName}</div>
</div></body></html>`;
}

function nuevaReservaHTML({ bookingId, serviceName, clientName, phone, email, date, time }) {
  const row = (label, value) => value
    ? `<tr><td style="padding:5px 0;color:#777;font-size:.88rem;width:40%">${label}</td><td style="padding:5px 0;font-weight:600">${value}</td></tr>`
    : '';
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px">
<div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
  <div style="background:#1a5c38;padding:24px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:22px">📅 Nueva reserva</h1>
  </div>
  <div style="padding:24px">
    <div style="background:#f5faf7;border-left:4px solid #1a5c38;border-radius:4px;padding:16px">
      <table style="width:100%;border-collapse:collapse">
        ${row('Nº de reserva', `#${bookingId}`)}
        ${row('Servicio', serviceName)}
        ${row('Cliente', clientName)}
        ${row('Teléfono', phone)}
        ${row('Email', email)}
        ${row('Fecha', date)}
        ${row('Hora', time)}
      </table>
    </div>
  </div>
</div></body></html>`;
}

function reminderHTML({ name, bizName, serviceName, profName, date, time, bookingId }) {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px">
<div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
  <div style="background:#e07b00;padding:24px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:22px">🔔 Recordatorio de tu turno</h1>
  </div>
  <div style="padding:24px">
    <p style="margin:0 0 12px">Hola <strong>${name}</strong>,</p>
    <p style="margin:0 0 20px;color:#555">Te recordamos que tenés un turno en <strong>${bizName}</strong> mañana.</p>
    <div style="background:#fffaf0;border-left:4px solid #e07b00;border-radius:4px;padding:16px;margin-bottom:20px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem;width:40%">Servicio</td><td style="padding:5px 0;font-weight:600">${serviceName}</td></tr>
        ${profName ? `<tr><td style="padding:5px 0;color:#777;font-size:.88rem">Profesional</td><td style="padding:5px 0;font-weight:600">${profName}</td></tr>` : ''}
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">Fecha</td><td style="padding:5px 0;font-weight:600">${date}</td></tr>
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">Hora</td><td style="padding:5px 0;font-weight:600">${time}</td></tr>
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">Nº de reserva</td><td style="padding:5px 0;font-weight:600">#${bookingId}</td></tr>
      </table>
    </div>
    <p style="font-size:.85rem;color:#999;margin:0">Si necesitás cancelar, escribinos con anticipación.</p>
  </div>
  <div style="background:#f9f9f9;padding:14px;text-align:center;font-size:.8rem;color:#bbb">${bizName}</div>
</div></body></html>`;
}

function weeklySummaryHTML({ bizName, bookings, weekLabel }) {
  const rows = bookings.map(b =>
    `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">#${b.id}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${b.date} ${b.time}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${b.client_name || ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${b.service_name || ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${b.status || ''}</td>
    </tr>`
  ).join('');
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px">
<div style="max-width:620px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
  <div style="background:#2d6a4f;padding:24px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:20px">📊 Resumen semanal — ${weekLabel}</h1>
    <p style="color:#a8d5be;margin:6px 0 0;font-size:.9rem">${bizName}</p>
  </div>
  <div style="padding:24px">
    <p style="color:#555;margin:0 0 16px">Estas son las reservas de la semana pasada:</p>
    <table style="width:100%;border-collapse:collapse;font-size:.88rem">
      <thead>
        <tr style="background:#f5faf7">
          <th style="padding:8px;text-align:left;color:#555">#</th>
          <th style="padding:8px;text-align:left;color:#555">Fecha/Hora</th>
          <th style="padding:8px;text-align:left;color:#555">Cliente</th>
          <th style="padding:8px;text-align:left;color:#555">Servicio</th>
          <th style="padding:8px;text-align:left;color:#555">Estado</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="5" style="padding:12px;text-align:center;color:#aaa">Sin reservas esta semana</td></tr>'}</tbody>
    </table>
    <p style="margin:16px 0 0;font-size:.85rem;color:#777">Total: <strong>${bookings.length}</strong> reserva(s)</p>
  </div>
  <div style="background:#f9f9f9;padding:14px;text-align:center;font-size:.8rem;color:#bbb">${bizName}</div>
</div></body></html>`;
}

/* ─── Generic send helper ─────────────────────────────────────────── */

async function sendMail({ to, subject, html }, settings) {
  if (!to) return { ok: false, reason: 'sin_destinatario' };
  const from = fromAddress(settings);
  const replyTo = process.env.REPLY_TO_EMAIL || settings?.owner_email || '';

  // — Resend (HTTPS, funciona en Railway) —
  const resend = getResendClient();
  if (resend) {
    try {
      const payload = { from, to, subject, html };
      if (replyTo) payload.reply_to = replyTo;
      const { error } = await resend.emails.send(payload);
      if (error) throw new Error(error.message || JSON.stringify(error));
      console.log(`[email/resend] ✓ Enviado a ${to}: ${subject}`);
      return { ok: true };
    } catch (e) {
      console.error(`[email/resend] Error enviando a ${to}:`, e.message);
      return { ok: false, reason: e.message };
    }
  }

  // — SMTP fallback (nodemailer) —
  const t = buildTransporter(settings);
  if (!t) {
    console.error('[email] Sin configuración: seteá RESEND_API_KEY o credenciales SMTP');
    return { ok: false, reason: 'sin_configuracion_email' };
  }
  try {
    await t.sendMail({ from, to, subject, html });
    console.log(`[email/smtp] ✓ Enviado a ${to}: ${subject}`);
    return { ok: true };
  } catch (e) {
    console.error(`[email/smtp] Error enviando a ${to}:`, e.message);
    return { ok: false, reason: e.message };
  }
}

/* ─── Public send functions ───────────────────────────────────────── */

async function sendConfirmation(toEmail, data, settings) {
  const bizName = settings?.business_name || 'Mi Negocio';
  console.log(`[email] Enviando confirmación a ${toEmail}`);
  return sendMail({
    to: toEmail,
    subject: `✅ Reserva confirmada en ${bizName} — ${data.serviceName}`,
    html: confirmacionHTML({ ...data, bizName }),
  }, settings);
}

async function sendPaymentConfirmation(toEmail, data, settings) {
  const bizName = settings?.business_name || 'Mi Negocio';
  const tipo = data.payType === 'full' ? 'total' : 'seña';
  console.log(`[email] Enviando confirmación de pago (${tipo}) a ${toEmail}`);
  return sendMail({
    to: toEmail,
    subject: `💳 Pago recibido — ${bizName}`,
    html: pagoConfirmadoHTML({ ...data, bizName }),
  }, settings);
}

async function sendOwnerNotification(toEmail, data, settings) {
  const bizName = settings?.business_name || 'Mi Negocio';
  console.log(`[email] Enviando notificación al dueño a ${toEmail}`);
  return sendMail({
    to: toEmail,
    subject: `📅 Nueva reserva #${data.bookingId} — ${data.clientName}`,
    html: nuevaReservaHTML(data),
  }, settings);
}

async function sendReminder(booking, settings) {
  const toEmail = booking.client_email || '';
  if (!toEmail) return { ok: false, reason: 'sin_email_cliente' };
  // Accept pre-formatted date (from cron) or raw YYYY-MM-DD
  const displayDate = booking.date_formatted || booking.date || '';
  const bizName = settings?.business_name || booking.business_name || 'Mi Negocio';
  console.log(`[email] Enviando recordatorio a ${toEmail}`);
  return sendMail({
    to: toEmail,
    subject: `🔔 Recordatorio de tu turno en ${bizName} — mañana ${booking.time}`,
    html: reminderHTML({
      name: booking.client_name || '',
      bizName,
      serviceName: booking.service_name || '',
      profName: booking.prof_name || '',
      date: displayDate,
      time: booking.time,
      bookingId: String(booking.id),
    }),
  }, settings);
}

async function sendWeeklySummary(bookings, toEmail, settings) {
  if (!toEmail) return { ok: false, reason: 'sin_email_dueño' };
  const bizName = settings?.business_name || 'Mi Negocio';
  const now = new Date();
  const weekLabel = now.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  console.log(`[email] Enviando resumen semanal a ${toEmail}`);
  return sendMail({
    to: toEmail,
    subject: `📊 Resumen semanal — ${bizName}`,
    html: weeklySummaryHTML({ bizName, bookings, weekLabel }),
  }, settings);
}

/* ─── Admin helpers ───────────────────────────────────────────────── */

async function testConnection(settings) {
  // Probar Resend si está configurado
  const resend = getResendClient();
  if (resend) {
    try {
      // Resend no tiene verify() — enviamos a la dirección del owner como test
      const to = settings?.owner_email || process.env.ADMIN_EMAIL || '';
      if (!to) return { ok: false, reason: 'Configurá owner_email para probar Resend' };
      const { error } = await resend.emails.send({
        from: fromAddress(settings),
        to,
        subject: '✅ Test de conexión — Mi Piel',
        html: '<p>La configuración de email funciona correctamente.</p>',
      });
      if (error) throw new Error(error.message || JSON.stringify(error));
      return { ok: true, provider: 'resend' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
  // Fallback SMTP
  const t = buildTransporter(settings);
  if (!t) return { ok: false, reason: 'Seteá RESEND_API_KEY en Railway o credenciales SMTP' };
  try {
    await t.verify();
    return { ok: true, provider: 'smtp' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function getStatus(settings) {
  if (process.env.RESEND_API_KEY) return 'configured';
  const user = settings?.email_user || process.env.GMAIL_USER || '';
  const pass = settings?.email_pass || process.env.GMAIL_APP_PASSWORD || '';
  return user && pass ? 'configured' : 'not_configured';
}

async function sendReviewRequest({ client_name, client_email, service_name, review_url, business_name }) {
  const biz = business_name || 'Mi Piel';
  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Inter,sans-serif">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e8e8e8">
    <div style="background:#2d6a4f;padding:28px 32px;text-align:center">
      <h1 style="color:white;font-size:1.3rem;font-weight:700;margin:0">${biz}</h1>
    </div>
    <div style="padding:32px">
      <p style="font-size:1rem;color:#111;margin:0 0 12px">Hola ${client_name},</p>
      <p style="font-size:0.93rem;color:#444;line-height:1.65;margin:0 0 24px">
        Esperamos que hayas disfrutado tu sesión de <strong>${service_name}</strong>.
        Tu opinión nos ayuda a seguir mejorando. ¿Podés dejarnos una reseña? ¡Solo tarda un minuto!
      </p>
      <div style="text-align:center;margin:28px 0">
        <a href="${review_url}" style="display:inline-block;background:#2d6a4f;color:white;padding:14px 32px;border-radius:8px;font-size:0.95rem;font-weight:700;text-decoration:none">
          ⭐ Dejar mi reseña
        </a>
      </div>
      <p style="font-size:0.82rem;color:#888;text-align:center;margin-top:20px">
        Si el botón no funciona, copiá este enlace:<br>
        <a href="${review_url}" style="color:#2d6a4f;word-break:break-all">${review_url}</a>
      </p>
    </div>
    <div style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:0.78rem;color:#aaa">
      © ${new Date().getFullYear()} ${biz}
    </div>
  </div>
</body></html>`;
  return sendMail({
    to: client_email,
    subject: `¿Cómo te fue en ${biz}? Dejanos tu reseña ⭐`,
    html,
  });
}

async function sendGiftCard({ purchaser_name, purchaser_email, recipient_name, code, amount, business_name }, settings) {
  const biz = business_name || 'Mi Piel';
  const forWho = recipient_name ? `para <strong>${recipient_name}</strong>` : '';
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Inter,sans-serif">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e8e8e8">
    <div style="background:#2d6a4f;padding:28px 32px;text-align:center">
      <h1 style="color:white;font-size:1.3rem;font-weight:700;margin:0">🎁 Gift Card — ${biz}</h1>
    </div>
    <div style="padding:32px">
      <p style="font-size:1rem;color:#111;margin:0 0 12px">Hola <strong>${purchaser_name}</strong>,</p>
      <p style="font-size:0.93rem;color:#444;line-height:1.65;margin:0 0 24px">
        Tu gift card ${forWho} está lista. Guardá el código para usarlo al reservar un turno en <strong>${biz}</strong>.
      </p>
      <div style="background:#f0f7f3;border:2px dashed #2d6a4f;border-radius:12px;padding:24px;text-align:center;margin:0 0 24px">
        <div style="font-size:0.78rem;color:#888;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px">Código de gift card</div>
        <div style="font-size:2rem;font-weight:800;color:#2d6a4f;letter-spacing:0.12em;font-family:monospace">${code}</div>
        <div style="margin-top:12px;font-size:1.1rem;font-weight:700;color:#111">$ ${Number(amount).toLocaleString('es-UY')}</div>
      </div>
      <p style="font-size:0.85rem;color:#888;line-height:1.6;margin:0">
        Ingresá este código al hacer tu reserva online. El saldo se descuenta automáticamente del precio del servicio.
      </p>
    </div>
    <div style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:0.78rem;color:#aaa">© ${new Date().getFullYear()} ${biz}</div>
  </div>
</body></html>`;
  return sendMail({ to: purchaser_email, subject: `🎁 Tu gift card de ${biz} — ${code}`, html }, settings);
}

async function sendGiftCardRecipient({ purchaser_name, recipient_name, recipient_email, code, amount, business_name }, settings) {
  const biz = business_name || 'Mi Piel';
  const greeting = recipient_name ? `Hola <strong>${recipient_name}</strong>` : 'Hola';
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Inter,sans-serif">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e8e8e8">
    <div style="background:#2d6a4f;padding:28px 32px;text-align:center">
      <h1 style="color:white;font-size:1.3rem;font-weight:700;margin:0">🎁 ¡Te regalaron una gift card!</h1>
    </div>
    <div style="padding:32px">
      <p style="font-size:1rem;color:#111;margin:0 0 12px">${greeting},</p>
      <p style="font-size:0.93rem;color:#444;line-height:1.65;margin:0 0 24px">
        <strong>${purchaser_name}</strong> te regaló una gift card para usar en <strong>${biz}</strong>. ¡Ya podés reservar tu turno y aplicar el código al pagar!
      </p>
      <div style="background:#f0f7f3;border:2px dashed #2d6a4f;border-radius:12px;padding:24px;text-align:center;margin:0 0 24px">
        <div style="font-size:0.78rem;color:#888;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px">Tu código de regalo</div>
        <div style="font-size:2rem;font-weight:800;color:#2d6a4f;letter-spacing:0.12em;font-family:monospace">${code}</div>
        <div style="margin-top:12px;font-size:1.1rem;font-weight:700;color:#111">$ ${Number(amount).toLocaleString('es-UY')}</div>
      </div>
      <p style="font-size:0.85rem;color:#888;line-height:1.6;margin:0">
        Ingresá este código al hacer tu reserva online en <strong>${biz}</strong>. El saldo se descuenta automáticamente del precio del servicio.
      </p>
    </div>
    <div style="background:#f5f5f5;padding:16px 32px;text-align:center;font-size:0.78rem;color:#aaa">© ${new Date().getFullYear()} ${biz}</div>
  </div>
</body></html>`;
  return sendMail({ to: recipient_email, subject: `🎁 ${purchaser_name} te regaló una gift card de ${biz}`, html }, settings);
}

module.exports = {
  sendMail,
  sendConfirmation,
  sendPaymentConfirmation,
  sendOwnerNotification,
  sendReminder,
  sendWeeklySummary,
  sendReviewRequest,
  sendGiftCard,
  sendGiftCardRecipient,
  testConnection,
  getStatus,
};
