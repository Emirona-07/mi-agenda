const nodemailer = require('nodemailer');

function buildTransporter({ email_host, email_port, email_user, email_pass }) {
  if (!email_host || !email_user || !email_pass) return null;
  return nodemailer.createTransport({
    host: email_host,
    port: parseInt(email_port) || 587,
    secure: parseInt(email_port) === 465,
    auth: { user: email_user, pass: email_pass },
  });
}

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

async function sendConfirmation(toEmail, data, settings) {
  const t = buildTransporter(settings);
  if (!t || !toEmail) return { ok: false, reason: !t ? 'smtp_no_configurado' : 'sin_email_cliente' };
  const bizName = settings.business_name || 'Mi Negocio';
  const from = settings.email_from || settings.email_user;
  try {
    await t.sendMail({
      from: `${bizName} <${from}>`,
      to: toEmail,
      subject: `✅ Reserva confirmada en ${bizName} — #${data.bookingId}`,
      html: confirmacionHTML({ ...data, bizName }),
    });
    console.log(`[email] Confirmación enviada a ${toEmail}`);
    return { ok: true };
  } catch (e) {
    console.error('[email] sendConfirmation error:', e.message);
    return { ok: false, reason: e.message };
  }
}

async function sendOwnerNotification(toEmail, data, settings) {
  const t = buildTransporter(settings);
  if (!t || !toEmail) return { ok: false, reason: !t ? 'smtp_no_configurado' : 'sin_email_dueño' };
  const bizName = settings.business_name || 'Mi Negocio';
  const from = settings.email_from || settings.email_user;
  try {
    await t.sendMail({
      from: `${bizName} <${from}>`,
      to: toEmail,
      subject: `📅 Nueva reserva #${data.bookingId} — ${data.clientName}`,
      html: nuevaReservaHTML(data),
    });
    console.log(`[email] Notificación dueño enviada a ${toEmail}`);
    return { ok: true };
  } catch (e) {
    console.error('[email] sendOwnerNotification error:', e.message);
    return { ok: false, reason: e.message };
  }
}

async function testConnection(settings) {
  const t = buildTransporter(settings);
  if (!t) return { ok: false, reason: 'Faltan datos (host, usuario o contraseña)' };
  try {
    await t.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function getStatus(settings) {
  const { email_host, email_user, email_pass } = settings || {};
  return email_host && email_user && email_pass ? 'configured' : 'not_configured';
}

module.exports = { sendConfirmation, sendOwnerNotification, testConnection, getStatus };
