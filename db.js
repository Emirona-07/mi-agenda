const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = process.env.DATABASE_PATH
  ? path.dirname(process.env.DATABASE_PATH)
  : process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_PATH = process.env.DATABASE_PATH || path.join(DB_DIR, 'agenda.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS professionals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#2d6a4f',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    duration INTEGER NOT NULL DEFAULT 60,
    price REAL NOT NULL DEFAULT 0,
    deposit REAL DEFAULT 0,
    description TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS service_professionals (
    service_id INTEGER NOT NULL,
    professional_id INTEGER NOT NULL,
    PRIMARY KEY (service_id, professional_id),
    FOREIGN KEY (service_id) REFERENCES services(id),
    FOREIGN KEY (professional_id) REFERENCES professionals(id)
  );

  CREATE TABLE IF NOT EXISTS business_hours (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professional_id INTEGER,
    day_of_week INTEGER NOT NULL,
    open_time TEXT DEFAULT '09:00',
    close_time TEXT DEFAULT '18:00',
    is_open INTEGER DEFAULT 1,
    FOREIGN KEY (professional_id) REFERENCES professionals(id)
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    instagram TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    service_id INTEGER NOT NULL,
    professional_id INTEGER,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    status TEXT DEFAULT 'confirmed',
    notes TEXT,
    total_price REAL DEFAULT 0,
    deposit_paid REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id),
    FOREIGN KEY (service_id) REFERENCES services(id),
    FOREIGN KEY (professional_id) REFERENCES professionals(id)
  );
