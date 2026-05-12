require('dotenv').config();
const multer = require('multer');
const cron = require('node-cron');
const emailSvc = require('./email');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const express = require('express');

// Mercado Pago — se inicializa solo si MP_ACCESS_TOKEN está configurado
const mpClient = process.env.MP_ACCESS_TOKEN
  ? new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN })
  : null;
const session = require('express-session');
const path = require('path');
const db = require('./db');
const wa = require('./whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Uploads ──────────────────────────────────────────────────────────────────
const { mkdirSync } = require('fs');
const uploadsDir = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname, 'uploads');
mkdirSync(uploadsDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = require('path').extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo imágenes'), false);
  },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', require('express').static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: db.createSessionStore(session),
  secret: process.env.SESSION_SECRET || 'agenda-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.status(401).json({ error: 'No autorizado' });
}

function formatDate(d) {
  const [y, m, day] = d.split('-');
  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  return `${parseInt(day)} de ${months[parseInt(m)-1]} de ${y}`;
}

async function verifyGoogleToken(credential) {
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    const data = await r.json();
    if (!r.ok || data.error || !data.sub) return null;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (clientId && data.aud !== clientId) return null;
    return { google_id: data.sub, email: data.email, name: data.name, picture: data.picture };
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════

app.get('/api/config', (req, res) => {
  res.json({ google_client_id: process.env.GOOGLE_CLIENT_ID || null });
});

app.get('/api/business', (req, res) => {
  const s = db.getSettings();
  res.json({ name: s.business_name, description: s.business_description, address: s.business_address });
});

app.get('/api/services', (req, res) => {
  res.json(db.getActiveServices());
});

app.get('/api/professionals', (req, res) => {
  const { service_id } = req.query;
  if (service_id) {
    const svc = db.getServiceById(parseInt(service_id));
    return res.json(svc ? svc.professionals.filter(p => p.active) : []);
  }
  res.json(db.getProfessionals());
});

app.get('/api/available-dates', (req, res) => {
  const { service_id, professional_id } = req.query;
  if (!service_id) return res.status(400).json({ error: 'Falta service_id' });
  res.json(db.getAvailableDates(parseInt(service_id), professional_id ? parseInt(professional_id) : null));
});

app.get('/api/available-slots', (req, res) => {
  const { date, service_id, professional_id } = req.query;
  if (!date || !service_id) return res.status(400).json({ error: 'Faltan parámetros' });
  res.json(db.getAvailableSlots(date, parseInt(service_id), professional_id ? parseInt(professional_id) : null));
});

app.post('/api/bookings', async (req, res) => {
  const { name, phone, email, instagram, service_id, professional_id, date, time, notes } = req.body;
  if (!name || !phone || !service_id || !date || !time)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });

  if (!db.isSlotAvailable(date, time, parseInt(service_id), professional_id ? parseInt(professional_id) : null))
    return res.status(409).json({ error: 'El horario ya no está disponible. Por favor elegí otro.' });

  const client = db.upsertClient({ name, phone, email, instagram });
  const service = db.getServiceById(parseInt(service_id));
  const professional = professional_id ? db.getProfessionalById(parseInt(professional_id)) : service.professionals[0] || null;

  const booking = db.createBooking({
    client_id: client.id,
    service_id: parseInt(service_id),
    professional_id: professional ? professional.id : null,
    date, time, notes,
    total_price: service.price,
    deposit_paid: 0
  });

  const s = db.getSettings();
  const profName = professional ? professional.name : '';
  const bizName = s.business_name || 'Mi Negocio';

  // Send WhatsApp messages asynchronously via Meta Cloud API templates
  setImmediate(async () => {
    // Template: confirmacion_reserva
    // Params: {{1}} nombre, {{2}} negocio, {{3}} servicio, {{4}} profesional, {{5}} fecha, {{6}} hora, {{7}} reserva_id
    await wa.sendTemplate(phone, 'confirmacion_reserva', [
      name, bizName, service.name, profName || '-', formatDate(date), time, String(booking.id)
    ]);

    const ownerPhone = s.whatsapp_phone || '';
    if (ownerPhone) {
      // Template: nueva_reserva
      // Params: {{1}} reserva_id, {{2}} servicio, {{3}} cliente, {{4}} telefono, {{5}} fecha, {{6}} hora
      await wa.sendTemplate(ownerPhone, 'nueva_reserva', [
        String(booking.id), service.name, name, phone, formatDate(date), time
      ]);
    }
  });

  // Si MP está configurado crear preferencias: una para seña y otra para total
  let mp_url_deposit = null;
  let mp_url_full = null;

  if (mpClient && (service.deposit > 0 || service.price > 0)) {
    const pref = new Preference(mpClient);
    const publicUrl = process.env.PUBLIC_BASE_URL || 'https://mipiel.up.railway.app';

    const makePref = async (amount, payType, label) => {
      const r = await pref.create({ body: {
        items: [{ id: `booking-${booking.id}-${payType}`, title: `${label} - ${service.name}`,
          description: `Reserva #${booking.id} · ${bizName}`, quantity: 1,
          unit_price: amount, currency_id: 'UYU' }],
        external_reference: `${booking.id}:${payType}`,
        back_urls: {
          success: `${publicUrl}/?payment=success&type=${payType}&booking=${booking.id}`,
          failure: `${publicUrl}/?payment=failure&type=${payType}&booking=${booking.id}`,
          pending: `${publicUrl}/?payment=pending&type=${payType}&booking=${booking.id}`,
        },
        auto_return: 'approved',
        notification_url: `${publicUrl}/api/payments/webhook`,
        statement_descriptor: bizName.slice(0, 22),
        metadata: { booking_id: booking.id, pay_type: payType },
      }});
      return r.init_point;
    };

    try {
      const tasks = [];
      if (service.deposit > 0) tasks.push(makePref(service.deposit, 'deposit', 'Seña').then(u => { mp_url_deposit = u; }));
      if (service.price > 0)   tasks.push(makePref(service.price,   'full',    'Total').then(u => { mp_url_full = u; }));
      await Promise.all(tasks);
    } catch (mpErr) {
      console.error('MP preference error:', mpErr.message);
    }
  }

  res.json({
    success: true,
    booking_id: booking.id,
    deposit: service.deposit,
    price: service.price,
    message: 'Reserva creada exitosamente',
    mp_url_deposit,
    mp_url_full,
  });
});

