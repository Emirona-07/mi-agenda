'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const express = require('express');
const session = require('express-session');
const cron = require('node-cron');
const multer = require('multer');

const db = require('./db');
const wa = require('./whatsapp');
const email = require('./email');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_PATH = path.join(__dirname, 'public');

// ─── Directorio de uploads ─────────────────────────────────────────────────────
const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const uploadsDir = path.join(DB_DIR, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo imágenes'), false);
  },
});

// ─── Middlewares globales ──────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: 'agenda.sid',
  store: db.createSessionStore(session),
  secret: process.env.SESSION_SECRET || 'change-me-in-railway',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30,
  },
}));

app.use('/uploads', express.static(uploadsDir));
app.use(express.static(PUBLIC_PATH));

// ─── Helpers ───────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'No autorizado' });
}

function publicBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
  if (configured) {
    const base = configured.startsWith('http') ? configured : `https://${configured}`;
    return base.replace(/\/$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

function googleRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${publicBaseUrl(req)}/auth/google/callback`;
}

function requireGoogleConfig(res) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    res.status(503).json({
      error: 'Google login no está configurado todavía',
      missing: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    });
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS PÚBLICAS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    whatsapp: wa.getStatus(),
    email: email.getStatus(),
    google: process.env.GOOGLE_CLIENT_ID ? 'configured' : 'not_configured',
  });
});

app.get('/api/settings/public', (_req, res) => {
  const s = db.getSettings();
  res.json({
    business_name: s.business_name,
    phone: s.phone,
    address: s.address,
    logo_url: s.logo_url,
    primary_color: s.primary_color,
  });
});

app.get('/api/services', (_req, res) => {
  res.json(db.getActiveServices());
});

app.get('/api/professionals', (_req, res) => {
  res.json(db.getProfessionals().filter((p) => p.active));
});

app.get('/api/availability/dates', (req, res) => {
  const { service_id, professional_id } = req.query;
  res.json(db.getAvailableDates(service_id ? parseInt(service_id) : null, professional_id ? parseInt(professional_id) : null));
});

app.get('/api/availability/slots', (req, res) => {
  const { date, service_id, professional_id } = req.query;
  if (!date) return res.status(400).json({ error: 'Falta el parámetro date' });
  res.json(db.getAvailableSlots(date, service_id ? parseInt(service_id) : null, professional_id ? parseInt(professional_id) : null));
});

// ─── Reserva pública ──────────────────────────────────────────────────────────
app.post('/api/bookings', async (req, res, next) => {
  try {
    const { name, phone, email: clientEmail, service_id, professional_id, date, time, notes, utm_source } = req.body;
    if (!name || !phone || !service_id || !date || !time) {
      return res.status(400).json({ error: 'Faltan campos requeridos: name, phone, service_id, date, time' });
    }

    const client = db.upsertClient({ name, phone, email: clientEmail });
    const booking = db.createBooking({
      client_id: client.id,
      service_id: parseInt(service_id),
      professional_id: professional_id ? parseInt(professional_id) : null,
      date,
      time,
      notes,
      utm_source,
    });

    // Notificaciones — no bloquear la respuesta
    const s = db.getSettings();
    const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const [y, mo, dy] = date.split('-');
    const dateFormatted = `${parseInt(dy)} de ${months[parseInt(mo) - 1]} de ${y}`;

    Promise.allSettled([
      phone && wa.sendTemplate(phone, process.env.WHATSAPP_TEMPLATE_NAME || 'reserva_confirmada', [name, booking.service_name, dateFormatted, time]).catch(() => {}),
      s.whatsapp_phone && wa.sendTemplate(s.whatsapp_phone, process.env.WHATSAPP_BUSINESS_TEMPLATE_NAME || 'nueva_reserva_negocio', [name, phone, booking.service_name, `${dateFormatted} ${time}`]).catch(() => {}),
    ]);

    res.status(201).json({ ok: true, booking });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ADMIN
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/login', (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(503).json({ error: 'ADMIN_PASSWORD no configurado' });
  if (req.body.password !== expected) return res.status(401).json({ error: 'Contraseña incorrecta' });
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', requireAuth, (req, res) => {
  res.json({ isAdmin: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/settings', requireAuth, (_req, res) => {
  res.json(db.getSettings());
});

app.put('/api/admin/settings', requireAuth, (req, res) => {
  res.json(db.updateSettings(req.body));
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — PROFESSIONALS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/professionals', requireAuth, (_req, res) => {
  res.json(db.getProfessionals());
});

app.post('/api/admin/professionals', requireAuth, (req, res) => {
  const p = db.createProfessional(req.body);
  res.status(201).json(p);
});

app.put('/api/admin/professionals/:id', requireAuth, (req, res) => {
  res.json(db.updateProfessional(parseInt(req.params.id), req.body));
});

app.delete('/api/admin/professionals/:id', requireAuth, (req, res) => {
  db.deleteProfessional(parseInt(req.params.id));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — SERVICES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/services', requireAuth, (_req, res) => {
  res.json(db.getAllServices());
});

app.post('/api/admin/services', requireAuth, (req, res) => {
  res.status(201).json(db.createService(req.body));
});

app.put('/api/admin/services/:id', requireAuth, (req, res) => {
  res.json(db.updateService(parseInt(req.params.id), req.body));
});

app.delete('/api/admin/services/:id', requireAuth, (req, res) => {
  db.deleteService(parseInt(req.params.id));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — BUSINESS HOURS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/business-hours', requireAuth, (_req, res) => {
  res.json(db.getBusinessHours());
});

app.put('/api/admin/business-hours', requireAuth, (req, res) => {
  res.json(db.updateBusinessHours(req.body));
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — CLIENTS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/clients', requireAuth, (_req, res) => {
  res.json(db.getClients());
});

app.get('/api/admin/clients/:id', requireAuth, (req, res) => {
  const client = db.getClientById(parseInt(req.params.id));
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json({ client, bookings: db.getClientBookings(client.id) });
});

app.put('/api/admin/clients/:id', requireAuth, (req, res) => {
  res.json(db.updateClient(parseInt(req.params.id), req.body));
});

app.delete('/api/admin/clients/:id', requireAuth, (req, res) => {
  db.deleteClient(parseInt(req.params.id));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — BOOKINGS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/bookings', requireAuth, (req, res) => {
  res.json(db.getBookings(req.query));
});

app.get('/api/admin/bookings/:id', requireAuth, (req, res) => {
  const booking = db.getBookingById(parseInt(req.params.id));
  if (!booking) return res.status(404).json({ error: 'Turno no encontrado' });
  res.json(booking);
});

app.post('/api/admin/bookings', requireAuth, (req, res, next) => {
  try {
    const booking = db.createBooking(req.body);
    res.status(201).json(booking);
  } catch (err) { next(err); }
});

app.put('/api/admin/bookings/:id', requireAuth, (req, res, next) => {
  try {
    const { payment_status, notes_admin, ...rest } = req.body;
    // Actualizar campos generales
    let booking = db.updateBooking(parseInt(req.params.id), { ...rest, payment_status, notes_admin });
    res.json(booking);
  } catch (err) { next(err); }
});

app.delete('/api/admin/bookings/:id', requireAuth, (req, res) => {
  db.cancelBooking(parseInt(req.params.id));
  res.json({ ok: true });
});

// ─── Admin notes y payment_status ────────────────────────────────────────────
app.put('/api/admin/bookings/:id/admin-notes', requireAuth, (req, res) => {
  db.updateBookingAdmin(parseInt(req.params.id), {
    notes_admin: req.body.notes_admin,
    payment_status: req.body.payment_status,
  });
  res.json({ success: true });
});

// ─── Fotos de citas (admin) ───────────────────────────────────────────────────
app.get('/api/admin/bookings/:id/photos', requireAuth, (req, res) => {
  res.json(db.getBookingPhotos(parseInt(req.params.id)));
});

app.post('/api/admin/bookings/:id/photos', requireAuth, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió foto' });
  const photo = db.addBookingPhoto(
    parseInt(req.params.id),
    `/uploads/${req.file.filename}`,
    req.body.comment || ''
  );
  res.json(photo);
});

app.delete('/api/admin/bookings/:id/photos/:photoId', requireAuth, (req, res) => {
  const photo = db.deleteBookingPhoto(parseInt(req.params.photoId));
  if (photo) {
    const fullPath = path.join(uploadsDir, path.basename(photo.file_path));
    try { fs.unlinkSync(fullPath); } catch (e) { /* archivo ya eliminado */ }
  }
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — STATS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/dashboard', requireAuth, (_req, res) => {
  res.json(db.getDashboardStats());
});

app.get('/api/admin/revenue', requireAuth, (req, res) => {
  res.json(db.getRevenue(req.query));
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH CLIENTE — Google OAuth
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/auth/google', (req, res) => {
  if (!requireGoogleConfig(res)) return;
  const state = crypto.randomBytes(24).toString('hex');
  req.session.googleOAuthState = state;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/auth/google/callback', async (req, res, next) => {
  try {
    if (!requireGoogleConfig(res)) return;
    if (!req.query.state || req.query.state !== req.session.googleOAuthState) {
      return res.redirect('/?login=error');
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(req.query.code || ''),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: googleRedirectUri(req),
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('Error OAuth Google:', JSON.stringify(tokenData.error || tokenData));
      return res.redirect('/?login=error');
    }

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();
    if (!profileRes.ok) {
      console.error('Error perfil Google:', JSON.stringify(profile.error || profile));
      return res.redirect('/?login=error');
    }

    const client = db.findOrCreateClientByGoogle({
      google_id: profile.sub,
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
    });

    req.session.clientUser = { id: client.id, name: client.name, email: client.email };
    delete req.session.googleOAuthState;
    res.redirect('/?login=success');
  } catch (err) {
    next(err);
  }
});

// ─── API de cliente autenticado ───────────────────────────────────────────────

app.get('/api/client/me', (req, res) => {
  if (!req.session.clientUser) return res.json({ user: null });
  const client = db.getClientById(req.session.clientUser.id);
  res.json({ user: client || req.session.clientUser });
});

app.get('/api/client/my-bookings', (req, res) => {
  if (!req.session.clientUser) return res.status(401).json({ error: 'No autenticado' });
  res.json(db.getClientBookings(req.session.clientUser.id));
});

app.post('/api/client/my-bookings/:id/cancel', (req, res) => {
  if (!req.session.clientUser) return res.status(401).json({ error: 'No autenticado' });
  const result = db.cancelClientBooking(parseInt(req.params.id), req.session.clientUser.id);
  if (result.error) {
    const statusMap = { not_found: 404, not_authorized: 403, turno_pasado: 400, ya_cancelado: 400 };
    return res.status(statusMap[result.error] || 400).json({ error: result.error });
  }
  res.json(result);
});

app.get('/api/client/my-bookings/:id/photos', (req, res) => {
  if (!req.session.clientUser) return res.status(401).json({ error: 'No autenticado' });
  const bookings = db.getClientBookings(req.session.clientUser.id);
  const booking = bookings.find((b) => b.id === parseInt(req.params.id));
  if (!booking) return res.status(403).json({ error: 'Sin acceso' });
  res.json(db.getBookingPhotos(parseInt(req.params.id)));
});

app.post('/api/client/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.status ? err.message : 'Ocurrió un error inesperado',
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════════════════════════════════════════

// Recordatorio 48h — corre cada hora
cron.schedule('0 * * * *', async () => {
  try {
    const bookings = db.getBookingsNeedingReminder();
    for (const b of bookings) {
      const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
      const [y, mo, dy] = b.date.split('-');
      const dateStr = `${parseInt(dy)} de ${months[parseInt(mo) - 1]} de ${y}`;
      const s = db.getSettings();

      if (b.client_phone) {
        await wa.sendTemplate(
          b.client_phone,
          process.env.WHATSAPP_REMINDER_TEMPLATE || 'recordatorio_turno',
          [b.client_name, b.service_name, dateStr, b.time]
        ).catch(() => {});
      }
      if (b.client_email) {
        await email.sendReminder({ ...b, date_formatted: dateStr, business_name: s.business_name }).catch(() => {});
      }
      db.markReminderSent(b.id);
    }
  } catch (err) {
    console.error('Error en cron recordatorio:', err.message);
  }
});

// Resumen semanal — todos los domingos a las 9am
cron.schedule('0 9 * * 0', async () => {
  try {
    const s = db.getSettings();
    const bookings = db.getWeekBookings();
    const adminEmail = process.env.ADMIN_EMAIL || '';
    const adminPhone = s.whatsapp_phone || '';

    if (adminEmail) {
      await email.sendWeeklySummary(bookings, adminEmail, s).catch(() => {});
    }
    if (adminPhone && bookings.length > 0) {
      await wa.sendTemplate(
        adminPhone,
        process.env.WHATSAPP_SUMMARY_TEMPLATE || 'resumen_semanal',
        [String(bookings.length)]
      ).catch(() => {});
    }
  } catch (err) {
    console.error('Error en cron semanal:', err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`Mi Agenda escuchando en puerto ${PORT}`);
  console.log(`Email: ${email.getStatus().configured ? 'configurado (' + email.getStatus().user + ')' : 'no configurado'}`);
  console.log(`WhatsApp: ${wa.getStatus ? JSON.stringify(wa.getStatus()) : 'sin módulo getStatus'}`);
});