`);

// Default settings
const initSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
[
  ['business_name', 'Mi Negocio'],
  ['business_description', 'Reserva tu turno online'],
  ['business_address', ''],
  ['whatsapp_phone', ''],
  ['admin_password', 'admin123'],
  ['booking_advance_days', '60'],
  ['slot_interval', '30'],
  ['currency', '$'],
].forEach(([k, v]) => initSetting.run(k, v));

// Default professional if none exist
const profCount = db.prepare('SELECT COUNT(*) as c FROM professionals').get();
if (profCount.c === 0) {
  db.prepare('INSERT INTO professionals (name, color) VALUES (?, ?)').run('Principal', '#2d6a4f');
}

// Default business hours if none exist
const hoursCount = db.prepare('SELECT COUNT(*) as c FROM business_hours').get();
if (hoursCount.c === 0) {
  const prof = db.prepare('SELECT id FROM professionals LIMIT 1').get();
  if (prof) {
    const ins = db.prepare('INSERT INTO business_hours (professional_id, day_of_week, open_time, close_time, is_open) VALUES (?, ?, ?, ?, ?)');
    ins.run(prof.id, 0, '09:00', '18:00', 0); // Sunday closed
    for (let i = 1; i <= 5; i++) ins.run(prof.id, i, '09:00', '18:00', 1); // Mon-Fri open
    ins.run(prof.id, 6, '09:00', '14:00', 1); // Saturday half day
  }
}

// Default service if none exist
const svcCount = db.prepare('SELECT COUNT(*) as c FROM services').get();
if (svcCount.c === 0) {
  const r = db.prepare('INSERT INTO services (name, duration, price, description) VALUES (?, ?, ?, ?)').run('Consulta', 60, 0, '');
  const prof = db.prepare('SELECT id FROM professionals LIMIT 1').get();
  if (prof) db.prepare('INSERT OR IGNORE INTO service_professionals VALUES (?, ?)').run(r.lastInsertRowid, prof.id);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function toTime(m) { return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; }

// ─── Settings ─────────────────────────────────────────────────────────────────

function getSettings() {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
}
function updateSettings(obj) {
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => { for (const [k,v] of Object.entries(obj)) upsert.run(k, v ?? ''); })();
}

// ─── Professionals ────────────────────────────────────────────────────────────

function getProfessionals(activeOnly = true) {
  return db.prepare(`SELECT * FROM professionals ${activeOnly ? 'WHERE active=1' : ''} ORDER BY name`).all();
}
function getProfessionalById(id) {
  return db.prepare('SELECT * FROM professionals WHERE id=?').get(id);
}
function createProfessional({ name, color }) {
  const r = db.prepare('INSERT INTO professionals (name, color) VALUES (?, ?)').run(name, color || '#2d6a4f');
  // Add default hours for this professional
  const ins = db.prepare('INSERT INTO business_hours (professional_id, day_of_week, open_time, close_time, is_open) VALUES (?, ?, ?, ?, ?)');
  ins.run(r.lastInsertRowid, 0, '09:00', '18:00', 0);
  for (let i = 1; i <= 5; i++) ins.run(r.lastInsertRowid, i, '09:00', '18:00', 1);
  ins.run(r.lastInsertRowid, 6, '09:00', '14:00', 1);
  return getProfessionalById(r.lastInsertRowid);
}
function updateProfessional(id, { name, color, active }) {
  db.prepare('UPDATE professionals SET name=?, color=?, active=? WHERE id=?').run(name, color, active ? 1 : 0, id);
}
function deleteProfessional(id) {
  db.prepare('UPDATE professionals SET active=0 WHERE id=?').run(id);
}

// ─── Services ─────────────────────────────────────────────────────────────────

function getActiveServices() {
  return db.prepare('SELECT * FROM services WHERE active=1 ORDER BY name').all().map(s => ({
    ...s,
    professionals: db.prepare('SELECT p.* FROM professionals p JOIN service_professionals sp ON p.id=sp.professional_id WHERE sp.service_id=?').all(s.id)
  }));
}
function getAllServices() {
  return db.prepare('SELECT * FROM services ORDER BY name').all().map(s => ({
    ...s,
    professionals: db.prepare('SELECT p.* FROM professionals p JOIN service_professionals sp ON p.id=sp.professional_id WHERE sp.service_id=?').all(s.id)
  }));
}
function getServiceById(id) {
  const s = db.prepare('SELECT * FROM services WHERE id=?').get(id);
  if (!s) return null;
  s.professionals = db.prepare('SELECT p.* FROM professionals p JOIN service_professionals sp ON p.id=sp.professional_id WHERE sp.service_id=?').all(id);
  return s;
}
function createService({ name, duration, price, deposit, description, professional_ids }) {
  const r = db.prepare('INSERT INTO services (name, duration, price, deposit, description) VALUES (?, ?, ?, ?, ?)').run(name, duration, price, deposit || 0, description);
  const id = r.lastInsertRowid;
  if (professional_ids && professional_ids.length) {
    const ins = db.prepare('INSERT OR IGNORE INTO service_professionals VALUES (?, ?)');
    db.transaction(() => professional_ids.forEach(pid => ins.run(id, pid)))();
  }
  return getServiceById(id);
}
function updateService(id, { name, duration, price, deposit, description, active, professional_ids }) {
  db.prepare('UPDATE services SET name=?, duration=?, price=?, deposit=?, description=?, active=? WHERE id=?')
    .run(name, duration, price, deposit || 0, description, active ? 1 : 0, id);
  if (professional_ids !== undefined) {
    db.prepare('DELETE FROM service_professionals WHERE service_id=?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO service_professionals VALUES (?, ?)');
    db.transaction(() => professional_ids.forEach(pid => ins.run(id, pid)))();
  }
}
function deleteService(id) { db.prepare('UPDATE services SET active=0 WHERE id=?').run(id); }

// ─── Business Hours ────────────────────────────────────────────────────────────

function getBusinessHours(professionalId) {
  const q = professionalId
    ? 'SELECT * FROM business_hours WHERE professional_id=? ORDER BY day_of_week'
    : 'SELECT * FROM business_hours ORDER BY professional_id, day_of_week';
  return professionalId ? db.prepare(q).all(professionalId) : db.prepare(q).all();
}
function updateBusinessHours(professionalId, hours) {
  const upd = db.prepare('UPDATE business_hours SET open_time=?, close_time=?, is_open=? WHERE professional_id=? AND day_of_week=?');
  db.transaction(() => hours.forEach(h => upd.run(h.open_time, h.close_time, h.is_open ? 1 : 0, professionalId, h.day_of_week)))();
}

// ─── Availability ─────────────────────────────────────────────────────────────

function getAvailableSlots(date, serviceId, professionalId) {
  const service = getServiceById(serviceId);
  if (!service) return [];
  const settings = getSettings();
  const interval = parseInt(settings.slot_interval) || 30;

  const [yr, mo, dy] = date.split('-').map(Number);
  const dateObj = new Date(yr, mo - 1, dy);
  const today = new Date(); today.setHours(0,0,0,0);
  if (dateObj < today) return [];

  const dayOfWeek = dateObj.getDay();

  // Get hours for this professional (or any professional who can do the service)
  let hoursRows;
  if (professionalId) {
    hoursRows = [db.prepare('SELECT * FROM business_hours WHERE professional_id=? AND day_of_week=?').get(professionalId, dayOfWeek)];
  } else {
    // Use the first available professional for the service
    const profs = service.professionals.filter(p => p.active);
    if (!profs.length) return [];
    hoursRows = db.prepare('SELECT * FROM business_hours WHERE professional_id IN (' + profs.map(() => '?').join(',') + ') AND day_of_week=?').all(...profs.map(p => p.id), dayOfWeek);
  }

  const openHours = hoursRows.filter(h => h && h.is_open);
  if (!openHours.length) return [];

  // Use the first available professional's hours (simplification)
  const hours = openHours[0];
  const open = toMin(hours.open_time);
  const close = toMin(hours.close_time);
  const all = [];
  for (let t = open; t + service.duration <= close; t += interval) all.push(toTime(t));

  const profIdForBookings = professionalId || hours.professional_id;
  const existing = db.prepare(`
    SELECT b.time, s.duration FROM bookings b JOIN services s ON b.service_id=s.id
    WHERE b.date=? AND b.professional_id=? AND b.status != 'cancelled'
  `).all(date, profIdForBookings);

  const now = new Date();
  const isToday = dateObj.getTime() === today.getTime();
  const nowMin = isToday ? now.getHours() * 60 + now.getMinutes() + 60 : -1;

  return all.filter(slot => {
    const sMin = toMin(slot);
    if (sMin < nowMin) return false;
    const sEnd = sMin + service.duration;
    return !existing.some(b => {
      const bStart = toMin(b.time);
      return sMin < bStart + b.duration && sEnd > bStart;
    });
  });
}

function getAvailableDates(serviceId, professionalId) {
  const settings = getSettings();
  const advDays = parseInt(settings.booking_advance_days) || 60;
  const today = new Date(); today.setHours(0,0,0,0);
  const result = [];
  const cur = new Date(today);
  for (let i = 0; i < advDays; i++) {
    const ds = cur.toISOString().split('T')[0];
    if (getAvailableSlots(ds, serviceId, professionalId).length > 0) result.push(ds);
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

function isSlotAvailable(date, time, serviceId, professionalId) {
  return getAvailableSlots(date, serviceId, professionalId).includes(time);
}

// ─── Clients ──────────────────────────────────────────────────────────────────

function upsertClient({ name, phone, email, instagram }) {
  const existing = db.prepare('SELECT * FROM clients WHERE phone=?').get(phone);
  if (existing) {
    db.prepare('UPDATE clients SET name=?, email=?, instagram=? WHERE id=?').run(name, email || existing.email, instagram || existing.instagram, existing.id);
    return { ...existing, name, email: email || existing.email, instagram: instagram || existing.instagram };
  }
  const r = db.prepare('INSERT INTO clients (name, phone, email, instagram) VALUES (?, ?, ?, ?)').run(name, phone, email, instagram);
  return db.prepare('SELECT * FROM clients WHERE id=?').get(r.lastInsertRowid);
}

function getClients({ search, page = 1, limit = 50 }) {
  const offset = (page - 1) * limit;
  const like = search ? `%${search}%` : null;
  const where = like ? 'WHERE (c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)' : '';
  const params = like ? [like, like, like] : [];

  const clients = db.prepare(`
    SELECT c.*,
      COUNT(b.id) as total_bookings,
      COALESCE(SUM(CASE WHEN b.status != 'cancelled' THEN b.total_price ELSE 0 END), 0) as total_spent,
      MAX(b.date) as last_booking
    FROM clients c LEFT JOIN bookings b ON c.id=b.client_id
    ${where} GROUP BY c.id ORDER BY c.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const { total } = db.prepare(`SELECT COUNT(*) as total FROM clients c ${where}`).get(...params);
  return { clients, total, page, limit };
}