// ═══════════════════════════════════════════════════════
// MERCADO PAGO
// ═══════════════════════════════════════════════════════

// Webhook de MP (no requiere auth — MP llama desde sus servidores)
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  res.sendStatus(200); // siempre 200 a MP primero
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (body.type !== 'payment' || !body.data?.id) return;
    if (!mpClient) return;
    const payment = new Payment(mpClient);
    const payData = await payment.get({ id: body.data.id });
    if (payData.status === 'approved') {
      const [bookingIdStr, payType = 'deposit'] = (payData.external_reference || '').split(':');
      const bookingId = parseInt(bookingIdStr);
      if (!isNaN(bookingId)) {
        const newPaymentStatus = payType === 'full' ? 'full' : 'deposit';
        db.updateBookingAdmin(bookingId, { payment_status: newPaymentStatus });
        db.updateBookingPayment(bookingId, {
          deposit_paid: payData.transaction_amount,
          mp_payment_id: String(body.data.id),
        });
        console.log(`MP pago aprobado: booking #${bookingId}, tipo=${payType}, $${payData.transaction_amount}`);
      }
    }
  } catch (err) { console.error('MP webhook error:', err.message); }
});

// Estado de pago de una reserva
app.get('/api/payments/status/:bookingId', (req, res) => {
  const b = db.getBookingById(parseInt(req.params.bookingId));
  if (!b) return res.status(404).json({ error: 'No encontrado' });
  res.json({ deposit_paid: b.deposit_paid, payment_status: b.payment_status, mp_payment_id: b.mp_payment_id });
});

