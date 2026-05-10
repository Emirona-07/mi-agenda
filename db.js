'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = process.env.DATABASE_PATH || process.env.DB_PATH || path.join(dataDir, 'agenda.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema inicial ────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    business_name TEXT DEFAULT 'Mi Agenda',
    phone TEXT DEFAULT '',
    whatsapp_phone TEXT DEFAULT '',
    address TEXT DEFAULT '',
    logo_url TEXT DEFAULT '',
    primary_color TEXT DEFAULT '#c85fa0',
    slot_duration INTEGER DEFAULT 30,
    advance_days INTEGER DEFAULT 30,
    cancellation_hours INTEGER DEFAULT 24,
    CHECK (id = 1)
  );

  INSERT OR IGNORE INTO settings (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS professionals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    duration INTEGER DEFAULT 60,
    price REAL DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS service_professionals (
    service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
    professional_id INTEGER REFERENCES professionals(id) ON DELETE CASCADE,
    PRIMARY KEY (service_id, professional_id)
  );

  CREATE TABLE IF NOT EXISTS business_hours (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day_of_week INTEGER NOT NULL,
    open_time TEXT NOT NULL,
    close_time TEXT NOT NULL,
    is_open INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES clients(id),
    service_id INTEGER NOT NULL REFERENCES services(id),
    professional_id INTEGER REFERENCES professionals(id),
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    status TEXT DEFAULT 'confirmed',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS booking_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired DATETIME NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
  CREATE INDEX IF NOT EXISTS idx_bookings_client ON bookings(client_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
`);

// ─── Migraciones seguras ────────────────────────────────────────────────────────
const migrations = [
  "ALTER TABLE bookings ADD COLUMN utm_source TEXT",
  "ALTER TABLE bookings ADD COLUMN payment_status TEXT DEFAULT 'none'",
  "ALTER TABLE bookings ADD COLUMN notes_admin TEXT",
  "ALTER TABLE bookings ADD COLUMN reminder_sent INTEGER DEFAULT 0",
  "ALTER TABLE clients ADD COLUMN google_id TEXT",
];
for (const m of migrations) {
  try { db.exec(m); } catch (e) { /* columna ya existe */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

function getSettings() {
  return db.prepare('SELECT * FROM settings WHERE id = 1').get();
}

function updateSettings(data) {
  const allowed = [
    'business_name', 'phone', 'whatsapp_phone', 'address', 'logo_url',
    'primary_color', 'slot_duration', 'advance_days', 'cancellation_hours',
  ];
  const fields = Object.keys(data).filter((k) => allowed.includes(k));
  if (!fields.length) return getSettings();
  const sets = fields.map((f) => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE settings SET ${sets} WHERE id = 1`).run(data);
  return getSettings();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROFESSIONALS
// ═══════════════════════════════════════════════════════════════════════════════

function getProfessionals() {
  return db.prepare('SELECT * FROM professionals ORDER BY name ASC').all();
}

function getProfessionalById(id) {
  return db.prepare('SELECT * FROM professionals WHERE id = ?').get(id) || null;
}

function createProfessional({ name, email, phone }) {
  const r = db.prepare(
    'INSERT INTO professionals (name, email, phone) VALUES (?, ?, ?)'
  ).run(name, email || '', phone || '');
  return db.prepare('SELECT * FROM professionals WHERE id = ?').get(r.lastInsertRowid);
}

function updateProfessional(id, { name, email, phone, active }) {
  const fields = [];
  const params = {};
  if (name !== undefined) { fields.push('name = @name'); params.name = name; }
  if (email !== undefined) { fields.push('email = @email'); params.email = email; }
  if (phone !== undefined) { fields.push('phone = @phone'); params.phone = phone; }
  if (active !== undefined) { fields.push('active = @active'); params.active = active ? 1 : 0; }
  if (!fields.length) return getProfessionalById(id);
  params.id = id;
  db.prepare(`UPDATE professionals SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getProfessionalById(id);
}

function deleteProfessional(id) {
  db.prepare('DELETE FROM professionals WHERE id = ?').run(id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICES
// ═══════════════════════════════════════════════════════════════════════════════

function getActiveServices() {
  return db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY name ASC').all();
}

function getAllServices() {
  return db.prepare('SELECT * FROM services ORDER BY name ASC').all();
}

function getServiceById(id) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(id) || null;
}

function createService({ name, description, duration, price }) {
  const r = db.prepare(
    'INSERT INTO services (name, description, duration, price) VALUES (?, ?, ?, ?)'
  ).run(name, description || '', duration || 60, price || 0);
  return db.prepare('SELECT * FROM services WHERE id = ?').get(r.lastInsertRowid);
}

function updateService(id, { name, description, duration, price, active }) {
  const fields = [];
  const params = {};
  if (name !== undefined) { fields.push('name = @name'); params.name = name; }
  if (description !== undefined) { fields.push('description = @description'); params.description = description; }
  if (duration !== undefined) { fields.push('duration = @duration'); params.duration = duration; }
  if (price !== undefined) { fields.push('price = @price'); params.price = price; }
  if (active !== undefined) { fields.push('active = @active'); params.active = active ? 1 : 0; }
  if (!fields.length) return getServiceById(id);
  params.id = id;
  db.prepare(`UPDATE services SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getServiceById(id);
}

function deleteService(id) {
  db.prepare('DELETE FROM services WHERE id = ?').run(id);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUSINESS HOURS
// ═══════════════════════════════════════════════════════════════════════════════

function getBusinessHours() {
  return db.prepare('SELECT * FROM business_hours ORDER BY day_of_week ASC').all();
}

function updateBusinessHours(hours) {
  // hours: array de { day_of_week, open_time, close_time, is_open }
  const upsert = db.prepare(`
    INSERT INTO business_hours (day_of_week, open_time, close_time, is_open)
    VALUES (@day_of_week, @open_time, @close_time, @is_open)
    ON CONFLICT(day_of_week) DO UPDATE SET
      open_time = excluded.open_time,
      close_time = excluded.close_time,
      is_open = excluded.is_open
  `);
  // Asegurar índice único si no existe
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_business_hours_dow ON business_hours(day_of_week)');
  } catch (e) { /* ya existe */ }

  const runAll = db.transaction((rows) => {
    for (const row of rows) upsert.run(row);
  });
  runAll(hours);
  return getBusinessHours();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLOTS / DISPONIBILIDAD
// ═══════════════════════════════════════════════════════════════════════════════

function getAvailableSlots(date, serviceId, professionalId) {
  const settings = getSettings();
  const slotDuration = settings.slot_duration || 30;

  const dayOfWeek = new Date(date + 'T12:00:00').getDay(); // 0=Dom … 6=Sab
  const bh = db.prepare(
    'SELECT * FROM business_hours WHERE day_of_week = ? AND is_open = 1'
  ).get(dayOfWeek);
  if (!bh) return [];

  const service = serviceId ? getServiceById(serviceId) : null;
  const duration = service ? service.duration : slotDuration;

  // Turnos ya reservados ese día
  let query = "SELECT time FROM bookings WHERE date = ? AND status != 'cancelled'";
  const params = [date];
  if (professionalId) { query += ' AND professional_id = ?'; params.push(professionalId); }
  const taken = new Set(db.prepare(query).all(...params).map((r) => r.time));

  // Generar slots
  const slots = [];
  const [openH, openM] = bh.open_time.split(':').map(Number);
  const [closeH, closeM] = bh.close_time.split(':').map(Number);
  let cur = openH * 60 + openM;
  const end = closeH * 60 + closeM - duration;

  while (cur <= end) {
    const h = String(Math.floor(cur / 60)).padStart(2, '0');
    const m = String(cur % 60).padStart(2, '0');
    const slot = `${h}:${m}`;
    if (!taken.has(slot)) slots.push(slot);
    cur += slotDuration;
  }
  return slots;
}

function getAvailableDates(serviceId, professionalId) {
  const settings = getSettings();
  const advanceDays = settings.advance_days || 30;
  const openDays = new Set(
    db.prepare('SELECT day_of_week FROM business_hours WHERE is_open = 1').all().map((r) => r.day_of_week)
  );

  const dates = [];
  const today = new Date();
  for (let i = 1; i <= advanceDays; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    if (openDays.has(d.getDay())) {
      const dateStr = d.toISOString().split('T')[0];
      const slots = getAvailableSlots(dateStr, serviceId, professionalId);
      if (slots.length > 0) dates.push(dateStr);
    }
  }
  return dates;
}

function isSlotAvailable(date, time, serviceId, professionalId) {
  const slots = getAvailableSlots(date, serviceId, professionalId);
  return slots.includes(time);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════════════════════════════════════════════

function upsertClient({ name, phone, email }) {
  if (email) {
    const existing = db.prepare('SELECT * FROM clients WHERE email = ?').get(email);
    if (existing) {
      db.prepare('UPDATE clients SET name = ?, phone = ? WHERE id = ?').run(name || existing.name, phone || existing.phone, existing.id);
      return db.prepare('SELECT * FROM clients WHERE id = ?').get(existing.id);
    }
  }
  const r = db.prepare('INSERT INTO clients (name, phone, email) VALUES (?, ?, ?)').run(
    name || '', phone || '', email || ''
  );
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(r.lastInsertRowid);
}

function getClients() {
  return db.prepare('SELECT * FROM clients ORDER BY name ASC').all();
}

function getClientById(id) {
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(id) || null;
}

function getClientBookings(clientId) {
  return db.prepare(`
    SELECT b.*, s.name as service_name, s.price, p.name as professional_name
    FROM bookings b
    JOIN services s ON b.service_id = s.id
    LEFT JOIN professionals p ON b.professional_id = p.id
    WHERE b.client_id = ?
    ORDER BY b.date DESC, b.time DESC
  `).all(clientId);
}

function updateClient(id, { name, phone, email, notes }) {
  const fields = [];
  const params = {};
  if (name !== undefined) { fields.push('name = @name'); params.name = name; }
  if (phone !== undefined) { fields.push('phone = @phone'); params.phone = phone; }
  if (email !== undefined) { fields.push('email = @email'); params.email = email; }
  if (notes !== undefined) { fields.push('notes = @notes'); params.notes = notes; }
  if (!fields.length) return getClientById(id);
  params.id = id;
  db.prepare(`UPDATE clients SET ${fields.join(', ')} WHERE id = @id`).run(params);
  return getClientById(id);
}

function deleteClient(id) {
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
}

function findOrCreateClientByGoogle({ google_id, email, name, picture }) {
  // 1. buscar por google_id
  let client = google_id ? db.prepare('SELECT * FROM clients WHERE google_id = ?').get(google_id) : null;
  if (client) {
    if (name && name !== client.name) {
      db.prepare('UPDATE clients SET name = ?, google_id = ? WHERE id = ?').run(name, google_id, client.id);
    }
    return db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id);
  }
  // 2. buscar por email
  if (email) client = db.prepare('SELECT * FROM clients WHERE email = ?').get(email);
  if (client) {
    db.prepare('UPDATE clients SET google_id = ? WHERE id = ?').run(google_id, client.id);
    return db.prepare('SELECT * FROM clients WHERE id = ?').get(client.id);
  }
  // 3. crear nuevo (sin teléfono — lo completará cuando reserve)
  const r = db.prepare(
    'INSERT INTO clients (name, phone, email, google_id) VALUES (?, ?, ?, ?)'
  ).run(name || email || 'Sin nombre', '', email || '', google_id || '');
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(r.lastInsertRowid);
}

function cancelClientBooking(bookingId, clientId) {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return { error: 'not_found' };
  if (booking.client_id !== clientId) return { error: 'not_authorized' };
  const today = new Date().toISOString().split('T')[0];
  if (booking.date < today) return { error: 'turno_pasado' };
  if (booking.status === 'cancelled') return { error: 'ya_cancelado' };
  db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(bookingId);
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOKINGS
// ═══════════════════════════════════════════════════════════════════════════════

function createBooking({ client_id, service_id, professional_id, date, time, notes, utm_source }) {
  const r = db.prepare(`
    INSERT INTO bookings (client_id, service_id, professional_id, date, time, notes, utm_source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(client_id, service_id, professional_id || null, date, time, notes || '', utm_source || null);
  return getBookingById(r.lastInsertRowid);
}

function getBookings({ date, status, from, to } = {}) {
  let query = `
    SELECT b.*, c.name as client_name, c.phone as client_phone, c.email as client_email,
           s.name as service_name, s.price, p.name as professional_name
    FROM bookings b
    JOIN clients c ON b.client_id = c.id
    JOIN services s ON b.service_id = s.id
    LEFT JOIN professionals p ON b.professional_id = p.id
    WHERE 1=1
  `;
  const params = [];
  if (date) { query += ' AND b.date = ?'; params.push(date); }
  if (status) { query += ' AND b.status = ?'; params.push(status); }
  if (from) { query += ' AND b.date >= ?'; params.push(from); }
  if (to) { query += ' AND b.date <= ?'; params.push(to); }
  query += ' ORDER BY b.date ASC, b.time ASC';
  return db.prepare(query).all(...params);
}

function getBookingById(id) {
  return db.prepare(`
    SELECT b.*, c.name as client_name, c.phone as client_phone, c.email as client_email,
           s.name as service_name, s.price, p.name as professional_name
    FROM bookings b
    JOIN clients c ON b.client_id = c.id
    JOIN services s ON b.service_id = s.id
    LEFT JOIN professionals p ON b.professional_id = p.id
    WHERE b.id = ?
  `).get(id) || null;
}

function updateBooking(id, data) {
  const allowed = [
    'service_id', 'professional_id', 'date', 'time', 'status',
    'notes', 'payment_status', 'notes_admin',
  ];
  const fields = Object.keys(data).filter((k) => allowed.includes(k));
  if (!fields.length) return getBookingById(id);
  const sets = fields.map((f) => `${f} = @${f}`).join(', ');
  const params = { ...Object.fromEntries(fields.map((f) => [f, data[f]])), id };
  db.prepare(`UPDATE bookings SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = @id`).run(params);
  return getBookingById(id);
}

function cancelBooking(id) {
  db.prepare("UPDATE bookings SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  return getBookingById(id);
}

function updateBookingAdmin(id, { notes_admin, payment_status }) {
  if (notes_admin !== undefined) {
    db.prepare('UPDATE bookings SET notes_admin = ? WHERE id = ?').run(notes_admin, id);
  }
  if (payment_status !== undefined) {
    db.prepare('UPDATE bookings SET payment_status = ? WHERE id = ?').run(payment_status, id);
  }
}

function getBookingsNeedingReminder() {
  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const dateStr = in48h.toISOString().split('T')[0];
  return db.prepare(`
    SELECT b.*, c.name as client_name, c.phone as client_phone, c.email as client_email,
           s.name as service_name, p.name as professional_name
    FROM bookings b
    JOIN clients c ON b.client_id = c.id
    JOIN services s ON b.service_id = s.id
    LEFT JOIN professionals p ON b.professional_id = p.id
    WHERE b.date = ? AND b.reminder_sent = 0 AND b.status != 'cancelled'
  `).all(dateStr);
}

function markReminderSent(id) {
  db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ?').run(id);
}

function getWeekBookings() {
  const today = new Date();
  const from = today.toISOString().split('T')[0];
  const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const to = nextWeek.toISOString().split('T')[0];
  return db.prepare(`
    SELECT b.*, c.name as client_name, c.phone as client_phone, c.email as client_email,
           s.name as service_name, s.price, p.name as professional_name
    FROM bookings b
    JOIN clients c ON b.client_id = c.id
    JOIN services s ON b.service_id = s.id
    LEFT JOIN professionals p ON b.professional_id = p.id
    WHERE b.date >= ? AND b.date < ? AND b.status != 'cancelled'
    ORDER BY b.date ASC, b.time ASC
  `).all(from, to);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOKING PHOTOS
// ═══════════════════════════════════════════════════════════════════════════════

function addBookingPhoto(bookingId, filePath, comment) {
  const r = db.prepare(
    'INSERT INTO booking_photos (booking_id, file_path, comment) VALUES (?, ?, ?)'
  ).run(bookingId, filePath, comment || '');
  return db.prepare('SELECT * FROM booking_photos WHERE id = ?').get(r.lastInsertRowid);
}

function getBookingPhotos(bookingId) {
  return db.prepare(
    'SELECT * FROM booking_photos WHERE booking_id = ? ORDER BY created_at ASC'
  ).all(bookingId);
}

function deleteBookingPhoto(photoId) {
  const photo = db.prepare('SELECT * FROM booking_photos WHERE id = ?').get(photoId);
  db.prepare('DELETE FROM booking_photos WHERE id = ?').run(photoId);
  return photo;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS / REVENUE
// ═══════════════════════════════════════════════════════════════════════════════

function getDashboardStats() {
  const today = new Date().toISOString().split('T')[0];
  return {
    todayBookings: db.prepare(
      "SELECT COUNT(*) as c FROM bookings WHERE date = ? AND status != 'cancelled'"
    ).get(today).c,
    pendingBookings: db.prepare(
      "SELECT COUNT(*) as c FROM bookings WHERE status = 'confirmed'"
    ).get().c,
    totalClients: db.prepare('SELECT COUNT(*) as c FROM clients').get().c,
    totalBookings: db.prepare("SELECT COUNT(*) as c FROM bookings WHERE status != 'cancelled'").get().c,
  };
}

function getRevenue({ from, to } = {}) {
  let query = `
    SELECT SUM(s.price) as total, COUNT(b.id) as count
    FROM bookings b
    JOIN services s ON b.service_id = s.id
    WHERE b.status = 'completed'
  `;
  const params = [];
  if (from) { query += ' AND b.date >= ?'; params.push(from); }
  if (to) { query += ' AND b.date <= ?'; params.push(to); }
  return db.prepare(query).get(...params);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION STORE (express-session + better-sqlite3)
// ═══════════════════════════════════════════════════════════════════════════════

function createSessionStore(session) {
  const Store = session.Store;

  class SQLiteStore extends Store {
    constructor(options = {}) {
      super(options);
      this.ttl = options.ttl || 86400;
      // Limpiar sesiones expiradas cada hora
      setInterval(() => {
        db.prepare("DELETE FROM sessions WHERE expired < datetime('now')").run();
      }, 60 * 60 * 1000).unref();
    }

    get(sid, cb) {
      try {
        const row = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > datetime(\'now\')').get(sid);
        cb(null, row ? JSON.parse(row.sess) : null);
      } catch (e) { cb(e); }
    }

    set(sid, sess, cb) {
      try {
        const maxAge = (sess.cookie && sess.cookie.maxAge) ? sess.cookie.maxAge / 1000 : this.ttl;
        const expired = new Date(Date.now() + maxAge * 1000).toISOString().replace('T', ' ').slice(0, 19);
        db.prepare(`
          INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)
          ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired
        `).run(sid, JSON.stringify(sess), expired);
        cb(null);
      } catch (e) { cb(e); }
    }

    destroy(sid, cb) {
      try {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        cb(null);
      } catch (e) { cb(e); }
    }

    touch(sid, sess, cb) {
      this.set(sid, sess, cb);
    }
  }

  return new SQLiteStore();
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Settings
  getSettings,
  updateSettings,
  // Professionals
  getProfessionals,
  getProfessionalById,
  createProfessional,
  updateProfessional,
  deleteProfessional,
  // Services
  getActiveServices,
  getAllServices,
  getServiceById,
  createService,
  updateService,
  deleteService,
  // Business hours
  getBusinessHours,
  updateBusinessHours,
  // Slots
  getAvailableSlots,
  getAvailableDates,
  isSlotAvailable,
  // Clients
  upsertClient,
  getClients,
  getClientById,
  getClientBookings,
  updateClient,
  deleteClient,
  findOrCreateClientByGoogle,
  cancelClientBooking,
  // Bookings
  createBooking,
  getBookings,
  getBookingById,
  updateBooking,
  cancelBooking,
  updateBookingAdmin,
  getBookingsNeedingReminder,
  markReminderSent,
  getWeekBookings,
  // Booking photos
  addBookingPhoto,
  getBookingPhotos,
  deleteBookingPhoto,
  // Stats
  getDashboardStats,
  getRevenue,
  // Session store
  createSessionStore,
};
