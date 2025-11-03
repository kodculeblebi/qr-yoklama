// index.js — QR Yoklama (admin QR başlatır; öğrenci /scan'den otomatik yoklama)
// ------------------------------------------------------------
const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ---- Orta katmanlar
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cihaza benzersiz  cookie
app.use((req, res, next) => {
  if (!req.cookies.deviceId) {
    res.cookie('deviceId', uuidv4(), {
      httpOnly: false,
      sameSite: 'Lax',
      maxAge: 1000 * 60 * 60 * 24 * 180 // 180 gün
    });
  }
  next();
});

// ---- Statik
app.use(express.static(path.join(__dirname, 'public')));

// ---- Veri dosyaları
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'attendance.json');
const ACTIVE_FILE = path.join(DATA_DIR, 'active.json');     // { code: "YBS311-01", since: "...iso..." }
const ROSTER_FILE = path.join(DATA_DIR, 'roster.csv');       // optional

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8') || JSON.stringify(fallback)); }
  catch { return fallback; }
}
function saveJson(file, obj) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function ensureDataFiles() {
  ensureDataDir();
  if (!fs.existsSync(DB_FILE)) saveJson(DB_FILE, {});
  if (!fs.existsSync(ACTIVE_FILE)) saveJson(ACTIVE_FILE, { code: '', since: '' });
}
ensureDataFiles();

// ---- Sağlık
app.get('/ping', (req, res) => res.send('pong 🏓'));
app.get('/healthz', (req, res) => res.send('ok'));

// ---- Basit admin auth (ENV ile)
//  - /login sayfasından post ile gelir; doğruysa cookie: admin=1
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '123456';

function isAdmin(req) {
  return req.cookies && req.cookies.admin === '1';
}

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    res.cookie('admin', '1', {
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 1000 * 60 * 60 * 8
    });
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, message: 'Yetkisiz' });
});

app.post('/logout', (req, res) => {
  res.clearCookie('admin');
  res.json({ ok: true });
});

// ---- Aktif kod set/get (sadece admin)
app.get('/api/active-code', (req, res) => {
  const active = loadJson(ACTIVE_FILE, { code: '', since: '' });
  res.json(active);
});

app.post('/api/active-code', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ message: 'login gerekli' });
  const code = String(req.body.code || '').trim();
  const active = { code, since: code ? new Date().toISOString() : '' };
  saveJson(ACTIVE_FILE, active);
  res.json({ ok: true, active });
});

// ---- QR üretme (daima link üretir; admin panel ve /present bunu kullanır)
app.get('/qr', async (req, res) => {
  try {
    // Öncelik: query'deki code; yoksa aktif kod
    const active = loadJson(ACTIVE_FILE, { code: '', since: '' });
    const code = String(req.query.code || req.query.t || req.query.text || active.code || '').trim();
    if (!code) return res.status(400).send('Kod yok');

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const deepLink = `${baseUrl}/scan?code=${encodeURIComponent(code)}&auto=1`;

    const png = await QRCode.toBuffer(deepLink, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 10
    });
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (e) {
    console.error(e);
    res.status(500).send('QR üretilemedi');
  }
});

// ---- Yoklama: sadece studentNo ile
// body: { code, studentNo, name? }  (name opsiyonel)
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

  // aynı cihaz aynı koda iki kez veremez
  const already = db[code].some(r => r.deviceId === deviceId);
  if (already) {
    return res.json({ status: 'already_checked' });
  }

  db[code].push({
    deviceId,
    time: new Date().toISOString(),
    studentNo,
    name
  });
  saveJson(DB_FILE, db);

  res.json({ status: 'success' });
});

// ---- Özetler / Export (admin)
app.get('/api/summary', (req, res) => {
  const code = (req.query.code || '').trim();
  const db = loadJson(DB_FILE, {});
  const rows = Array.isArray(db[code]) ? db[code] : [];
  res.json({ code, count: rows.length });
});

app.get('/api/summary-all', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ message: 'login gerekli' });
  const db = loadJson(DB_FILE, {});
  const out = Object.keys(db).map(code => ({ code, count: (db[code] || []).length }));
  res.json(out);
});

// ---- CSV Export ham kayıtlar
app.get('/api/export', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ message: 'login gerekli' });
  const code = (req.query.code || '').trim();
  const db = loadJson(DB_FILE, {});
  const rows = Array.isArray(db[code]) ? db[code] : [];
  const header = 'code,time,studentNo,deviceId,name';
  const csv = [header].concat(
    rows.map(r => {
      const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
      return [q(code), q(r.time), q(r.studentNo), q(r.deviceId), q(r.name)].join(',');
    })
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${code || 'export'}.csv"`);
  res.send(csv);
});

// ---- Roster (opsiyonel) — hızlı ✓/✗ excel istersen ileride ekleriz
// Bu sürümde odak: QR → /present → /scan → otomatik yoklama

// ---- Sayfa yönlendirmeleri
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/scan', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scan.html')));
app.get('/present', (req, res) => res.sendFile(path.join(__dirname, 'public', 'present.html')));

// ---- Başlat
app.listen(PORT, () => {
  ensureDataFiles();
  console.log(`✅ Çalışıyor: http://localhost:${PORT}`);
});