function getClientById(id) {
  return db.prepare(`
    SELECT c.*,
      COUNT(b.id) as total_bookings,
      COALESCE(SUM(CASE WHEN b.status != 'cancelled' THEN b.total_price ELSE 0 END), 0) as total_spent
    FROM clients c LEFT JOIN bookings b ON c.id=b.client_id
    WHERE c.id=? GROUP BY c.id
  `).get(id);
}

function getClientBookings(clientId) {
  return db.prepare(`
    SELECT b.*, s.name as service_name, s.duration, p.name as professional_name
    FROM bookings b JOIN services s ON b.service_id=s.id
    LEFT JOIN professionals p ON b.professional_id=p.id
    WHERE b.client_id=? ORDER BY b.date DESC, b.time DESC
  `).all(clientId);
}

function updateClient(id, { name, phone, email, instagram, notes }) {
  db.prepare('UPDATE clients SET name=?, phone=?, email=?, instagram=?, notes=? WHERE id=?').run(name, phone, email, instagram, notes, id);
}

function deleteClient(id) {
  db.prepare('DELETE FROM bookings WHERE client_id=?').run(id);
  db.prepare('DELETE FROM clients WHERE id=?').run(id);
}

// ─── Bookings ─────────────────────────────────────────────────────────────────

function createBooking({ client_id, service_id, professional_id, date, time, notes, total_price, deposit_paid }) {
  const r = db.prepare(`
    INSERT INTO bookings (client_id, service_id, professional_id, date, time, notes, total_price, deposit_paid, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
  `).run(client_id, service_id, professional_id || null, date, time, notes, total_price, deposit_paid || 0);
  return db.prepare('SELECT * FROM bookings WHERE id=?').get(r.lastInsertRowid);
}

