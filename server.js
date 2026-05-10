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

// One-time koob import (protected, self-removes after first use)
app.post('/api/admin/import-koob', requireAuth, (req, res) => {
  const koobClients = [
    { name: 'Nedda Ache', phone: '59898061786' },
    { name: 'Catalina Motta', phone: '59891029789' },
    { name: 'Yamel Ache', phone: '59899629471' },
    { name: 'Maru', phone: '59899625832' },
    { name: 'Cami Santos', phone: '59898539669' },
    { name: 'Jhoselein Alvez', phone: '59898863582' },
    { name: 'Brisa Aguiar', phone: '59899417030' },
    { name: 'Sofia Duran', phone: '59895236129' },
    { name: 'Agostina Bazzano', phone: '59898994674' },
    { name: 'Margarita Baldizan', phone: '59899205285' },
    { name: 'Victoria Soto', phone: '59894560088' },
    { name: 'Sabina Da Costa', phone: '59891352546' },
    { name: 'Flor Rodríguez', phone: '59898570269' },
    { name: 'Valeria Kennedy', phone: '59899814117' },
    { name: 'Pati Holtz', phone: '59899689090' },
    { name: 'Micaela Perez', phone: '59893518490' },
    { name: 'Evelin Piñeyro', phone: '59891671768' },
    { name: 'Lorena Miglino', phone: '59899124013' },
    { name: 'Valentina Martinez', phone: '59895718847' },
    { name: 'Karina Cardozo', phone: '59893384839' },
    { name: 'Malvina Oyenard', phone: '59894902875' },
    { name: 'Anaclara Novo', phone: '59898561031' },
    { name: 'Eliana Quesada', phone: '59891713057' },
    { name: 'Sofía Ache', phone: '59899877591' },
    { name: 'Camila Ballestero', phone: '59891821592' },
    { name: 'Stephany Beveder', phone: '59895374365' },
    { name: 'Sofía Baldassari', phone: '59898866554' },
    { name: 'Renata Motta', phone: '59892023167' },
    { name: 'María Luisa Risso', phone: '59898128065' },
    { name: 'Agustina Roberts', phone: '59898736652' },
    { name: 'Emanuel Pereyra', phone: '59899086924' },
    { name: 'Viviana Dollanart', phone: '59899291273' },
    { name: 'Ivana Stankervicaite', phone: '59897387459' },
    { name: 'Rebeca Panzl', phone: '59895267784' },
    { name: 'Cristina Pandikian', phone: '59899784414' },
    { name: 'Andrea Fernandez', phone: '59892894930' },
    { name: 'Rocío Sorondo', phone: '59898272114' },
    { name: 'Claudio Lores', phone: '59899309693' },
    { name: 'Sebastian Daveri', phone: '59898549980' },
    { name: 'Vale K', phone: '61491717428' },
    { name: 'Florencia Jauregui', phone: '59895904427' },
    { name: 'Paula Redondo', phone: '59896450059' },
    { name: 'Valeria Koser', phone: '59894313047' },
    { name: 'Tania Villaverde', phone: '59898694558' },
    { name: 'Anita Ciarlo', phone: '59891456444' },
    { name: 'Hermanita Linda', phone: '59891219925' },
    { name: 'Fabiane Pereira', phone: '59892252276' },
    { name: 'Mariana Rodríguez', phone: '59898657708' },
    { name: 'Pauli', phone: '59892852885' },
    { name: 'Adri', phone: '59899282978' },
    { name: 'Ernesto Etchepare', phone: '59895620993' },
    { name: 'Romina Mariño', phone: '59898464160' },
    { name: 'Andrea Juani', phone: '59899191825' },
    { name: 'Érika Camargo', phone: '59899652864' },
    { name: 'Lucia Rodríguez', phone: '59898570267' },
    { name: 'Valentina Airaldi', phone: '59891880773' },
    { name: 'Nedda', phone: '59898061789' },
    { name: 'Romina Posse', phone: '59894928570' },
    { name: 'Lucia Carrizo', phone: '59899912976' },
    { name: 'Laura De Castellet', phone: '59899615396' },
    { name: 'Victoria Fernández', phone: '59898483769' },
    { name: 'Belen Pirotto Villamor', phone: '59899865585' },
    { name: 'Jhose Alves', phone: '59892538632' },
    { name: 'Paulina González', phone: '59895244233' },
  ];
  for (const c of koobClients) {
    db.upsertClient({ name: c.name, phone: c.phone, email: null, instagram: null });
  }
  res.json({ success: true, total: koobClients.length, message: `${koobClients.length} clientes importados de koob.uy` });
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