// ═══════════════════════════════════════════════════════
// CLIENT AUTH
// ═══════════════════════════════════════════════════════

app.post('/api/client/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Falta credential' });
  const info = await verifyGoogleToken(credential);
  if (!info) return res.status(401).json({ error: 'Token de Google inválido' });
  const client = db.findOrCreateClientByGoogle(info);
  req.session.clientUser = { id: client.id, name: client.name, email: client.email, picture: info.picture };
  res.json({ success: true, client: req.session.clientUser });
});

app.get('/api/client/me', (req, res) => {
  res.json({ client: req.session.clientUser || null });
});

app.get('/api/client/my-bookings', (req, res) => {
  if (!req.session.clientUser) return res.status(401).json({ error: 'No autenticado' });
  const bookings = db.getClientBookings(req.session.clientUser.id);
  res.json(bookings);
});

app.post('/api/client/my-bookings/:id/cancel', (req, res) => {
  if (!req.session.clientUser) return res.status(401).json({ error: 'No autenticado' });
  const result = db.cancelClientBooking(parseInt(req.params.id), req.session.clientUser.id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ success: true });
});

app.post('/api/client/logout', (req, res) => {
  delete req.session.clientUser;
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
// ADMIN AUTH
// ═══════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const s = db.getSettings();
  const correct = s.admin_password || process.env.ADMIN_PASSWORD || 'admin123';
  if (password === correct) { req.session.authenticated = true; res.json({ success: true }); }
  else res.status(401).json({ error: 'Contraseña incorrecta' });
});

app.post('/api/admin/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/admin/check-auth', (req, res) => res.json({ authenticated: !!req.session.authenticated }));

// ═══════════════════════════════════════════════════════
// ADMIN API
// ═══════════════════════════════════════════════════════

app.get('/api/admin/stats', requireAuth, (req, res) => res.json(db.getDashboardStats()));

// Bookings
app.get('/api/admin/bookings', requireAuth, (req, res) => {
  const { date, status, client_id, from, to, professional_id, page, limit } = req.query;
  res.json(db.getBookings({ date, status, client_id, from, to, professional_id, page: parseInt(page)||1, limit: parseInt(limit)||100 }));
});
app.get('/api/admin/bookings/:id', requireAuth, (req, res) => {
  const b = db.getBookingById(parseInt(req.params.id));
  if (!b) return res.status(404).json({ error: 'No encontrado' });
  res.json(b);
});
app.put('/api/admin/bookings/:id', requireAuth, (req, res) => {
  db.updateBooking(parseInt(req.params.id), req.body);
  res.json({ success: true });
});
app.delete('/api/admin/bookings/purge-cancelled', requireAuth, (req, res) => {
  const count = db.purgeCancelledBookings();
  res.json({ success: true, deleted: count });
});
app.delete('/api/admin/bookings/:id', requireAuth, (req, res) => {
  db.cancelBooking(parseInt(req.params.id));
  res.json({ success: true });
});

// Clients
app.get('/api/admin/clients', requireAuth, (req, res) => {
  const { search, page, limit } = req.query;
  res.json(db.getClients({ search, page: parseInt(page)||1, limit: parseInt(limit)||50 }));
});
app.get('/api/admin/clients/:id', requireAuth, (req, res) => {
  const client = db.getClientById(parseInt(req.params.id));
  if (!client) return res.status(404).json({ error: 'No encontrado' });
  const bookings = db.getClientBookings(parseInt(req.params.id));
  res.json({ ...client, bookings });
});
app.put('/api/admin/clients/:id', requireAuth, (req, res) => {
  db.updateClient(parseInt(req.params.id), req.body);
  res.json({ success: true });
});
app.delete('/api/admin/clients/:id', requireAuth, (req, res) => {
  db.deleteClient(parseInt(req.params.id));
  res.json({ success: true });
});

