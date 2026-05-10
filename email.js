'use strict';

const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });
  return transporter;
}

/**
 * Envía un correo genérico.
 * @param {{ to: string, subject: string, html: string }} opts
 * @returns {Promise<boolean>}
 */
async function sendMail({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    console.log('[email] GMAIL_USER o GMAIL_APP_PASSWORD no configurados — email no enviado');
    return false;
  }
  try {
    await t.sendMail({ from: GMAIL_USER, to, subject, html });
    return true;
  } catch (err) {
    console.error('[email] Error al enviar:', err.message);
    return false;
  }
}

/**
 * Envía recordatorio de turno al cliente.
 * @param {Object} booking  — debe incluir: client_name, client_email, service_name,
 *                            date_formatted, time, business_name
 * @returns {Promise<boolean>}
 */
async function sendReminder(booking) {
  if (!booking.client_email) return false;
  const businessName = booking.business_name || 'Tu negocio';
  const subject = `Recordatorio de tu turno mañana — ${businessName}`;
  const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #333; background: #f9f9f9; margin: 0; padding: 0; }
  .container { max-width: 520px; margin: 32px auto; background: #fff; border-radius: 8px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  h2 { color: #c85fa0; margin-top: 0; }
  .detail { margin: 8px 0; font-size: 15px; }
  .label { font-weight: bold; }
  .footer { margin-top: 24px; font-size: 12px; color: #999; }
</style></head>
<body>
<div class="container">
  <h2>Recordatorio de tu turno 💅</h2>
  <p>Hola <strong>${booking.client_name || 'cliente'}</strong>, te recordamos que mañana tenés un turno en <strong>${businessName}</strong>.</p>
  <div class="detail"><span class="label">Servicio:</span> ${booking.service_name || ''}</div>
  <div class="detail"><span class="label">Fecha:</span> ${booking.date_formatted || booking.date || ''}</div>
  <div class="detail"><span class="label">Hora:</span> ${booking.time || ''}</div>
  <p>Si necesitás cancelar o cambiar el turno, comunicate con nosotros a la brevedad.</p>
  <div class="footer">Este mensaje fue enviado automáticamente por ${businessName}.</div>
</div>
</body>
</html>
  `.trim();
  return sendMail({ to: booking.client_email, subject, html });
}

/**
 * Envía el resumen semanal de citas al administrador.
 * @param {Array}  bookings  — lista de turnos de la semana
 * @param {string} to        — email destino (admin)
 * @param {Object} settings  — configuración del negocio (business_name, etc.)
 * @returns {Promise<boolean>}
 */
async function sendWeeklySummary(bookings, to, settings) {
  if (!to) return false;
  const businessName = (settings && settings.business_name) || 'Tu negocio';
  const subject = `Agenda de la semana — ${businessName}`;

  const rows = (bookings || []).map((b) => {
    const statusLabel = {
      confirmed: 'Confirmado',
      cancelled: 'Cancelado',
      completed: 'Completado',
      pending: 'Pendiente',
    }[b.status] || b.status || '';
    return `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${b.date || ''}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${b.time || ''}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${b.client_name || ''}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${b.service_name || ''}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;">${statusLabel}</td>
      </tr>`;
  }).join('');

  const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #333; background: #f9f9f9; margin: 0; padding: 0; }
  .container { max-width: 700px; margin: 32px auto; background: #fff; border-radius: 8px; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  h2 { color: #c85fa0; margin-top: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  thead th { background: #c85fa0; color: #fff; padding: 8px 10px; text-align: left; }
  .footer { margin-top: 24px; font-size: 12px; color: #999; }
</style></head>
<body>
<div class="container">
  <h2>Agenda de la semana 📅</h2>
  <p>Resumen de turnos para <strong>${businessName}</strong>. Total: <strong>${(bookings || []).length}</strong> citas.</p>
  <table>
    <thead>
      <tr>
        <th>Fecha</th>
        <th>Hora</th>
        <th>Cliente</th>
        <th>Servicio</th>
        <th>Estado</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="5" style="padding:10px;text-align:center;color:#999;">Sin turnos esta semana</td></tr>'}
    </tbody>
  </table>
  <div class="footer">Resumen generado automáticamente por ${businessName}.</div>
</div>
</body>
</html>
  `.trim();
  return sendMail({ to, subject, html });
}

/**
 * Retorna el estado de la integración de email.
 */
function getStatus() {
  return {
    configured: Boolean(GMAIL_USER && GMAIL_APP_PASSWORD),
    user: GMAIL_USER || null,
  };
}

module.exports = { sendMail, sendReminder, sendWeeklySummary, getStatus };
