'use strict';
const nodemailer = require('nodemailer');

/* ─── Transporter ─────────────────────────────────────────────────── */

function buildTransporter(settings) {
  const host = settings?.email_host || '';
  const port = parseInt(settings?.email_port || '587');
  const user = settings?.email_user || process.env.GMAIL_USER || '';
  const pass = settings?.email_pass || process.env.GMAIL_APP_PASSWORD || '';
  if (!user || !pass) return null;
  if (!host || host === 'smtp.gmail.com') {
    // Puerto 465 (SSL) — más compatible con hosting cloud que 587
    return nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass },
    });
  }
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

function fromAddress(settings) {
  const name = settings?.business_name || 'Mi Negocio';
  const addr = settings?.email_from || settings?.email_user || process.env.GMAIL_USER || '';
  return addr ? `${name} <${addr}>` : name;
}

/* ─── HTML templates ──────────────────────────────────────────────── */

function confirmacionHTML({ name, bizName, serviceName, profName, date, time, bookingId }) {
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
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">Nº de reserva</td><td style="padding:5px 0;font-weight:600">#${bookingId}</td></tr>
      </table>
    </div>
    <p style="font-size:.85rem;color:#999;margin:0">Si necesitás cancelar, escribinos con anticipación.</p>
  </div>
  <div style="background:#f9f9f9;padding:14px;text-align:center;font-size:.8rem;color:#bbb">${bizName}</div>
</div></body></html>`;
}

function nuevaReservaHTML({ bookingId, serviceName, clientName, phone, date, time }) {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px">
<div style="max-width:500px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
  <div style="background:#1a5c38;padding:24px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:22px">📅 Nueva reserva</h1>
  </div>
  <div style="padding:24px">
    <div style="background:#f5faf7;border-left:4px solid #1a5c38;border-radius:4px;padding:16px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem;width:40%">Nº de reserva</td><td style="padding:5px 0;font-weight:600">#${bookingId}</td></tr>
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">Servicio</td><td style="padding:5px 0;font-weight:600">${serviceName}</td></tr>
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">Cliente</td><td style="padding:5px 0;font-weight:600">${clientName}</td></tr>
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">Teléfono</td><td style="padding:5px 0;font-weight:600">${phone}</td></tr>
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">Fecha</td><td style="padding:5px 0;font-weight:600">${date}</td></tr>
        <tr><td style="padding:5px 0;color:#777;font-size:.88rem">Hora</td><td style="padding:5px 0;font-weight:600">${time}</td></tr>
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
  const t = buildTransporter(settings);
  if (!t) {
    console.error('[email] SMTP no configurado — falta email_user/email_pass en settings o GMAIL_USER/GMAIL_APP_PASSWORD en env');
    return { ok: false, reason: 'smtp_no_configurado' };
  }
  if (!to) return { ok: false, reason: 'sin_destinatario' };
  try {
    await t.sendMail({ from: fromAddress(settings), to, subject, html });
    console.log(`[email] ✓ Enviado a ${to}: ${subject}`);
    return { ok: true };
  } catch (e) {
    console.error(`[email] Error enviando a ${to}:`, e.message);
    return { ok: false, reason: e.message };
  }
}

/* ─── Public send functions ───────────────────────────────────────── */

async function sendConfirmation(toEmail, data, settings) {
  const bizName = settings?.business_name || 'Mi Negocio';
  console.log(`[email] Enviando confirmación a ${toEmail}`);
  return sendMail({
    to: toEmail,
    subject: `✅ Reserva confirmada en ${bizName} — #${data.bookingId}`,
    html: confirmacionHTML({ ...data, bizName }),
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
  const t = buildTransporter(settings);
  if (!t) return { ok: false, reason: 'Faltan datos SMTP (host/usuario/contraseña o variables GMAIL_USER / GMAIL_APP_PASSWORD)' };
  try {
    await t.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function getStatus(settings) {
  const user = settings?.email_user || process.env.GMAIL_USER || '';
  const pass = settings?.email_pass || process.env.GMAIL_APP_PASSWORD || '';
  return user && pass ? 'configured' : 'not_configured';
}

module.exports = {
  sendMail,
  sendConfirmation,
  sendOwnerNotification,
  sendReminder,
  sendWeeklySummary,
  testConnection,
  getStatus,
};