// Services
app.get('/api/admin/services', requireAuth, (req, res) => res.json(db.getAllServices()));
app.post('/api/admin/services', requireAuth, (req, res) => {
  const { name, duration, price, deposit, description, professional_ids } = req.body;
  res.json(db.createService({ name, duration: parseInt(duration), price: parseFloat(price)||0, deposit: parseFloat(deposit)||0, description, professional_ids }));
});
app.put('/api/admin/services/:id', requireAuth, (req, res) => {
  const { name, duration, price, deposit, description, active, professional_ids } = req.body;
  db.updateService(parseInt(req.params.id), { name, duration: parseInt(duration), price: parseFloat(price)||0, deposit: parseFloat(deposit)||0, description, active, professional_ids });
  res.json({ success: true });
});
app.delete('/api/admin/services/:id', requireAuth, (req, res) => {
  db.deleteService(parseInt(req.params.id));
  res.json({ success: true });
});

// Professionals
app.get('/api/admin/professionals', requireAuth, (req, res) => res.json(db.getProfessionals(false)));
app.post('/api/admin/professionals', requireAuth, (req, res) => res.json(db.createProfessional(req.body)));
app.put('/api/admin/professionals/:id', requireAuth, (req, res) => {
  db.updateProfessional(parseInt(req.params.id), req.body);
  res.json({ success: true });
});
app.delete('/api/admin/professionals/:id', requireAuth, (req, res) => {
  db.deleteProfessional(parseInt(req.params.id));
  res.json({ success: true });
});
app.delete('/api/admin/professionals/:id/purge', requireAuth, (req, res) => {
  db.purgeProfessional(parseInt(req.params.id));
  res.json({ success: true });
});

// Business hours
app.get('/api/admin/hours/:professionalId', requireAuth, (req, res) => {
  res.json(db.getBusinessHours(parseInt(req.params.professionalId)));
});
app.put('/api/admin/hours/:professionalId', requireAuth, (req, res) => {
  db.updateBusinessHours(parseInt(req.params.professionalId), req.body.hours);
  res.json({ success: true });
});

// Revenue
app.get('/api/admin/revenue', requireAuth, (req, res) => {
  const { period, year, month } = req.query;
  res.json(db.getRevenue({ period: period||'month', year: parseInt(year), month: parseInt(month) }));
});

// Settings
app.get('/api/admin/settings', requireAuth, (req, res) => res.json(db.getSettings()));
app.put('/api/admin/settings', requireAuth, (req, res) => {
  db.updateSettings(req.body);
  res.json({ success: true });
});

// WhatsApp
app.get('/api/admin/whatsapp/status', requireAuth, (req, res) => {
  res.json({ status: wa.getStatus() });
});


// ─── ADMIN: fotos de citas ────────────────────────────────────────────────────
app.get('/api/admin/bookings/:id/photos', requireAuth, (req, res) => {
  res.json(db.getBookingPhotos(parseInt(req.params.id)));
});
app.post('/api/admin/bookings/:id/photos', requireAuth, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió foto' });
  const photo = db.addBookingPhoto(parseInt(req.params.id), `/uploads/${req.file.filename}`, req.body.comment || '');
  res.json(photo);
});
app.delete('/api/admin/bookings/:id/photos/:photoId', requireAuth, (req, res) => {
  const photo = db.deleteBookingPhoto(parseInt(req.params.photoId));
  if (photo) {
    try { require('fs').unlinkSync(require('path').join(uploadsDir, require('path').basename(photo.file_path))); } catch (_e) {}
  }
  res.json({ success: true });
});
app.put('/api/admin/bookings/:id/admin-notes', requireAuth, (req, res) => {
  db.updateBookingAdmin(parseInt(req.params.id), { notes_admin: req.body.notes_admin, payment_status: req.body.payment_status });
  res.json({ success: true });
});

