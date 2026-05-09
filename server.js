require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');
const wa = require('./whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
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

// ═══════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════

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

app.post('/api/bookings', (req, res) => {
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

  res.json({ success: true, booking_id: booking.id, message: 'Reserva creada exitosamente' });
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

// ═══════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n✅ Agenda corriendo en http://localhost:${PORT}`);
  console.log(`📅 Página de reservas: http://localhost:${PORT}`);
  console.log(`🔐 Panel admin:        http://localhost:${PORT}/admin`);
  console.log(`   Contraseña admin:   admin123 (cambiala en Configuración)\n`);
});