function getBookings({ date, status, client_id, from, to, professional_id, page = 1, limit = 100 }) {
  const offset = (page - 1) * limit;
  const conds = []; const params = [];
  if (date) { conds.push('b.date=?'); params.push(date); }
  if (status && status !== 'all') { conds.push('b.status=?'); params.push(status); }
  if (client_id) { conds.push('b.client_id=?'); params.push(parseInt(client_id)); }
  if (from) { conds.push('b.date>=?'); params.push(from); }
  if (to) { conds.push('b.date<=?'); params.push(to); }
  if (professional_id && professional_id !== 'all') { conds.push('b.professional_id=?'); params.push(parseInt(professional_id)); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const bookings = db.prepare(`
    SELECT b.*, c.name as client_name, c.phone as client_phone, c.email as client_email, c.instagram as client_instagram,
           s.name as service_name, s.duration as service_duration,
           p.name as professional_name, p.color as professional_color
    FROM bookings b JOIN clients c ON b.client_id=c.id JOIN services s ON b.service_id=s.id
    LEFT JOIN professionals p ON b.professional_id=p.id
    ${where} ORDER BY b.date DESC, b.time DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const { total } = db.prepare(`SELECT COUNT(*) as total FROM bookings b ${where}`).get(...params);
  return { bookings, total, page, limit };
}

function getBookingById(id) {
  return db.prepare(`
    SELECT b.*, c.name as client_name, c.phone as client_phone, c.email as client_email, c.instagram as client_instagram,
           s.name as service_name, s.duration as service_duration,
           p.name as professional_name
    FROM bookings b JOIN clients c ON b.client_id=c.id JOIN services s ON b.service_id=s.id
    LEFT JOIN professionals p ON b.professional_id=p.id
    WHERE b.id=?
  `).get(id);
}

function updateBooking(id, fields) {
  const allowed = ['status', 'notes', 'total_price', 'deposit_paid'];
  const sets = []; const params = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k) && v !== undefined) { sets.push(`${k}=?`); params.push(v); }
  }
  if (sets.length) { params.push(id); db.prepare(`UPDATE bookings SET ${sets.join(',')} WHERE id=?`).run(...params); }
}

function cancelBooking(id) { db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(id); }

// ─── Stats ────────────────────────────────────────────────────────────────────

function getDashboardStats() {
  const today = new Date().toISOString().split('T')[0];
  const monday = (() => {
    const d = new Date(); const day = d.getDay();
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    return d.toISOString().split('T')[0];
  })();
  const month1 = today.slice(0, 8) + '01';

  const stat = (from, exact) => {
    const q = exact
      ? `SELECT COUNT(*) as count, COALESCE(SUM(total_price),0) as revenue FROM bookings WHERE date=? AND status!='cancelled'`
      : `SELECT COUNT(*) as count, COALESCE(SUM(total_price),0) as revenue FROM bookings WHERE date>=? AND status!='cancelled'`;
    return db.prepare(q).get(from);
  };

  const upcoming = db.prepare(`
    SELECT b.*, c.name as client_name, c.phone as client_phone, s.name as service_name, p.name as professional_name, p.color as professional_color
    FROM bookings b JOIN clients c ON b.client_id=c.id JOIN services s ON b.service_id=s.id
    LEFT JOIN professionals p ON b.professional_id=p.id
    WHERE b.date>=? AND b.status='confirmed'
    ORDER BY b.date ASC, b.time ASC LIMIT 15
  `).all(today);

  const todaySchedule = db.prepare(`
    SELECT b.*, c.name as client_name, c.phone as client_phone, s.name as service_name, s.duration, p.name as professional_name, p.color as professional_color
    FROM bookings b JOIN clients c ON b.client_id=c.id JOIN services s ON b.service_id=s.id
    LEFT JOIN professionals p ON b.professional_id=p.id
    WHERE b.date=? ORDER BY b.time ASC
  `).all(today);

  return {
    today: stat(today, true),
    week: stat(monday, false),
    month: stat(month1, false),
    total_clients: db.prepare('SELECT COUNT(*) as c FROM clients').get().c,
    upcoming,
    today_schedule: todaySchedule,
  };
}

function getRevenue({ period, year, month }) {
  const now = new Date();
  const y = year || now.getFullYear();
  const m = month || now.getMonth() + 1;

  if (period === 'month') {
    const ym = `${y}-${String(m).padStart(2,'0')}`;
    const daily = db.prepare(`SELECT date, COUNT(*) as bookings, COALESCE(SUM(total_price),0) as revenue FROM bookings WHERE date LIKE ? AND status!='cancelled' GROUP BY date ORDER BY date`).all(`${ym}-%`);
    const byService = db.prepare(`SELECT s.name, COUNT(*) as bookings, COALESCE(SUM(b.total_price),0) as revenue FROM bookings b JOIN services s ON b.service_id=s.id WHERE b.date LIKE ? AND b.status!='cancelled' GROUP BY s.id ORDER BY revenue DESC`).all(`${ym}-%`);
    const byProfessional = db.prepare(`SELECT COALESCE(p.name,'Sin asignar') as name, COUNT(*) as bookings, COALESCE(SUM(b.total_price),0) as revenue FROM bookings b LEFT JOIN professionals p ON b.professional_id=p.id WHERE b.date LIKE ? AND b.status!='cancelled' GROUP BY b.professional_id ORDER BY revenue DESC`).all(`${ym}-%`);
    const summary = db.prepare(`SELECT COUNT(*) as total_bookings, COALESCE(SUM(total_price),0) as total_revenue FROM bookings WHERE date LIKE ? AND status!='cancelled'`).get(`${ym}-%`);
    return { period, year: y, month: m, daily, by_service: byService, by_professional: byProfessional, summary };
  }

  if (period === 'year') {
    const monthly = db.prepare(`SELECT strftime('%m',date) as month, COUNT(*) as bookings, COALESCE(SUM(total_price),0) as revenue FROM bookings WHERE strftime('%Y',date)=? AND status!='cancelled' GROUP BY month ORDER BY month`).all(String(y));
    const summary = db.prepare(`SELECT COUNT(*) as total_bookings, COALESCE(SUM(total_price),0) as total_revenue FROM bookings WHERE strftime('%Y',date)=? AND status!='cancelled'`).get(String(y));
    return { period, year: y, monthly, summary };
  }
  return {};
}

module.exports = {
  getSettings, updateSettings,
  getProfessionals, getProfessionalById, createProfessional, updateProfessional, deleteProfessional,
  getActiveServices, getAllServices, getServiceById, createService, updateService, deleteService,
  getBusinessHours, updateBusinessHours,
  getAvailableSlots, getAvailableDates, isSlotAvailable,
  upsertClient, getClients, getClientById, getClientBookings, updateClient, deleteClient,
  createBooking, getBookings, getBookingById, updateBooking, cancelBooking,
  getDashboardStats, getRevenue,
};
