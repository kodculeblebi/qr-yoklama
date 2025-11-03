// index.js — QR Yoklama (admin login → aktif kod → QR → scan; deviceId map; roster ✓/✗ export)
const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ---- Middlewares
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Give device a stable id cookie
app.use((req, res, next) => {
  if (!req.cookies.deviceId) {
    res.cookie('deviceId', uuidv4(), {
      httpOnly: false,
      sameSite: 'Lax',
      maxAge: 1000 * 60 * 60 * 24 * 180 // 180 days
    });
  }
  next();
});

// ---- Static
app.use(express.static(path.join(__dirname, 'public')));

// ---- Data files
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'attendance.json');  // { [code]: [ {deviceId,time,studentNo,name} ] }
const ACTIVE_FILE = path.join(DATA_DIR, 'active.json');  // { code, since }
const MAP_FILE = path.join(DATA_DIR, 'map.json');        // { [deviceId]: { studentNo, name, updatedAt } }
const ROSTER_FILE = path.join(DATA_DIR, 'roster.csv');   // CSV: studentNo,name (header required)

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8') || JSON.stringify(fallback)); }
  catch { return fallback; }
}
function saveJson(file, obj) { ensureDir(); fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8'); }
function ensureFiles() {
  ensureDir();
  if (!fs.existsSync(DB_FILE)) saveJson(DB_FILE, {});
  if (!fs.existsSync(ACTIVE_FILE)) saveJson(ACTIVE_FILE, { code: '', since: '' });
  if (!fs.existsSync(MAP_FILE)) saveJson(MAP_FILE, {});
}
ensureFiles();

// ---- Helpers
function isAdmin(req) { return req.cookies && req.cookies.admin === '1'; }
function parseRosterCsv() {
  try {
    if (!fs.existsSync(ROSTER_FILE)) return [];
    const raw = fs.readFileSync(ROSTER_FILE, 'utf8');
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const idxNo = header.indexOf('studentno');
    const idxName = header.indexOf('name');
    const out = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      const studentNo = (parts[idxNo] || '').trim();
      const name = (parts[idxName] || '').trim();
      if (studentNo) out.push({ studentNo, name });
    }
    return out;
  } catch { return []; }
}

// ---- Health
app.get('/ping', (req, res) => res.send('pong 🏓'));
app.get('/healthz', (req, res) => res.send('ok'));

// ---- Admin Auth
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '123456';

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    res.cookie('admin', '1', { httpOnly: true, sameSite: 'Lax', maxAge: 1000 * 60 * 60 * 8 });
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false });
});

app.post('/logout', (req, res) => { res.clearCookie('admin'); res.json({ ok: true }); });
app.get('/api/is-admin', (req, res) => res.json({ isAdmin: isAdmin(req) }));

// ---- Device identity mapping (so phone is recognized next time)
app.get('/api/device', (req, res) => {
  const map = loadJson(MAP_FILE, {});
  const info = map[req.cookies.deviceId] || null;
  res.json({ deviceId: req.cookies.deviceId || null, info });
});

// ---- Active code (admin set, public read)
app.get('/api/active-code', (req, res) => {
  const active = loadJson(ACTIVE_FILE, { code: '', since: '' });
  res.json(active);
});
app.post('/api/active-code', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ message: 'login required' });
  const code = String(req.body.code || '').trim();
  const active = { code, since: code ? new Date().toISOString() : '' };
  saveJson(ACTIVE_FILE, active);
  res.json({ ok: true, active });
});

// ---- QR: always deep-link to /scan
app.get('/qr', async (req, res) => {
  try {
    const active = loadJson(ACTIVE_FILE, { code: '', since: '' });
    const code = String(req.query.code || req.query.t || req.query.text || active.code || '').trim();
    if (!code) return res.status(400).send('Kod yok');

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const deepLink = `${baseUrl}/scan?code=${encodeURIComponent(code)}&auto=1`;

    const buf = await QRCode.toBuffer(deepLink, { type: 'png', errorCorrectionLevel: 'M', margin: 1, scale: 10 });
    res.set('Content-Type', 'image/png');
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).send('QR üretilemedi');
  }
});

