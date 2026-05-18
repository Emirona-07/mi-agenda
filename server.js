require('dotenv').config();
const QRCodeGen = require('qrcode');
const multer = require('multer');
const cron = require('node-cron');
const emailSvc = require('./email');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const express = require('express');
const crypto = require('crypto');

// Mercado Pago — se inicializa solo si MP_ACCESS_TOKEN está configurado
const mpClient = process.env.MP_ACCESS_TOKEN
  ? new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN })
  : null;
const session = require('express-session');
const path = require('path');
const db = require('./db');
const wa = require('./whatsapp');
const { hashPassword, isPasswordHash, verifyPassword } = require('./auth');
const webPush = require('web-push');

// Web Push — se inicializa solo si hay VAPID keys configuradas
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(
    `mailto:${process.env.OWNER_EMAIL || 'admin@mipiel.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

async function sendPushToAll(payload) {
  if (!process.env.VAPID_PUBLIC_KEY) return;
  const subs = db.getAllPushSubscriptions();
  if (!subs.length) return;
  const msg = JSON.stringify(payload);
  await Promise.allSettled(
    subs.map(s =>
      webPush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        msg
      ).catch(err => {
        // 410 Gone = subscription expired, remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          db.deletePushSubscription(s.endpoint);
        }
      })
    )
  );
}

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET
  || process.env.ADMIN_PASSWORD
  || crypto.randomBytes(32).toString('hex');
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

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
      const name = crypto.randomBytes(16).toString('hex');
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

function loginKey(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
}

function isLoginLimited(req) {
  const key = loginKey(req);
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedLogin(req) {
  const key = loginKey(req);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
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

function normalizeIdList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(v => parseInt(v, 10)).filter(Number.isInteger).filter(v => v > 0))]
    : [];
}

function normalizeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : '#2d6a4f';
}

function parseNonNegativeNumber(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMercadoPagoSignature(signature = '') {
  return signature.split(',').reduce((acc, part) => {
    const [key, ...rest] = part.split('=');
    if (!key || !rest.length) return acc;
    acc[key.trim()] = rest.join('=').trim();
    return acc;
  }, {});
}

function safeCompareHex(a, b) {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b) || a.length !== b.length || a.length % 2 !== 0) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function isMercadoPagoWebhookVerified(req) {
  const secret = process.env.MP_WEBHOOK_SECRET || process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  if (!secret) return true;

  const { ts, v1 } = parseMercadoPagoSignature(req.get('x-signature') || '');
  if (!ts || !v1) return false;

  let manifest = '';
  if (req.query['data.id']) manifest += `id:${req.query['data.id']};`;
  if (req.get('x-request-id')) manifest += `request-id:${req.get('x-request-id')};`;
  manifest += `ts:${ts};`;

  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return safeCompareHex(expected, v1);
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

async function sendGiftCardEmails(gc, settings) {
  const biz = settings.business_name || 'Mi Piel';
  const tasks = [];
  if (gc?.purchaser_email) {
    tasks.push(emailSvc.sendGiftCard({
      purchaser_name: gc.purchaser_name,
      purchaser_email: gc.purchaser_email,
      recipient_name: gc.recipient_name,
      code: gc.code, amount: gc.amount, business_name: biz,
    }, settings));
  }
  if (gc?.recipient_email) {
    tasks.push(emailSvc.sendGiftCardRecipient({
      purchaser_name: gc.purchaser_name,
      recipient_name: gc.recipient_name,
      recipient_email: gc.recipient_email,
      code: gc.code, amount: gc.amount, business_name: biz,
    }, settings));
  }
  await Promise.allSettled(tasks);
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

  // Si el cliente está logueado con Google, usar su registro existente (evita duplicados)
  let client;
  if (req.session.clientUser) {
    client = db.getClientById(req.session.clientUser.id);
    // Actualizar teléfono/email si no los tenía
    if (client && (phone || email)) {
      db.updateClient(client.id, {
        name: client.name,
        phone: phone || client.phone,
        email: email || client.email,
        instagram: instagram || client.instagram,
        notes: client.notes,
      });
      client = db.getClientById(client.id);
    }
  }
  if (!client) client = db.upsertClient({ name, phone, email, instagram });
  const professional = professional_id ? db.getProfessionalById(parseInt(professional_id)) : service.professionals[0] || null;

  // Precios: el recargo MP se aplica sobre el neto DESPUÉS del descuento de gift card
  const payMethod = payment_method === 'mp' ? 'mp' : payment_method === 'transfer' ? 'transfer' : 'cash';
  const mpSurchargePct = payMethod === 'mp' ? parseFloat(s.mp_surcharge || '5') / 100 : 0;
  const basePrice   = service.price   > 0 ? service.price   : 0;
  const baseDeposit = service.deposit > 0 ? service.deposit : 0;

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
      effective_price: basePrice, // precio base sin recargo; el recargo se aplica al neto
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
  const gcDiscount = atomicResult.gift_card_discount;
  const netPrice = atomicResult.final_price; // precio base neto de gift card

  // Aplicar recargo MP al neto (no al precio bruto)
  const effectivePrice   = netPrice   > 0 ? Math.round(netPrice   * (1 + mpSurchargePct)) : 0;
  // Seña: solo si no hubo gift card; si la gc cubre parcialmente, no cobramos seña separada
  const effectiveDeposit = gcDiscount > 0 ? 0 : (baseDeposit > 0 ? Math.round(baseDeposit * (1 + mpSurchargePct)) : 0);

  const finalPrice = effectivePrice; // lo que el cliente realmente paga (neto + recargo)

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

    // Push notification al admin (inmediato, independiente del canal)
    sendPushToAll({
      title: `Nueva reserva — ${service.name}`,
      body:  `${name} · ${fmtDate} ${time}`,
      tag:   `booking-${booking.id}`,
      url:   `/admin?booking=${booking.id}`,
    }).catch(() => {});

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
          clientName: name, phone, email, date: fmtDate, time,
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
    const body = Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString('utf8'))
      : typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!isMercadoPagoWebhookVerified(req)) {
      console.warn('MP webhook ignored: invalid signature');
      return;
    }
    if (body?.type !== 'payment' || !body.data?.id) return;
    if (!mpClient) return;
    const payment = new Payment(mpClient);
    const payData = await payment.get({ id: body.data.id });
    if (payData.status === 'approved') {
      const extRef = payData.external_reference || '';

      // ── Gift card payment ────────────────────────────────────────────────────
      if (extRef.startsWith('gc:')) {
        const gcId = parseInt(extRef.slice(3));
        if (!isNaN(gcId)) {
          const current = db.getGiftCardById(gcId);
          if (!current || current.status !== 'pending') return;

          db.activateGiftCard(gcId);
          const gc = db.getGiftCardById(gcId);
          if (gc) {
            const s = db.getSettings();
            await sendGiftCardEmails(gc, s).catch(() => {});
            console.log(`Gift card activada: #${gcId} código ${gc.code}`);
          }
        }
        return;
      }

      // ── Booking payment ──────────────────────────────────────────────────────
      const [bookingIdStr, rawPayType = 'deposit'] = extRef.split(':');
      const payType = ['deposit', 'full'].includes(rawPayType) ? rawPayType : 'deposit';
      const bookingId = parseInt(bookingIdStr);
      if (!isNaN(bookingId)) {
        const newPaymentStatus = payType === 'full' ? 'full' : 'deposit';
        const current = db.getBookingById(bookingId);
        if (!current) return;
        const alreadyRecorded =
          String(current.mp_payment_id || '') === String(body.data.id) &&
          current.payment_status === newPaymentStatus;
        if (alreadyRecorded) return;

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
  if (isLoginLimited(req)) {
    return res.status(429).json({ error: 'Demasiados intentos. Probá de nuevo en unos minutos.' });
  }
  const { password } = req.body;
  const s = db.getSettings();
  const stored = s.admin_password || process.env.ADMIN_PASSWORD || '';
  if (!password || !verifyPassword(password, stored)) {
    recordFailedLogin(req);
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  if (!isPasswordHash(stored)) {
    db.updateSettings({ admin_password: hashPassword(password) });
  }
  loginAttempts.delete(loginKey(req));
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
app.post('/api/admin/bookings', requireAuth, (req, res) => {
  const { date, time, service_id, professional_id, status } = req.body;
  const client_name = sanitizeOptional(req.body.client_name, 120);
  const client_phone = sanitizeOptional(req.body.client_phone, 40);
  const client_email = sanitizeOptional(req.body.client_email, 160);
  const notes = sanitizeOptional(req.body.notes, 1000);
  const total_price = parseNonNegativeNumber(req.body.total_price);
  if (!date || !time || !service_id || !client_name)
    return res.status(400).json({ error: 'Faltan campos: date, time, service_id, client_name' });
  const service = db.getServiceById(parseInt(service_id));
  if (!service) return res.status(404).json({ error: 'Servicio no encontrado' });
  const client = db.upsertClient({ name: client_name, phone: client_phone, email: client_email });
  const professional = professional_id ? db.getProfessionalById(parseInt(professional_id)) : service.professionals[0] || null;
  const booking = db.createBooking({
    client_id: client.id,
    service_id: parseInt(service_id),
    professional_id: professional ? professional.id : null,
    date, time, notes,
    total_price: total_price || service.price || 0,
    deposit_paid: 0,
    status: ['confirmed','cancelled','completed','pending'].includes(status) ? status : 'confirmed',
  });
  res.json({ success: true, booking_id: booking.id });
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
// Fusionar cliente: mueve todas las reservas de sourceId a targetId y elimina sourceId
app.post('/api/admin/clients/:id/merge/:sourceId', requireAuth, (req, res) => {
  const targetId = parseInt(req.params.id);
  const sourceId = parseInt(req.params.sourceId);
  if (targetId === sourceId) return res.status(400).json({ error: 'Mismo cliente' });
  const target = db.getClientById(targetId);
  const source = db.getClientById(sourceId);
  if (!target || !source) return res.status(404).json({ error: 'Cliente no encontrado' });
  db.mergeClients(targetId, sourceId);
  res.json({ success: true });
});

// Services
app.get('/api/admin/services', requireAuth, (req, res) => res.json(db.getAllServices()));
app.post('/api/admin/services', requireAuth, (req, res) => {
  const { name, duration, price, deposit, description, professional_ids } = req.body;
  const cleanName = sanitizeOptional(name, 120);
  if (!cleanName) return res.status(400).json({ error: 'Nombre requerido' });
  res.json(db.createService({
    name: cleanName,
    duration: parsePositiveInt(duration, 60),
    price: parseNonNegativeNumber(price),
    deposit: parseNonNegativeNumber(deposit),
    description: sanitizeOptional(description, 1000),
    professional_ids: normalizeIdList(professional_ids),
  }));
});
app.put('/api/admin/services/:id', requireAuth, (req, res) => {
  const { name, duration, price, deposit, description, active, professional_ids } = req.body;
  const cleanName = sanitizeOptional(name, 120);
  if (!cleanName) return res.status(400).json({ error: 'Nombre requerido' });
  db.updateService(parseInt(req.params.id), {
    name: cleanName,
    duration: parsePositiveInt(duration, 60),
    price: parseNonNegativeNumber(price),
    deposit: parseNonNegativeNumber(deposit),
    description: sanitizeOptional(description, 1000),
    active: !!active,
    professional_ids: professional_ids === undefined ? undefined : normalizeIdList(professional_ids),
  });
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
app.post('/api/admin/professionals', requireAuth, (req, res) => {
  const name = sanitizeOptional(req.body.name, 120);
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  res.json(db.createProfessional({ name, color: normalizeColor(req.body.color) }));
});
app.put('/api/admin/professionals/:id', requireAuth, (req, res) => {
  const name = sanitizeOptional(req.body.name, 120);
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  db.updateProfessional(parseInt(req.params.id), {
    name,
    color: normalizeColor(req.body.color),
    active: !!req.body.active,
  });
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
  const expected = process.env.WHATSAPP_WEBHOOK_TOKEN || '';
  if (!expected) return res.sendStatus(403);
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

function getOrCreateQuickPhotoToken() {
  // Env var takes precedence; if not set, use/generate DB token
  if (process.env.QUICK_PHOTO_TOKEN) return process.env.QUICK_PHOTO_TOKEN;
  const s = db.getSettings();
  if (s.quick_photo_token) return s.quick_photo_token;
  const token = crypto.randomBytes(24).toString('hex');
  db.updateSettings({ quick_photo_token: token });
  return token;
}

// Descarga el Atajo de iOS pre-configurado
app.get('/api/admin/shortcuts/quick-photo', requireAuth, (req, res) => {
  const token = getOrCreateQuickPhotoToken();
  const publicUrl = process.env.PUBLIC_BASE_URL || 'https://mipiel.up.railway.app';
  const url = `${publicUrl}/api/turno?token=${token}`;

  const PHOTO_UUID = 'A0B1C2D3-E4F5-4A6B-8C7D-9E0F1A2B3C4D';
  const REQ_UUID   = 'B1C2D3E4-F5A6-4B7C-9D8E-0F1A2B3C4D5E';
  const ORC = '￼'; // Unicode Object Replacement Character

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
  <key>WFWorkflowMinimumClientVersionString</key><string>900</string>
  <key>WFWorkflowClientVersion</key><string>1282.16</string>
  <key>WFWorkflowName</key><string>Quick Photo Mi Piel</string>
  <key>WFWorkflowHasShortcutInputVariables</key><false/>
  <key>WFWorkflowImportQuestions</key><array/>
  <key>WFWorkflowTypes</key><array/>
  <key>WFWorkflowInputContentItemClasses</key>
  <array>
    <string>WFImageContentItem</string>
    <string>WFPhotoMediaContentItem</string>
  </array>
  <key>WFWorkflowIcon</key>
  <dict>
    <key>WFWorkflowIconStartColor</key><integer>946986751</integer>
    <key>WFWorkflowIconGlyphNumber</key><integer>59512</integer>
  </dict>
  <key>WFWorkflowActions</key>
  <array>
    <dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.takephoto</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key><string>${PHOTO_UUID}</string>
        <key>WFPhotoCount</key><integer>1</integer>
        <key>WFCameraCaptureShowPreview</key><true/>
      </dict>
    </dict>
    <dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.downloadurl</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key><string>${REQ_UUID}</string>
        <key>WFHTTPMethod</key><string>POST</string>
        <key>WFURL</key><string>${url}</string>
        <key>WFHTTPBodyType</key><string>Form</string>
        <key>WFFormValues</key>
        <dict>
          <key>Value</key>
          <dict>
            <key>WFDictionaryFieldValueItems</key>
            <array>
              <dict>
                <key>WFItemType</key><integer>0</integer>
                <key>WFKey</key>
                <dict>
                  <key>Value</key><dict><key>string</key><string>photo</string></dict>
                  <key>WFSerializationType</key><string>WFTextTokenString</string>
                </dict>
                <key>WFValue</key>
                <dict>
                  <key>Value</key>
                  <dict>
                    <key>attachmentsByRange</key>
                    <dict>
                      <key>{0, 1}</key>
                      <dict>
                        <key>OutputName</key><string>Photo</string>
                        <key>OutputUUID</key><string>${PHOTO_UUID}</string>
                        <key>Type</key><string>ActionOutput</string>
                      </dict>
                    </dict>
                    <key>string</key><string>${ORC}</string>
                  </dict>
                  <key>WFSerializationType</key><string>WFTextTokenString</string>
                </dict>
              </dict>
            </array>
          </dict>
          <key>WFSerializationType</key><string>WFDictionaryFieldValue</string>
        </dict>
      </dict>
    </dict>
    <dict>
      <key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.showresult</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>Text</key>
        <dict>
          <key>Value</key>
          <dict>
            <key>attachmentsByRange</key>
            <dict>
              <key>{0, 1}</key>
              <dict>
                <key>OutputName</key><string>Result</string>
                <key>OutputUUID</key><string>${REQ_UUID}</string>
                <key>Type</key><string>ActionOutput</string>
              </dict>
            </dict>
            <key>string</key><string>${ORC}</string>
          </dict>
          <key>WFSerializationType</key><string>WFTextTokenString</string>
        </dict>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="quick-photo-mipiel.shortcut"');
  res.send(Buffer.from(plist, 'utf8'));
});

// Lista de citas recientes para el selector del Turno app
app.get('/api/turno/bookings', (req, res) => {
  const token = req.query.token || '';
  const expected = getOrCreateQuickPhotoToken();
  if (!expected || token !== expected) return res.status(401).json({ error: 'Token inválido' });

  const now = new Date();
  const from = localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2));
  const to   = localDateString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));

  const { bookings } = db.getBookings({ from, to, limit: 200 });
  const active = (bookings || []).filter(b => b.status !== 'cancelled');

  const current = db.getCurrentBooking();
  res.json({ bookings: active, current_id: current ? current.id : null });
});

app.post('/api/turno/charge', async (req, res) => {
  try {
    const token = req.query.token || '';
    const expected = getOrCreateQuickPhotoToken();
    if (!expected || token !== expected) return res.status(401).json({ error: 'Token inválido' });

    const bookingId = parseInt(req.body && req.body.booking_id);
    if (!bookingId) return res.status(400).json({ error: 'booking_id inválido' });

    const booking = db.getBookingById(bookingId);
    if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });

    if (booking.payment_status === 'full') return res.json({ already_paid: true });

    if (!mpClient) return res.status(503).json({ error: 'Mercado Pago no configurado' });

    const remainingAmount = booking.payment_status === 'deposit'
      ? Math.max(0, booking.total_price - (booking.deposit_paid || 0))
      : (booking.total_price || 0);

    if (remainingAmount <= 0) return res.json({ already_paid: true });

    const bizName = (db.getSettings().business_name || 'Mi Piel');
    const publicUrl = process.env.PUBLIC_BASE_URL || 'https://mipiel.up.railway.app';
    const isTest = (process.env.MP_ACCESS_TOKEN || '').includes('-TEST-') || process.env.MP_SANDBOX === 'true';

    const pref = new Preference(mpClient);
    const r = await pref.create({
      body: {
        items: [{
          id: `qp-${booking.id}`,
          title: `${booking.service_name} · ${booking.client_name}`,
          description: `Reserva #${booking.id}`,
          quantity: 1,
          unit_price: remainingAmount,
          currency_id: 'UYU',
        }],
        external_reference: `${booking.id}:full`,
        notification_url: `${publicUrl}/api/payments/webhook`,
        statement_descriptor: bizName.slice(0, 22),
        metadata: { booking_id: booking.id, pay_type: 'full' },
      }
    });

    const init_point = isTest ? r.sandbox_init_point : r.init_point;
    if (!init_point) {
      console.error('MP preference created but no init_point:', JSON.stringify(r));
      return res.status(500).json({ error: 'MP no devolvió URL de pago' });
    }

    const qr_data_url = await QRCodeGen.toDataURL(init_point, { width: 280, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    res.json({ init_point, preference_id: r.id, amount: remainingAmount, qr_data_url });
  } catch (err) {
    console.error('Error in /api/turno/charge:', err);
    res.status(500).json({ error: err.message || 'Error al crear preferencia de pago' });
  }
});

app.get('/api/turno/payment-status', (req, res) => {
  const token = req.query.token || '';
  const expected = getOrCreateQuickPhotoToken();
  if (!expected || token !== expected) return res.status(401).json({ error: 'Token inválido' });

  const { booking_id } = req.query;
  const booking = db.getBookingById(booking_id);
  if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });

  res.json({ payment_status: booking.payment_status });
});

app.post('/api/turno/mark-paid', (req, res) => {
  const token = req.query.token || '';
  const expected = getOrCreateQuickPhotoToken();
  if (!expected || token !== expected) return res.status(401).json({ error: 'Token inválido' });

  const bookingId = parseInt(req.body.booking_id);
  const method = req.body.method || 'other'; // 'cash' | 'transfer' | 'qr' | 'other'
  if (!bookingId) return res.status(400).json({ error: 'booking_id requerido' });

  const booking = db.getBookingById(bookingId);
  if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
  if (booking.payment_status === 'full') return res.json({ ok: true, already_paid: true });

  const methodLabel = { cash: 'Efectivo', transfer: 'Transferencia', qr: 'QR físico' }[method] || method;
  const noteAppend = `[Cobrado: ${methodLabel}]`;
  const currentNotes = booking.notes_admin || '';
  const newNotes = currentNotes ? `${currentNotes}\n${noteAppend}` : noteAppend;

  db.updateBookingAdmin(bookingId, { payment_status: 'full', notes_admin: newNotes });
  res.json({ ok: true });
});

app.post('/api/turno/note', (req, res) => {
  const token = req.query.token || '';
  const expected = getOrCreateQuickPhotoToken();
  if (!expected || token !== expected) return res.status(401).json({ error: 'Token inválido' });

  const bookingId = parseInt(req.body.booking_id);
  const notes_public = (req.body.notes_public || '').trim();
  if (!bookingId) return res.status(400).json({ error: 'booking_id requerido' });

  const booking = db.getBookingById(bookingId);
  if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });

  db.updateBookingPublicNote(bookingId, notes_public);
  res.json({ ok: true });
});

