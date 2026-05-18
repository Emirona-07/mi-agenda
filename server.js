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
const { hashPassword, isPasswordHash, verifyPassword } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET
  || process.env.ADMIN_PASSWORD
  || require('crypto').randomBytes(32).toString('hex');

app.set('trust proxy', 1);

// ─── Uploads ──────────────────────────────────────────────────────────────────
const { mkdirSync } = require('fs');
const uploadsDir = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname, 'uploads');
mkdirSync(uploadsDir, { recursive: true });
const allowedImageTypes = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = allowedImageTypes.get(file.mimetype);
      const name = require('crypto').randomBytes(16).toString('hex');
      cb(null, `${Date.now()}-${name}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (allowedImageTypes.has(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se permiten imágenes JPG, PNG, WebP o GIF'), false);
  },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', require('express').static(uploadsDir, {
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  name: 'mi_agenda.sid',
  store: db.createSessionStore(session),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
  }
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

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

function sanitizeOptional(value, max = 1000) {
  return String(value || '').trim().slice(0, max);
}

function adminSettings(settings) {
  const { admin_password, email_pass, ...safe } = settings;
  return safe;
}

function pickSettings(body) {
  const allowed = new Set([
    'business_name',
    'business_description',
    'business_address',
    'whatsapp_phone',
    'admin_password',
    'booking_advance_days',
    'slot_interval',
    'currency',
    'notification_channel',
    'mp_surcharge',
    'owner_email',
    'bank_account',
    'reminder_emails_enabled',
    'reminder_hours',
    'reviews_enabled',
  ]);
  return Object.fromEntries(Object.entries(body || {}).filter(([key]) => allowed.has(key)));
}

async function sendGiftCardEmail(gc, settings) {
  if (!gc?.purchaser_email) return { ok: false, reason: 'sin_destinatario' };
  return emailSvc.sendGiftCard({
    purchaser_name: gc.purchaser_name,
    purchaser_email: gc.purchaser_email,
    recipient_name: gc.recipient_name,
    code: gc.code,
    amount: gc.amount,
    business_name: settings.business_name || 'Mi Piel',
  }, settings);
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
  res.json({
    name: s.business_name,
    description: s.business_description,
    address: s.business_address,
    notification_channel: s.notification_channel || 'email',
    mp_surcharge: parseFloat(s.mp_surcharge || '5'),
    mp_active: !!mpClient,
    bank_account: s.bank_account || '',
  });
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
  const name = sanitizeOptional(req.body.name, 120);
  const phone = sanitizeOptional(req.body.phone, 40);
  const email = sanitizeOptional(req.body.email, 160);
  const instagram = sanitizeOptional(req.body.instagram, 80);
  const notes = sanitizeOptional(req.body.notes, 1000);
  const { service_id, professional_id, date, time, payment_method, gift_card_code } = req.body;

  const s = db.getSettings();
  const channel = s.notification_channel || 'email';
  const needPhone = channel === 'whatsapp' || channel === 'both';
  const needEmail = channel === 'email' || channel === 'both';
  if (!name || (needPhone && !phone) || (needEmail && !email) || !service_id || !date || !time)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  if (email && !isValidEmail(email)) return res.status(400).json({ error: 'Email inválido' });

  const service = db.getServiceById(parseInt(service_id));
  if (!service || !service.active) return res.status(404).json({ error: 'Servicio no disponible' });

  const client = db.upsertClient({ name, phone, email, instagram });
  const professional = professional_id ? db.getProfessionalById(parseInt(professional_id)) : service.professionals[0] || null;

  // Precios: aplicar recargo de MP si el cliente eligió pagar con MP
  const payMethod = payment_method === 'mp' ? 'mp' : payment_method === 'transfer' ? 'transfer' : 'cash';
  const mpSurchargePct = payMethod === 'mp' ? parseFloat(s.mp_surcharge || '5') / 100 : 0;
  const effectivePrice   = service.price   > 0 ? Math.round(service.price   * (1 + mpSurchargePct)) : 0;
  const effectiveDeposit = service.deposit > 0 ? Math.round(service.deposit * (1 + mpSurchargePct)) : 0;

  let atomicResult;
  try {
    atomicResult = db.createBookingAtomic({
      booking: {
        client_id: client.id,
        service_id: parseInt(service_id),
        professional_id: professional ? professional.id : null,
        date, time, notes,
        deposit_paid: 0,
      },
      gift_card_code,
      effective_price: effectivePrice,
    });
  } catch (err) {
    if (err.message === 'gift_card_unavailable') {
      return res.status(409).json({ error: 'La gift card ya no tiene saldo disponible.' });
    }
    console.error('Create booking error:', err.message);
    return res.status(500).json({ error: 'No pudimos crear la reserva. Intentá de nuevo.' });
  }
  if (atomicResult.error === 'slot_unavailable') {
    return res.status(409).json({ error: 'El horario ya no está disponible. Por favor elegí otro.' });
  }
  const booking = atomicResult.booking;
  const finalPrice = atomicResult.final_price;
  const gcDiscount = atomicResult.gift_card_discount;

  const profName = professional ? professional.name : '';
  const bizName = s.business_name || 'Mi Negocio';

  // Crear preferencias de MP solo si el cliente eligió pagar con MP
  let mp_url_deposit = null;
  let mp_url_full = null;

  if (payMethod === 'mp' && mpClient && (effectiveDeposit > 0 || effectivePrice > 0)) {
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
      const isTest = (process.env.MP_ACCESS_TOKEN || '').includes('-TEST-') ||
                     process.env.MP_SANDBOX === 'true';
      return isTest ? r.sandbox_init_point : r.init_point;
    };

    try {
      const tasks = [];
      if (effectiveDeposit > 0) tasks.push(makePref(effectiveDeposit, 'deposit', 'Seña').then(u => { mp_url_deposit = u; }));
      if (effectivePrice   > 0) tasks.push(makePref(effectivePrice,   'full',    'Total').then(u => { mp_url_full = u; }));
      await Promise.all(tasks);
      if (mp_url_deposit || mp_url_full) {
        db.updateBookingPayment(booking.id, { mp_url_deposit, mp_url_full });
      }
    } catch (mpErr) {
      console.error('MP preference error:', mpErr.message);
    }
  }

  // Notificaciones (con las URLs de MP ya disponibles)
  setImmediate(async () => {
    const sendWA    = channel === 'whatsapp' || channel === 'both';
    const sendEmail = channel === 'email'    || channel === 'both';
    const fmtDate   = formatDate(date);

    if (sendWA) {
      await wa.sendTemplate(phone, 'confirmacion_reserva', [
        name, bizName, service.name, profName || '-', fmtDate, time, String(booking.id)
      ]);
      const ownerPhone = s.whatsapp_phone || '';
      if (ownerPhone) {
        await wa.sendTemplate(ownerPhone, 'nueva_reserva', [
          String(booking.id), service.name, name, phone, fmtDate, time
        ]);
      }
    }

    if (sendEmail) {
      const clientEmail = client.email || '';
      if (clientEmail) {
        await emailSvc.sendConfirmation(clientEmail, {
          name, serviceName: service.name, profName: profName || '',
          date: fmtDate, time,
          price: effectivePrice, deposit: effectiveDeposit,
          mp_url_deposit, mp_url_full,
          payment_method: payMethod,
          bank_account: s.bank_account || '',
        }, s);
      }
      const ownerEmail = s.owner_email || '';
      if (ownerEmail) {
        await emailSvc.sendOwnerNotification(ownerEmail, {
          bookingId: String(booking.id), serviceName: service.name,
          clientName: name, phone, date: fmtDate, time,
          price: effectivePrice, deposit: effectiveDeposit,
        }, s);
      }
    }
  });

  res.json({
    success: true,
    booking_id: booking.id,
    deposit: effectiveDeposit,
    price: finalPrice,
    original_price: effectivePrice,
    gift_card_discount: gcDiscount,
    payment_method: payMethod,
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
      const extRef = payData.external_reference || '';

      // ── Gift card payment ────────────────────────────────────────────────────
      if (extRef.startsWith('gc:')) {
        const gcId = parseInt(extRef.slice(3));
        if (!isNaN(gcId)) {
          db.activateGiftCard(gcId);
          const gc = db.getGiftCardById(gcId);
          if (gc) {
            const s = db.getSettings();
            await sendGiftCardEmail(gc, s).catch(() => {});
            console.log(`Gift card activada: #${gcId} código ${gc.code}`);
          }
        }
        return;
      }

      // ── Booking payment ──────────────────────────────────────────────────────
      const [bookingIdStr, payType = 'deposit'] = extRef.split(':');
      const bookingId = parseInt(bookingIdStr);
      if (!isNaN(bookingId)) {
        const newPaymentStatus = payType === 'full' ? 'full' : 'deposit';
        db.updateBookingAdmin(bookingId, { payment_status: newPaymentStatus });
        db.updateBookingPayment(bookingId, {
          deposit_paid: payData.transaction_amount,
          mp_payment_id: String(body.data.id),
        });
        console.log(`MP pago aprobado: booking #${bookingId}, tipo=${payType}, $${payData.transaction_amount}`);

        // Email de pago confirmado al cliente
        const s = db.getSettings();
        const channel = s.notification_channel || 'email';
        if (channel === 'email' || channel === 'both') {
          const b = db.getBookingById(bookingId);
          if (b?.client_email) {
            await emailSvc.sendPaymentConfirmation(b.client_email, {
              name: b.client_name || '',
              serviceName: b.service_name || '',
              date: b.date, time: b.time,
              amountPaid: payData.transaction_amount,
              payType,
              totalPrice: b.total_price || 0,
              mp_url_full: payType === 'deposit' ? (b.mp_url_full || '') : '',
            }, s);
          }
        }
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
  const stored = s.admin_password || process.env.ADMIN_PASSWORD || '';
  if (!password || !verifyPassword(password, stored)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  if (!isPasswordHash(stored)) {
    db.updateSettings({ admin_password: hashPassword(password) });
  }
  req.session.authenticated = true;
  res.json({ success: true });
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

app.post('/api/admin/services/:id/photo', requireAuth, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
  const photoPath = `/uploads/${req.file.filename}`;
  db.updateServicePhoto(parseInt(req.params.id), photoPath);
  res.json({ path: photoPath });
});

app.delete('/api/admin/services/:id/photo', requireAuth, (req, res) => {
  const svc = db.getServiceById(parseInt(req.params.id));
  if (svc?.photo) {
    try { require('fs').unlinkSync(require('path').join(uploadsDir, require('path').basename(svc.photo))); } catch (_e) {}
  }
  db.updateServicePhoto(parseInt(req.params.id), null);
  res.json({ ok: true });
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
app.get('/api/admin/settings', requireAuth, (req, res) => res.json(adminSettings(db.getSettings())));
app.put('/api/admin/settings', requireAuth, (req, res) => {
  const data = pickSettings(req.body);
  if (data.admin_password) data.admin_password = hashPassword(data.admin_password);
  if (data.owner_email && !isValidEmail(data.owner_email)) return res.status(400).json({ error: 'Email inválido' });
  if (data.notification_channel && !['email', 'whatsapp', 'both'].includes(data.notification_channel)) {
    return res.status(400).json({ error: 'Canal inválido' });
  }
  db.updateSettings(data);
  res.json({ success: true });
});

// WhatsApp
app.get('/api/admin/whatsapp/status', requireAuth, (req, res) => {
  res.json({ status: wa.getStatus() });
});

// Email
app.get('/api/admin/email/status', requireAuth, (req, res) => {
  res.json({ status: emailSvc.getStatus(db.getSettings()) });
});
app.post('/api/admin/email/test', requireAuth, async (req, res) => {
  const result = await emailSvc.testConnection(db.getSettings());
  res.json(result);
});
app.post('/api/admin/email/test-review', requireAuth, async (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Falta email' });
  const s = db.getSettings();
  const appUrl = process.env.APP_URL || process.env.PUBLIC_BASE_URL || 'https://mipiel.up.railway.app';
  const token = db.createReviewToken(0, name || 'Cliente de prueba', 'Servicio de prueba');
  const reviewUrl = `${appUrl}/review?token=${token}`;
  const result = await emailSvc.sendReviewRequest({
    client_name: name || 'Cliente de prueba',
    client_email: email,
    service_name: 'Servicio de prueba',
    review_url: reviewUrl,
    business_name: s.business_name || 'Mi Piel',
  }, s);
  res.json({ ...result, review_url: reviewUrl });
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

// ─── QUICK PHOTO — para el Shortcut de iOS de Maru ───────────────────────────
// Recibe una foto, la adjunta a la cita en progreso del día
app.post('/api/quick-photo', upload.single('photo'), async (req, res) => {
  const token = req.headers['x-quick-token'] || req.query.token || '';
  const expected = process.env.QUICK_PHOTO_TOKEN || process.env.ADMIN_PASSWORD || 'admin123';
  if (token !== expected) return res.status(401).json({ error: 'Token inválido' });
  if (!req.file) return res.status(400).json({ error: 'No se recibió foto' });

  const booking = db.getCurrentBooking();
  if (!booking) {
    // Sin cita actual — guardamos la foto sin asociar e informamos
    return res.status(404).json({
      error: 'No hay cita en progreso ahora',
      tip: 'La foto no fue guardada. Verificá el horario.'
    });
  }

  const comment = req.body.comment || '';
  db.addBookingPhoto(booking.id, `/uploads/${req.file.filename}`, comment);

  const [h, m] = booking.time.split(':');
  res.json({
    ok: true,
    booking_id: booking.id,
    client: booking.client_name,
    service: booking.service_name,
    time: booking.time,
    message: `Foto agregada a la cita de ${booking.client_name} (${booking.service_name} ${booking.time})`
  });
});

// ═══════════════════════════════════════════════════════
// ROUTES (wildcard siempre al final)
// ═══════════════════════════════════════════════════════

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/review', (req, res) => res.sendFile(path.join(__dirname, 'public', 'review.html')));
app.get('/gift', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gift.html')));

// ─── GIFT CARDS (público) ────────────────────────────────────────────────────
app.post('/api/gift-cards/check', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Falta código' });
  const gc = db.getGiftCardByCode(code);
  if (!gc || gc.status !== 'active' || gc.balance <= 0)
    return res.status(404).json({ error: 'Código inválido o ya utilizado' });
  res.json({ valid: true, balance: gc.balance, amount: gc.amount });
});

app.post('/api/gift-cards/purchase', async (req, res) => {
  const purchaser_name = sanitizeOptional(req.body.purchaser_name, 120);
  const purchaser_email = sanitizeOptional(req.body.purchaser_email, 160);
  const recipient_name = sanitizeOptional(req.body.recipient_name, 120);
  const note = sanitizeOptional(req.body.note, 1000);
  const amount = parseInt(req.body.amount, 10);
  const payment_method = req.body.payment_method;
  if (!purchaser_name || !purchaser_email || !amount || amount < 100)
    return res.status(400).json({ error: 'Faltan datos o monto inválido' });
  if (!isValidEmail(purchaser_email)) return res.status(400).json({ error: 'Email inválido' });
  const s = db.getSettings();
  const mpSurchargePct = (payment_method === 'mp') ? parseFloat(s.mp_surcharge || '5') / 100 : 0;
  const finalAmount = Math.round(parseInt(amount) * (1 + mpSurchargePct));
  // Queda pendiente hasta confirmación de MP o activación manual de transferencia.
  const status = 'pending';
  const gc = db.createGiftCard({ amount: parseInt(amount), purchaser_name, purchaser_email, recipient_name, note, status });

  if (payment_method === 'mp' && mpClient) {
    try {
      const publicUrl = process.env.PUBLIC_BASE_URL || 'https://mipiel.up.railway.app';
      const pref = new Preference(mpClient);
      const r = await pref.create({ body: {
        items: [{ id: `gc-${gc.id}`, title: `Gift Card ${s.business_name || 'Mi Piel'}`,
          description: recipient_name ? `Para ${recipient_name}` : 'Gift card',
          quantity: 1, unit_price: finalAmount, currency_id: 'UYU' }],
        external_reference: `gc:${gc.id}`,
        back_urls: {
          success: `${publicUrl}/gift?gc_payment=success&gc=${gc.code}&amount=${parseInt(amount)}`,
          failure: `${publicUrl}/gift?gc_payment=failure`,
          pending: `${publicUrl}/gift?gc_payment=pending&gc=${gc.code}&amount=${parseInt(amount)}`,
        },
        auto_return: 'approved',
        notification_url: `${publicUrl}/api/payments/webhook`,
        payer: { email: purchaser_email },
      }});
      const isTest = (process.env.MP_ACCESS_TOKEN || '').includes('-TEST-') || process.env.MP_SANDBOX === 'true';
      const mp_url = isTest ? r.sandbox_init_point : r.init_point;
      return res.json({ success: true, mp_url, code: gc.code });
    } catch(mpErr) {
      console.error('MP gift card error:', mpErr.message);
      return res.status(502).json({ error: 'No pudimos iniciar el pago con Mercado Pago. Probá de nuevo o elegí transferencia.' });
    }
  }

  res.json({ success: true, pending: true });
});

// ─── GIFT CARDS (admin) ───────────────────────────────────────────────────────
app.get('/api/admin/gift-cards', requireAuth, (req, res) => res.json(db.getAllGiftCards()));
app.post('/api/admin/gift-cards', requireAuth, async (req, res) => {
  const { purchaser_name, purchaser_email, recipient_name, amount, note } = req.body;
  if (!amount || amount < 1) return res.status(400).json({ error: 'Monto inválido' });
  const s = db.getSettings();
  const gc = db.createGiftCard({ amount: parseInt(amount), purchaser_name, purchaser_email, recipient_name, note });
  if (purchaser_email) {
    await emailSvc.sendGiftCard({ purchaser_name, purchaser_email, recipient_name,
      code: gc.code, amount: gc.amount, business_name: s.business_name || 'Mi Piel' }, s).catch(()=>{});
  }
  res.json({ success: true, code: gc.code });
});
app.put('/api/admin/gift-cards/:id/cancel', requireAuth, (req, res) => {
  db.cancelGiftCard(parseInt(req.params.id)); res.json({ success: true });
});
app.put('/api/admin/gift-cards/:id/activate', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  db.activateGiftCard(id);
  const gc = db.getGiftCardById(id);
  if (gc) sendGiftCardEmail(gc, db.getSettings()).catch(() => {});
  res.json({ success: true });
});

// ─── MÉTRICAS ─────────────────────────────────────────────────────────────────
app.get('/api/admin/metrics', requireAuth, (req, res) => res.json(db.getMetrics()));

// ─── CRON: recordatorio configurable (cada hora) ─────────────────────────────
cron.schedule('0 * * * *', async () => {
  try {
    const s = db.getSettings();
    if (s.reminder_emails_enabled === '0') return;
    const hours = parseInt(s.reminder_hours || '48');
    const bookings = db.getBookingsNeedingReminder(hours);
    const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    for (const b of bookings) {
      // Marcar primero — si otra instancia ya lo marcó, skip (previene duplicados)
      const claimed = db.markReminderSent(b.id);
      if (!claimed) continue;

      const [y, mo, dy] = b.date.split('-');
      const dateStr = `${parseInt(dy)} de ${months[parseInt(mo)-1]} de ${y}`;
      if (b.client_phone) {
        await wa.sendTemplate(b.client_phone, process.env.WHATSAPP_REMINDER_TEMPLATE || 'recordatorio_turno',
          [b.client_name, b.service_name, dateStr, b.time]).catch(() => {});
      }
      if (b.client_email) {
        await emailSvc.sendReminder({ ...b, date_formatted: dateStr, business_name: s.business_name }).catch(() => {});
      }
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

// ─── CRON: solicitar reseñas (diario 10:30am) ────────────────────────────────
cron.schedule('30 10 * * *', async () => {
  try {
    const s = db.getSettings();
    if (s.reviews_enabled !== '1') return;
    const appUrl = process.env.APP_URL || `https://mipiel.up.railway.app`;
    const bookings = db.getBookingsNeedingReview();
    for (const b of bookings) {
      const claimed = db.markReviewSent(b.id);
      if (!claimed) continue;
      const token = db.createReviewToken(b.id, b.client_name, b.service_name);
      const reviewUrl = `${appUrl}/review?token=${token}`;
      if (b.client_email) {
        await emailSvc.sendReviewRequest({ ...b, review_url: reviewUrl, business_name: s.business_name || 'Mi Piel' }).catch(() => {});
      }
    }
    if (bookings.length) console.log(`Solicitudes de reseña enviadas: ${bookings.length}`);
  } catch (err) { console.error('Cron reseñas:', err.message); }
});

// ─── Reseñas (público) ────────────────────────────────────────────────────────
app.get('/api/reviews', (req, res) => res.json(db.getApprovedReviews()));

app.get('/api/review/check/:token', (req, res) => {
  const r = db.getReviewByToken(req.params.token);
  if (!r) return res.status(404).json({ error: 'Token inválido' });
  res.json({ client_name: r.client_name, service_name: r.service_name, submitted: !!r.submitted });
});

app.post('/api/review/submit', (req, res) => {
  const { token, rating, comment } = req.body;
  if (!token || !rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'Datos inválidos' });
  const ok = db.submitReview(token, { rating: parseInt(rating), comment });
  if (!ok) return res.status(409).json({ error: 'Ya enviada o token inválido' });
  res.json({ success: true });
});

// ─── Reseñas (admin) ──────────────────────────────────────────────────────────
app.get('/api/admin/reviews', requireAuth, (req, res) => res.json(db.getAllReviews()));

app.put('/api/admin/reviews/:id/approve', requireAuth, (req, res) => {
  db.approveReview(parseInt(req.params.id));
  res.json({ success: true });
});

app.delete('/api/admin/reviews/:id', requireAuth, (req, res) => {
  db.deleteReview(parseInt(req.params.id));
  res.json({ success: true });
});

// Wildcard: siempre al final, después de todas las rutas API
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message === 'Solo se permiten imágenes JPG, PNG, WebP o GIF') {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

app.listen(PORT, () => {
  console.log(`\n✅ Agenda corriendo en http://localhost:${PORT}`);
  console.log(`📅 Página de reservas: http://localhost:${PORT}`);
  console.log(`🔐 Panel admin:        http://localhost:${PORT}/admin`);
  console.log(`   Contraseña admin:   configurala desde ADMIN_PASSWORD o el panel\n`);
});
