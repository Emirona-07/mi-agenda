const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { hashPassword } = require('./auth');

const DB_DIR = process.env.DATABASE_PATH
  ? path.dirname(process.env.DATABASE_PATH)
  : process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_PATH = process.env.DATABASE_PATH || path.join(DB_DIR, 'agenda.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
console.log(`SQLite database: ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired_at INTEGER NOT NULL
  );
`);

// Migrate clients table for Google auth
const _clientCols = db.prepare("PRAGMA table_info(clients)").all().map(c => c.name);
if (!_clientCols.includes('google_id')) db.exec("ALTER TABLE clients ADD COLUMN google_id TEXT");
if (!_clientCols.includes('google_picture')) db.exec("ALTER TABLE clients ADD COLUMN google_picture TEXT");
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_google_id ON clients(google_id) WHERE google_id IS NOT NULL"); } catch {}

// Default settings
const initSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
[
  ['business_name', 'Mi Negocio'],
  ['business_description', 'Reserva tu turno online'],
  ['business_address', ''],
  ['whatsapp_phone', ''],
  ['admin_password', process.env.ADMIN_PASSWORD ? hashPassword(process.env.ADMIN_PASSWORD) : ''],
  ['booking_advance_days', '60'],
  ['slot_interval', '30'],
  ['currency', '$'],
  ['notification_channel', 'email'],
  ['mp_surcharge', '5'],
  ['owner_email', ''],
  ['email_host', ''],
  ['email_port', '587'],
  ['email_user', ''],
  ['email_pass', ''],
  ['email_from', ''],
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

function purgeProfessional(id) {
  db.prepare('UPDATE bookings SET professional_id=NULL WHERE professional_id=?').run(id);
  db.prepare('DELETE FROM service_professionals WHERE professional_id=?').run(id);
  db.prepare('DELETE FROM business_hours WHERE professional_id=?').run(id);
  db.prepare('DELETE FROM professionals WHERE id=?').run(id);
}

function purgeCancelledBookings() {
  const ids = db.prepare("SELECT id FROM bookings WHERE status='cancelled'").all().map(r => r.id);
  if (!ids.length) return 0;
  ids.forEach(id => {
    db.prepare('DELETE FROM booking_photos WHERE booking_id=?').run(id);
    db.prepare('DELETE FROM bookings WHERE id=?').run(id);
  });
  return ids.length;
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
function updateServicePhoto(id, photo) { db.prepare('UPDATE services SET photo=? WHERE id=?').run(photo || null, id); }

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
    const ds = localDateString(cur);
    if (getAvailableSlots(ds, serviceId, professionalId).length > 0) result.push(ds);
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

function isSlotAvailable(date, time, serviceId, professionalId) {
  return getAvailableSlots(date, serviceId, professionalId).includes(time);
}

// ─── Clients ──────────────────────────────────────────────────────────────────

function findClientByPhone(phone) {
  return db.prepare('SELECT * FROM clients WHERE phone=?').get(phone) || null;
}

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

function createBooking({ client_id, service_id, professional_id, date, time, notes, total_price, deposit_paid, status }) {
  const r = db.prepare(`
    INSERT INTO bookings (client_id, service_id, professional_id, date, time, notes, total_price, deposit_paid, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(client_id, service_id, professional_id || null, date, time, notes, total_price, deposit_paid || 0, status || 'confirmed');
  return db.prepare('SELECT * FROM bookings WHERE id=?').get(r.lastInsertRowid);
}

const createBookingAtomic = db.transaction(({ booking, gift_card_code, effective_price }) => {
  if (!isSlotAvailable(booking.date, booking.time, booking.service_id, booking.professional_id)) {
    return { error: 'slot_unavailable' };
  }

  let gcDiscount = 0;
  let validGcCode = null;
  if (gift_card_code) {
    const gc = getGiftCardByCode(gift_card_code);
    if (gc && gc.status === 'active' && gc.balance > 0) {
      gcDiscount = Math.min(gc.balance, effective_price);
      validGcCode = gc.code;
    }
  }

  const finalPrice = Math.max(0, effective_price - gcDiscount);
  const created = createBooking({ ...booking, total_price: finalPrice });

  if (validGcCode && gcDiscount > 0) {
    const used = useGiftCard(validGcCode, created.id, gcDiscount);
    if (!used) throw new Error('gift_card_unavailable');
    db.prepare('UPDATE bookings SET gift_card_code=?, gift_card_discount=? WHERE id=?')
      .run(validGcCode, used, created.id);
  }

  return {
    booking: created,
    final_price: finalPrice,
    gift_card_discount: gcDiscount,
    original_price: effective_price,
  };
});

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
  const today = localDateString();
  const monday = (() => {
    const d = new Date(); const day = d.getDay();
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    return localDateString(d);
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

function findOrCreateClientByGoogle({ google_id, email, name, picture }) {
  // 1. Match exacto por google_id
  let client = db.prepare('SELECT * FROM clients WHERE google_id=?').get(google_id);
  if (client) {
    if (picture) db.prepare('UPDATE clients SET google_picture=? WHERE id=?').run(picture, client.id);
    return db.prepare('SELECT * FROM clients WHERE id=?').get(client.id);
  }

  // 2. Match por email (cliente existente sin google_id)
  if (email) {
    client = db.prepare("SELECT * FROM clients WHERE email=? AND (google_id IS NULL OR google_id='')").get(email);
    if (client) {
      db.prepare('UPDATE clients SET google_id=?, google_picture=? WHERE id=?').run(google_id, picture || null, client.id);
      return db.prepare('SELECT * FROM clients WHERE id=?').get(client.id);
    }
  }

  // 3. Crear nuevo cliente Google
  const r = db.prepare('INSERT INTO clients (name, phone, email, google_id, google_picture) VALUES (?, ?, ?, ?, ?)').run(
    name || 'Usuario', `g_${google_id.slice(-8)}`, email || null, google_id, picture || null
  );
  const newClient = db.prepare('SELECT * FROM clients WHERE id=?').get(r.lastInsertRowid);

  // 4. Auto-merge: si existe exactamente 1 cliente con el mismo nombre completo,
  //    sin google_id ni email, con reservas → absorbemos sus reservas (evita duplicados
  //    cuando el admin crea la cita sin email y el cliente luego entra con Google)
  if (name) {
    const nameLower = name.trim().toLowerCase();
    const orphans = db.prepare(`
      SELECT c.* FROM clients c
      WHERE LOWER(TRIM(c.name)) = ?
        AND (c.google_id IS NULL OR c.google_id = '')
        AND (c.email IS NULL OR c.email = '')
        AND c.id != ?
        AND EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.id)
    `).all(nameLower, newClient.id);

    if (orphans.length === 1) {
      // Mover reservas y copiar teléfono real si el nuevo tiene uno falso
      const orphan = orphans[0];
      db.prepare('UPDATE bookings SET client_id=? WHERE client_id=?').run(newClient.id, orphan.id);
      if (newClient.phone.startsWith('g_') && orphan.phone && !orphan.phone.startsWith('g_')) {
        db.prepare('UPDATE clients SET phone=? WHERE id=?').run(orphan.phone, newClient.id);
      }
      db.prepare('DELETE FROM clients WHERE id=?').run(orphan.id);
    }
  }

  return db.prepare('SELECT * FROM clients WHERE id=?').get(newClient.id);
}

function mergeClients(targetId, sourceId) {
  const target = db.prepare('SELECT * FROM clients WHERE id=?').get(targetId);
  const source = db.prepare('SELECT * FROM clients WHERE id=?').get(sourceId);
  if (!target || !source) return;

  // Reasigna todas las reservas del cliente origen al destino
  db.prepare('UPDATE bookings SET client_id=? WHERE client_id=?').run(targetId, sourceId);

  // Completa datos faltantes en el destino con los del origen
  const updates = {};
  if (!target.google_id    && source.google_id)    updates.google_id = source.google_id;
  if (!target.google_picture && source.google_picture) updates.google_picture = source.google_picture;
  if (!target.email        && source.email)        updates.email = source.email;
  if (!target.phone || target.phone.startsWith('g_'))
    if (source.phone && !source.phone.startsWith('g_')) updates.phone = source.phone;
  if (!target.instagram    && source.instagram)    updates.instagram = source.instagram;

  if (Object.keys(updates).length) {
    const sets = Object.keys(updates).map(k => `${k}=?`).join(', ');
    db.prepare(`UPDATE clients SET ${sets} WHERE id=?`).run(...Object.values(updates), targetId);
  }

  // Elimina el origen
  db.prepare('DELETE FROM clients WHERE id=?').run(sourceId);
}

function cancelClientBooking(bookingId, clientId) {
  const b = db.prepare('SELECT * FROM bookings WHERE id=? AND client_id=?').get(bookingId, clientId);
  if (!b) return { error: 'no_encontrado' };
  if (b.status === 'cancelled') return { error: 'ya_cancelado' };
  const appointmentDt = new Date(`${b.date}T${b.time}:00`);
  const hoursUntil = (appointmentDt - new Date()) / (1000 * 60 * 60);
  if (hoursUntil < 0)  return { error: 'turno_pasado' };
  if (hoursUntil < 24) return { error: 'muy_pronto' };
  db.prepare("UPDATE bookings SET status='cancelled' WHERE id=?").run(bookingId);
  return { success: true };
}

function createSessionStore(session) {
  const Store = session.Store;
  const getStmt = db.prepare('SELECT sess FROM sessions WHERE sid=? AND expired_at > ?');
  const setStmt = db.prepare(`
    INSERT INTO sessions (sid, sess, expired_at) VALUES (?, ?, ?)
    ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expired_at=excluded.expired_at
  `);
  const destroyStmt = db.prepare('DELETE FROM sessions WHERE sid=?');
  const cleanupStmt = db.prepare('DELETE FROM sessions WHERE expired_at <= ?');

  const expiryFromSession = (sess) => {
    const expires = sess.cookie && sess.cookie.expires;
    return expires ? new Date(expires).getTime() : Date.now() + 24 * 60 * 60 * 1000;
  };

  class SQLiteSessionStore extends Store {
    get(sid, callback) {
      try {
        const row = getStmt.get(sid, Date.now());
        callback(null, row ? JSON.parse(row.sess) : null);
      } catch (err) {
        callback(err);
      }
    }

    set(sid, sess, callback = () => {}) {
      try {
        setStmt.run(sid, JSON.stringify(sess), expiryFromSession(sess));
        cleanupStmt.run(Date.now());
        callback(null);
      } catch (err) {
        callback(err);
      }
    }

    destroy(sid, callback = () => {}) {
      try {
        destroyStmt.run(sid);
        callback(null);
      } catch (err) {
        callback(err);
      }
    }

    touch(sid, sess, callback = () => {}) {
      this.set(sid, sess, callback);
    }
  }

  return new SQLiteSessionStore();
}


// ─── Migraciones seguras (columnas nuevas) ────────────────────────────────────
const _migrations = [
  "ALTER TABLE bookings ADD COLUMN utm_source TEXT",
  "ALTER TABLE bookings ADD COLUMN payment_status TEXT DEFAULT 'none'",
  "ALTER TABLE bookings ADD COLUMN notes_admin TEXT",
  "ALTER TABLE bookings ADD COLUMN reminder_sent INTEGER DEFAULT 0",
  "ALTER TABLE clients ADD COLUMN google_id TEXT",
  "ALTER TABLE bookings ADD COLUMN mp_preference_id TEXT",
  "ALTER TABLE bookings ADD COLUMN mp_payment_id TEXT",
  "ALTER TABLE bookings ADD COLUMN mp_url_deposit TEXT",
  "ALTER TABLE bookings ADD COLUMN mp_url_full TEXT",
  "ALTER TABLE services ADD COLUMN photo TEXT",
];
for (const _m of _migrations) { try { db.exec(_m); } catch (_e) {} }

// ─── booking_photos ────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS booking_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    comment TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function addBookingPhoto(bookingId, filePath, comment) {
  const r = db.prepare('INSERT INTO booking_photos (booking_id, file_path, comment) VALUES (?, ?, ?)').run(bookingId, filePath, comment || '');
  return db.prepare('SELECT * FROM booking_photos WHERE id = ?').get(r.lastInsertRowid);
}

function getBookingPhotos(bookingId) {
  return db.prepare('SELECT * FROM booking_photos WHERE booking_id = ? ORDER BY created_at ASC').all(bookingId);
}

function deleteBookingPhoto(photoId) {
  const photo = db.prepare('SELECT * FROM booking_photos WHERE id = ?').get(photoId);
  if (photo) db.prepare('DELETE FROM booking_photos WHERE id = ?').run(photoId);
  return photo;
}

function updateBookingAdmin(id, { notes_admin, payment_status }) {
  if (notes_admin !== undefined) db.prepare('UPDATE bookings SET notes_admin = ? WHERE id = ?').run(notes_admin, id);
  if (payment_status !== undefined) db.prepare('UPDATE bookings SET payment_status = ? WHERE id = ?').run(payment_status, id);
}

function getCurrentBooking() {
  const now = new Date();
  const today = localDateString(now);
  const currentMin = now.getHours() * 60 + now.getMinutes();

  // Busca citas de hoy que no estén canceladas
  const bookings = db.prepare(`
    SELECT b.*, c.name as client_name, s.name as service_name, s.duration,
           p.name as professional_name
    FROM bookings b
    JOIN clients c ON b.client_id = c.id
    JOIN services s ON b.service_id = s.id
    LEFT JOIN professionals p ON b.professional_id = p.id
    WHERE b.date = ? AND b.status != 'cancelled'
    ORDER BY b.time ASC
  `).all(today);

  if (!bookings.length) return null;

  // Encuentra la cita más cercana a la hora actual (en progreso o recién terminada)
  let best = null;
  let bestDiff = Infinity;
  for (const b of bookings) {
    const [h, m] = b.time.split(':').map(Number);
    const startMin = h * 60 + m;
    const endMin = startMin + (b.duration || 60);
    // Prioriza citas en progreso, luego la más próxima
    const diff = Math.abs(currentMin - startMin);
    if (currentMin >= startMin - 10 && currentMin <= endMin + 30) {
      // Está en progreso o acaba de terminar → prioridad máxima
      if (diff < bestDiff) { best = b; bestDiff = diff; }
    } else if (!best) {
      if (diff < bestDiff) { best = b; bestDiff = diff; }
    }
  }
  return best;
}

function getBookingsNeedingReminder(hoursAhead = 48) {
  const target = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
  const dateStr = localDateString(target);
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

// Retorna true solo si el UPDATE afectó una fila (previene doble envío con múltiples instancias)
function markReminderSent(id) {
  const result = db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ? AND reminder_sent = 0').run(id);
  return result.changes > 0;
}

function getWeekBookings() {
  const from = localDateString();
  const to = localDateString(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
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

function updateBookingPayment(id, { mp_preference_id, mp_payment_id, deposit_paid, mp_url_deposit, mp_url_full } = {}) {
  const sets = []; const params = {};
  if (mp_preference_id !== undefined) { sets.push('mp_preference_id = @mp_preference_id'); params.mp_preference_id = mp_preference_id; }
  if (mp_payment_id !== undefined)    { sets.push('mp_payment_id = @mp_payment_id');       params.mp_payment_id = mp_payment_id;       }
  if (deposit_paid   !== undefined)   { sets.push('deposit_paid = @deposit_paid');          params.deposit_paid = deposit_paid;          }
  if (mp_url_deposit !== undefined)   { sets.push('mp_url_deposit = @mp_url_deposit');      params.mp_url_deposit = mp_url_deposit;      }
  if (mp_url_full    !== undefined)   { sets.push('mp_url_full = @mp_url_full');            params.mp_url_full = mp_url_full;            }
  if (!sets.length) return;
  params.id = id;
  db.prepare(`UPDATE bookings SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

// ─── Push subscriptions ───────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint   TEXT UNIQUE NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    label      TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Reviews ──────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS reviews (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER,
    client_name TEXT NOT NULL,
    service_name TEXT,
    rating      INTEGER,
    comment     TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    approved    INTEGER DEFAULT 0,
    submitted   INTEGER DEFAULT 0,
    token       TEXT UNIQUE NOT NULL
  );
`);
try { db.exec("ALTER TABLE bookings ADD COLUMN review_sent INTEGER DEFAULT 0"); } catch(_e) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN gift_card_code TEXT"); } catch(_e) {}
try { db.exec("ALTER TABLE bookings ADD COLUMN gift_card_discount INTEGER DEFAULT 0"); } catch(_e) {}
try { db.exec("ALTER TABLE gift_cards ADD COLUMN recipient_email TEXT"); } catch(_e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS gift_cards (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    code            TEXT UNIQUE NOT NULL,
    amount          INTEGER NOT NULL,
    balance         INTEGER NOT NULL,
    purchaser_name  TEXT,
    purchaser_email TEXT,
    recipient_name  TEXT,
    status          TEXT DEFAULT 'active',
    booking_id      INTEGER,
    created_at      TEXT DEFAULT (datetime('now')),
    used_at         TEXT,
    note            TEXT
  );
`);

const _crypto = require('crypto');

function getBookingsNeedingReview() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = localDateString(yesterday);
  return db.prepare(`
    SELECT b.*, c.name as client_name, c.email as client_email, s.name as service_name
    FROM bookings b
    JOIN clients c ON b.client_id = c.id
    JOIN services s ON b.service_id = s.id
    WHERE b.date = ? AND b.review_sent = 0 AND b.status != 'cancelled'
    AND c.email IS NOT NULL AND c.email != ''
  `).all(dateStr);
}

function markReviewSent(id) {
  return db.prepare('UPDATE bookings SET review_sent = 1 WHERE id = ? AND review_sent = 0').run(id).changes > 0;
}

function createReviewToken(bookingId, clientName, serviceName) {
  const token = _crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT OR IGNORE INTO reviews (booking_id, client_name, service_name, token) VALUES (?, ?, ?, ?)')
    .run(bookingId, clientName, serviceName, token);
  return token;
}

function getReviewByToken(token) {
  return db.prepare('SELECT * FROM reviews WHERE token = ?').get(token);
}

function submitReview(token, { rating, comment }) {
  return db.prepare(
    'UPDATE reviews SET rating=?, comment=?, submitted=1 WHERE token=? AND submitted=0'
  ).run(rating, comment || '', token).changes > 0;
}

function getApprovedReviews() {
  return db.prepare('SELECT * FROM reviews WHERE approved=1 AND submitted=1 ORDER BY created_at DESC LIMIT 20').all();
}

function getAllReviews() {
  return db.prepare('SELECT * FROM reviews WHERE submitted=1 ORDER BY created_at DESC').all();
}

function approveReview(id) {
  const r = db.prepare('SELECT approved FROM reviews WHERE id=?').get(id);
  if (r) db.prepare('UPDATE reviews SET approved=? WHERE id=?').run(r.approved ? 0 : 1, id);
}

function deleteReview(id) {
  db.prepare('DELETE FROM reviews WHERE id=?').run(id);
}

// ─── Push subscriptions ───────────────────────────────────────────────────────
function savePushSubscription({ endpoint, p256dh, auth, label }) {
  db.prepare(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, label)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, label=excluded.label`
  ).run(endpoint, p256dh, auth, label || '');
}

function deletePushSubscription(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint);
}

function getAllPushSubscriptions() {
  return db.prepare('SELECT * FROM push_subscriptions').all();
}

// ─── GIFT CARDS ───────────────────────────────────────────────────────────────
function _gcCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = (n) => Array.from({length:n}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
  return `${part(4)}-${part(4)}`;
}

function createGiftCard({ amount, purchaser_name, purchaser_email, recipient_name, recipient_email, note, status }) {
  const code = _gcCode();
  const gcStatus = status || 'active';
  db.prepare(`INSERT INTO gift_cards (code, amount, balance, purchaser_name, purchaser_email, recipient_name, recipient_email, note, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(code, amount, amount, purchaser_name||'', purchaser_email||'', recipient_name||'', recipient_email||'', note||'', gcStatus);
  return db.prepare('SELECT * FROM gift_cards WHERE code=?').get(code);
}

function getGiftCardById(id) {
  return db.prepare('SELECT * FROM gift_cards WHERE id=?').get(id);
}

function getGiftCardByCode(code) {
  return db.prepare('SELECT * FROM gift_cards WHERE code=?').get((code||'').toUpperCase().trim());
}

const useGiftCard = db.transaction((code, booking_id, amount_used) => {
  const gc = getGiftCardByCode(code);
  if (!gc || gc.status !== 'active' || gc.balance <= 0) return null;
  const used = Math.min(amount_used, gc.balance);
  const newBalance = gc.balance - used;
  const result = db.prepare(`UPDATE gift_cards SET balance=?, booking_id=?,
              status=CASE WHEN ?=0 THEN 'used' ELSE 'active' END,
              used_at=CASE WHEN ?=0 THEN datetime('now') ELSE used_at END
              WHERE code=? AND status='active' AND balance=?`).run(newBalance, booking_id, newBalance, newBalance, gc.code, gc.balance);
  return result.changes > 0 ? used : null;
});

function getAllGiftCards() {
  return db.prepare('SELECT * FROM gift_cards ORDER BY created_at DESC').all();
}

function cancelGiftCard(id) {
  db.prepare("UPDATE gift_cards SET status='cancelled' WHERE id=?").run(id);
}

function activateGiftCard(id) {
  db.prepare("UPDATE gift_cards SET status='active' WHERE id=?").run(id);
}

// ─── MÉTRICAS ─────────────────────────────────────────────────────────────────
function getMetrics({ year, month } = {}) {
  const now = new Date();
  const y = year  ? parseInt(year)  : now.getFullYear();
  const m = month ? parseInt(month) : now.getMonth() + 1;
  const ym = `${y}-${String(m).padStart(2,'0')}`;

  const monthly = db.prepare(`
    SELECT strftime('%m',date) as month, strftime('%Y',date) as year,
           COUNT(*) as bookings, COALESCE(SUM(total_price),0) as revenue
    FROM bookings WHERE date >= date('now','-11 months') AND status!='cancelled'
    GROUP BY strftime('%Y-%m',date) ORDER BY date ASC
  `).all();

  const topServices = db.prepare(`
    SELECT s.name, COUNT(*) as bookings, COALESCE(SUM(b.total_price),0) as revenue
    FROM bookings b JOIN services s ON b.service_id=s.id
    WHERE b.date LIKE ? AND b.status!='cancelled'
    GROUP BY s.id ORDER BY bookings DESC LIMIT 5
  `).all(`${ym}-%`);

  const cancelRate = (() => {
    const total = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE date LIKE ?`).get(`${ym}-%`).c;
    const cancelled = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE date LIKE ? AND status='cancelled'`).get(`${ym}-%`).c;
    return total > 0 ? Math.round((cancelled/total)*100) : 0;
  })();

  const newClients = (() => {
    try {
      return db.prepare(`SELECT COUNT(*) as c FROM clients WHERE created_at LIKE ?`).get(`${ym}-%`).c;
    } catch(_) {
      // Fallback: clientes con su primera cita este mes
      return db.prepare(`SELECT COUNT(DISTINCT client_id) as c FROM bookings
        WHERE date LIKE ? AND status!='cancelled'
        AND client_id NOT IN (SELECT DISTINCT client_id FROM bookings WHERE date < ? AND status!='cancelled')`
      ).get(`${ym}-%`, `${ym}-01`).c;
    }
  })();

  const avgTicket = (() => {
    const r = db.prepare(`SELECT AVG(total_price) as avg FROM bookings WHERE date LIKE ? AND status!='cancelled' AND total_price>0`).get(`${ym}-%`);
    return Math.round(r?.avg || 0);
  })();

  return { monthly, topServices, cancelRate, newClients, avgTicket };
}

module.exports = {
  getSettings, updateSettings,
  getProfessionals, getProfessionalById, createProfessional, updateProfessional, deleteProfessional, purgeProfessional,
  purgeCancelledBookings, getCurrentBooking,
  getActiveServices, getAllServices, getServiceById, createService, updateService, deleteService, updateServicePhoto,
  getBusinessHours, updateBusinessHours,
  getAvailableSlots, getAvailableDates, isSlotAvailable,
  upsertClient, getClients, getClientById, getClientBookings, updateClient, deleteClient, mergeClients,
  createBooking, createBookingAtomic, getBookings, getBookingById, updateBooking, cancelBooking,
  getDashboardStats, getRevenue,
  findOrCreateClientByGoogle, cancelClientBooking,
  addBookingPhoto, getBookingPhotos, deleteBookingPhoto, updateBookingAdmin,
  getBookingsNeedingReminder, markReminderSent, getWeekBookings,
  updateBookingPayment,
  getBookingsNeedingReview, markReviewSent, createReviewToken,
  getReviewByToken, submitReview,
  getApprovedReviews, getAllReviews, approveReview, deleteReview,
  savePushSubscription, deletePushSubscription, getAllPushSubscriptions,
  createGiftCard, getGiftCardByCode, getGiftCardById, useGiftCard, getAllGiftCards, cancelGiftCard, activateGiftCard,
  getMetrics,
  createSessionStore,
};