// ---- Check-in: only studentNo; map device -> studentNo for future
app.post('/api/check-in', (req, res) => {
  const code = (req.body.code || '').trim();
  const studentNo = (req.body.studentNo || '').trim();
  const name = (req.body.name || '').trim();
  const deviceId = req.cookies.deviceId;

  if (!code) return res.status(400).json({ status: 'error', message: 'code zorunlu' });
  if (!studentNo) return res.status(400).json({ status: 'error', message: 'studentNo zorunlu' });
  if (!deviceId) return res.status(400).json({ status: 'error', message: 'device cookie yok' });

  const db = loadJson(DB_FILE, {});
  if (!Array.isArray(db[code])) db[code] = [];

  // same device can't submit twice for same code
  const already = db[code].some(r => r.deviceId === deviceId);
  if (already) {
    // ensure mapping is saved anyway
    const map = loadJson(MAP_FILE, {});
    map[deviceId] = { studentNo, name, updatedAt: new Date().toISOString() };
    saveJson(MAP_FILE, map);
    return res.json({ status: 'already_checked' });
  }

  // write attendance
  db[code].push({ deviceId, time: new Date().toISOString(), studentNo, name });
  saveJson(DB_FILE, db);

  // update mapping so next scans auto-fill without asking again
  const map = loadJson(MAP_FILE, {});
  map[deviceId] = { studentNo, name, updatedAt: new Date().toISOString() };
  saveJson(MAP_FILE, map);

  res.json({ status: 'success' });
});

// ---- Summaries
app.get('/api/summary', (req, res) => {
  const code = (req.query.code || '').trim();
  const db = loadJson(DB_FILE, {});
  const rows = Array.isArray(db[code]) ? db[code] : [];
  res.json({ code, count: rows.length });
});
app.get('/api/summary-all', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ message: 'login required' });
  const db = loadJson(DB_FILE, {});
  const out = Object.keys(db).map(code => ({ code, count: (db[code] || []).length }));
  res.json(out);
});

// ---- Raw CSV export (same as before)
app.get('/api/export', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ message: 'login required' });
  const code = (req.query.code || '').trim();
  const db = loadJson(DB_FILE, {});
  const rows = Array.isArray(db[code]) ? db[code] : [];
  const header = 'code,time,studentNo,deviceId,name';
  const csv = [header].concat(
    rows.map(r => {
      const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
      return [q(code), q(r.time), q(r.studentNo), q(r.deviceId), q(r.name)].join(',');
    })
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${code || 'export'}.csv"`);
  res.send(csv);
});

// ---- Roster ✓/✗ Excel export (admin): /api/export-roster?code=...
app.get('/api/export-roster', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ message: 'login required' });
  const code = (req.query.code || '').trim();
  const db = loadJson(DB_FILE, {});
  const rows = Array.isArray(db[code]) ? db[code] : [];
  const roster = parseRosterCsv(); // [{studentNo,name}]

  // Build a set of studentNos present
  const presentSet = new Set(rows.map(r => (r.studentNo || '').trim()));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Yoklama');

  ws.columns = [
    { header: 'Öğrenci No', key: 'studentNo', width: 16 },
    { header: 'Ad Soyad',   key: 'name', width: 28 },
    { header: 'Durum',      key: 'status', width: 10 },
    { header: 'Saat',       key: 'time', width: 22 },
  ];

  // Fill rows in roster order with ✓/✗
  roster.forEach(r => {
    let status = '✗';
    let time = '';
    if (presentSet.has(r.studentNo)) {
      status = '✓';
      const hit = rows.find(x => (x.studentNo || '').trim() === r.studentNo);
      time = hit?.time || '';
    }
    ws.addRow({ studentNo: r.studentNo, name: r.name, status, time });
  });

  // And include extra attendees not in roster (optional)
  rows.forEach(r => {
    if (!roster.find(rr => rr.studentNo === r.studentNo)) {
      ws.addRow({ studentNo: r.studentNo, name: r.name || '', status: '✓', time: r.time });
    }
  });

  // basic styling for header
  ws.getRow(1).font = { bold: true };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="roster_${code || 'ders'}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ---- Pages
app.get('/',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/scan',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'scan.html')));
app.get('/present',(req, res) => res.sendFile(path.join(__dirname, 'public', 'present.html')));

// ---- Start
app.listen(PORT, () => {
  ensureFiles();
  console.log(`✅ Running at http://localhost:${PORT}`);
});