// Recibe una foto, la adjunta a la cita en progreso del día
async function handleTurnoPhotoUpload(req, res) {
  const token = req.headers['x-quick-token'] || req.query.token || '';
  const expected = process.env.QUICK_PHOTO_TOKEN || db.getSettings().quick_photo_token || '';
  if (!expected) return res.status(503).json({ error: 'Quick photo no configurado' });
  if (token !== expected) return res.status(401).json({ error: 'Token inválido' });
  if (!req.file) return res.status(400).json({ error: 'No se recibió foto' });

  // Usar booking_id del body si se especificó, si no la cita en progreso
  let booking = null;
  const bodyBookingId = req.body.booking_id ? parseInt(req.body.booking_id) : null;
  if (bodyBookingId) {
    booking = db.getBookingById(bodyBookingId);
  }
  if (!booking) booking = db.getCurrentBooking();

  if (!booking) {
    return res.status(404).json({
      error: 'No hay cita en progreso ahora',
      tip: 'Seleccioná una cita manualmente.'
    });
  }

  const comment = req.body.comment || '';
  db.addBookingPhoto(booking.id, `/uploads/${req.file.filename}`, comment);

  res.json({
    ok: true,
    booking_id: booking.id,
    client: booking.client_name,
    service: booking.service_name,
    time: booking.time,
    message: `Foto agregada a la cita de ${booking.client_name} (${booking.service_name} ${booking.time})`
  });
}