// ─── CLIENTE: ver fotos de su cita ───────────────────────────────────────────
app.get('/api/client/my-bookings/:id/photos', (req, res) => {
  if (!req.session.clientUser) return res.status(401).json({ error: 'No autenticado' });
  const bookings = db.getClientBookings(req.session.clientUser.id);
  if (!bookings.find(b => b.id === parseInt(req.params.id))) return res.status(403).json({ error: 'Sin acceso' });
  res.json(db.getBookingPhotos(parseInt(req.params.id)));
});

// ─── WHATSAPP WEBHOOK ─────────────────────────────────────────────────────────
// Verificación del webhook (GET) — Meta envía hub.challenge para confirmar la URL
app.get('/api/whatsapp/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = process.env.WHATSAPP_WEBHOOK_TOKEN || 'mipiel_whatsapp_2026';
  if (mode === 'subscribe' && token === expected) {
    console.log('WhatsApp webhook verificado');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Notificaciones entrantes de WhatsApp (POST)
app.post('/api/whatsapp/webhook', express.json(), (req, res) => {
  res.sendStatus(200); // siempre 200 a Meta
  const body = req.body;
  if (body.object === 'whatsapp_business_account') {
    body.entry?.forEach(entry => {
      entry.changes?.forEach(change => {
        const statuses = change.value?.statuses;
        if (statuses) {
          statuses.forEach(s => {
            console.log(`WA status: mensaje ${s.id} → ${s.status}`);
          });
        }
      });
    });
  }
});

// ═══════════════════════════════════════════════════════
// ROUTES (wildcard siempre al final)
// ═══════════════════════════════════════════════════════

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── CRON: recordatorio 48h (cada hora) ──────────────────────────────────────
cron.schedule('0 * * * *', async () => {
  try {
    const bookings = db.getBookingsNeedingReminder();
    const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const s = db.getSettings();
    for (const b of bookings) {
      const [y, mo, dy] = b.date.split('-');
      const dateStr = `${parseInt(dy)} de ${months[parseInt(mo)-1]} de ${y}`;
      if (b.client_phone) {
        await wa.sendTemplate(b.client_phone, process.env.WHATSAPP_REMINDER_TEMPLATE || 'recordatorio_turno',
          [b.client_name, b.service_name, dateStr, b.time]).catch(() => {});
      }
      if (b.client_email) {
        await emailSvc.sendReminder({ ...b, date_formatted: dateStr, business_name: s.business_name }).catch(() => {});
      }
      db.markReminderSent(b.id);
    }
    if (bookings.length) console.log(`Recordatorios enviados: ${bookings.length}`);
  } catch (err) { console.error('Cron recordatorio:', err.message); }
});

// ─── CRON: resumen semanal (domingos 9am) ─────────────────────────────────────
cron.schedule('0 9 * * 0', async () => {
  try {
    const s = db.getSettings();
    const bookings = db.getWeekBookings();
    const adminEmail = process.env.ADMIN_EMAIL || '';
    if (adminEmail) await emailSvc.sendWeeklySummary(bookings, adminEmail, s).catch(() => {});
    const adminPhone = s.whatsapp_phone || '';
    if (adminPhone && bookings.length > 0) {
      await wa.sendTemplate(adminPhone, process.env.WHATSAPP_SUMMARY_TEMPLATE || 'resumen_semanal',
        [String(bookings.length)]).catch(() => {});
    }
    console.log(`Resumen semanal: ${bookings.length} citas`);
  } catch (err) { console.error('Cron semanal:', err.message); }
});

app.listen(PORT, () => {
  console.log(`\n✅ Agenda corriendo en http://localhost:${PORT}`);
  console.log(`📅 Página de reservas: http://localhost:${PORT}`);
  console.log(`🔐 Panel admin:        http://localhost:${PORT}/admin`);
  console.log(`   Contraseña admin:   admin123 (cambiala en Configuración)\n`);
});