app.post('/api/turno', upload.single('photo'), handleTurnoPhotoUpload);
// Alias retrocompatible para Shortcuts de iOS ya descargados
app.post('/api/quick-photo', upload.single('photo'), handleTurnoPhotoUpload);

// ═══════════════════════════════════════════════════════
// ROUTES (wildcard siempre al final)
// ═══════════════════════════════════════════════════════

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/review', (req, res) => res.sendFile(path.join(__dirname, 'public', 'review.html')));
app.get('/gift', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gift.html')));
// Quick Photo — link con token embebido (admin genera, Maru guarda en inicio)
app.get('/api/admin/quick-photo-link', requireAuth, (req, res) => {
  const token = getOrCreateQuickPhotoToken();
  const publicUrl = process.env.PUBLIC_BASE_URL || 'https://mipiel.up.railway.app';
  res.json({ url: `${publicUrl}/turno?token=${token}` });
});
app.get('/turno', (req, res) => res.sendFile(path.join(__dirname, 'public', 'quick-photo.html')));
app.get('/quick-photo', (req, res) => res.redirect(301, '/turno' + (req.query.token ? `?token=${req.query.token}` : '')));

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
  const recipient_name  = sanitizeOptional(req.body.recipient_name, 120);
  const recipient_email = req.body.recipient_email ? sanitizeOptional(req.body.recipient_email, 160) : '';
  const note = sanitizeOptional(req.body.note, 1000);
  const amount = parseInt(req.body.amount, 10);
  const payment_method = req.body.payment_method;
  if (!purchaser_name || !purchaser_email || !amount || amount < 100)
    return res.status(400).json({ error: 'Faltan datos o monto inválido' });
  if (!isValidEmail(purchaser_email)) return res.status(400).json({ error: 'Email inválido' });
  if (recipient_email && !isValidEmail(recipient_email)) return res.status(400).json({ error: 'Email del destinatario inválido' });
  const s = db.getSettings();
  const mpSurchargePct = (payment_method === 'mp') ? parseFloat(s.mp_surcharge || '5') / 100 : 0;
  const finalAmount = Math.round(parseInt(amount) * (1 + mpSurchargePct));
  // Queda pendiente hasta confirmación de MP o activación manual de transferencia.
  const status = 'pending';
  const gc = db.createGiftCard({ amount: parseInt(amount), purchaser_name, purchaser_email, recipient_name, recipient_email, note, status });

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
  if (gc) sendGiftCardEmails(gc, db.getSettings()).catch(() => {});
  res.json({ success: true });
});

// ─── MÉTRICAS ─────────────────────────────────────────────────────────────────
// ─── Push notifications ───────────────────────────────────────────────────────
app.get('/api/admin/push/vapid-key', requireAuth, (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  res.json({ key: key || null });
});

app.post('/api/admin/push/subscribe', requireAuth, (req, res) => {
  const { endpoint, keys, label } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth)
    return res.status(400).json({ error: 'Datos de suscripción inválidos' });
  db.savePushSubscription({ endpoint, p256dh: keys.p256dh, auth: keys.auth, label: label || '' });
  res.json({ success: true });
});

app.delete('/api/admin/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) db.deletePushSubscription(endpoint);
  res.json({ success: true });
});

// ─── MÉTRICAS ─────────────────────────────────────────────────────────────────
app.get('/api/admin/metrics', requireAuth, (req, res) => {
  const { year, month } = req.query;
  res.json(db.getMetrics({ year, month }));
});

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
