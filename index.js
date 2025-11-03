// ==========================
// QR YOKLAMA (Only StudentNo + Admin Login)
// ==========================

const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ---- Admin kimlik bilgileri (env varsa onu kullan, yoksa varsayılan)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

/* ===========================
   ORTA KATMANLAR
   =========================== */
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Her cihaza kalıcı bir kimlik (cookie)
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

/* ===========================
   DOSYA YOLLARI & YARDIMCILAR
   =========================== */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const DATA_FILE    = path.join(DATA_DIR, 'attendance.json');
const ROSTER_FILE  = path.join(DATA_DIR, 'roster.csv');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function ensureDataFiles() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE))    fs.writeFileSync(DATA_FILE, JSON.stringify({}), 'utf8');
  if (!fs.existsSync(DEVICES_FILE)) fs.writeFileSync(DEVICES_FILE, JSON.stringify({}), 'utf8');
}
function loadJSON(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8') || JSON.stringify(fallback));
  } catch { return fallback; }
}
function saveJSON(file, obj) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function loadData()     { return loadJSON(DATA_FILE, {}); }
function saveData(o)    { saveJSON(DATA_FILE, o); }
function loadDevices()  { return loadJSON(DEVICES_FILE, {}); }
function saveDevices(o) { saveJSON(DEVICES_FILE, o); }

function parseCSV(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0].split(',').map(h => h.trim());
  const idxNo = header.indexOf('studentNo');
  const idxName = header.indexOf('name');
  if (idxNo === -1 || idxName === -1) return [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    rows.push({ studentNo: cols[idxNo] || '', name: cols[idxName] || '' });
  }
  return rows;
}
function loadRoster() {
  try {
    if (!fs.existsSync(ROSTER_FILE)) return [];
    const text = fs.readFileSync(ROSTER_FILE, 'utf8');
    return parseCSV(text);
  } catch { return []; }
}

/* ===========================
   BASİT ADMIN AUTH
   =========================== */
function isAdmin(req) {
  return req.cookies && req.cookies.adminAuth === 'yes';
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Login sayfası
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
// Login kontrol
app.post('/api/login', (req, res) => {
  const { username = '', password = '' } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    res.cookie('adminAuth', 'yes', {
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 1000 * 60 * 60 * 12 // 12 saat
    });
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Kullanıcı adı/şifre hatalı' });
});
// Logout
app.post('/api/logout', (req, res) => {
  res.clearCookie('adminAuth');
  res.json({ ok: true });
});

/* ===========================
   STATİK & SAYFALAR
   =========================== */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/scan',(req, res) => res.sendFile(path.join(__dirname, 'public', 'scan.html')));

// /admin korumalı: login değilse /login’e yönlendir
app.get('/admin', (req, res) => {
  if (!isAdmin(req)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// favicon
app.get('/favicon.ico', (req, res) => res.status(204).end());

/* ===========================
   SAĞLIK & QR
   =========================== */
app.get('/ping', (req, res) => res.send('pong 🏓'));
app.get('/healthz', (req, res) => res.send('ok'));

// ---- QR üretme (derin link ile)
app.get('/qr', async (req, res) => {
  try {
    // İstenilen kod (t, code veya text parametresi ile gelebilir)
    const code = (req.query.code || req.query.t || req.query.text || 'DEMO').toString().trim();

    // Tam URL: https://host/scan?code=...&auto=1
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const deepLink = `${baseUrl}/scan?code=${encodeURIComponent(code)}&auto=1`;

    const pngBuffer = await QRCode.toBuffer(deepLink, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 6
    });
    res.set('Content-Type', 'image/png');
    res.send(pngBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).send('QR üretilemedi');
  }
});
});

/* ===========================
   CİHAZ PROFİLİ (sunucuda saklama)
   =========================== */
app.post('/api/register-device', (req, res) => {
  const deviceId = req.cookies.deviceId;
  if (!deviceId) return res.status(400).json({ error: 'device cookie yok' });
  const name = (req.body.name || '').trim();
  const studentNo = (req.body.studentNo || '').trim();
  if (!name && !studentNo) return res.status(400).json({ error: 'name veya studentNo gerekli' });

  const dev = loadDevices();
  dev[deviceId] = { name, studentNo, registeredAt: new Date().toISOString() };
  saveDevices(dev);
  return res.json({ ok: true });
});

app.get('/api/device-profile', (req, res) => {
  const deviceId = req.cookies.deviceId;
  if (!deviceId) return res.json({});
  const dev = loadDevices();
  return res.json(dev[deviceId] || {});
});

/* ===========================
   YOKLAMA (KALICI JSON)
   =========================== */
// Not: eşleşme sadece studentNo ile yapılacak (isim kullanılmıyor)
app.post('/api/check-in', (req, res) => {
  const code = (req.body.code || '').trim();
  const name = (req.body.name || '').trim();
  const studentNo = (req.body.studentNo || '').trim();
  const deviceId = req.cookies.deviceId;

  if (!code)     return res.status(400).json({ status: 'error', message: 'code zorunlu' });
  if (!deviceId) return res.status(400).json({ status: 'error', message: 'device cookie yok' });

  // İsim/No boşsa cihaz profilinden doldur
  const dev = loadDevices();
  let effectiveName = name;
  let effectiveNo   = studentNo;
  if ((!effectiveName || !effectiveNo) && dev[deviceId]) {
    if (!effectiveName) effectiveName = dev[deviceId].name || '';
    if (!effectiveNo)   effectiveNo   = dev[deviceId].studentNo || '';
  }

  const db = loadData();
  if (!Array.isArray(db[code])) db[code] = [];

  // aynı cihaz aynı koda ikinci kez yoklama veremez
  const already = db[code].some(r => r.deviceId === deviceId);
  if (already) return res.json({ status: 'already_checked' });

  db[code].push({
    deviceId,
    time: new Date().toISOString(),
    name: effectiveName,
    studentNo: effectiveNo
  });

  saveData(db);
  return res.json({ status: 'success' });
});

/* ===========================
   ÖZET / RAPOR (JSON)
   =========================== */
app.get('/api/summary', (req, res) => {
  const code = (req.query.code || '').trim();
  const db = loadData();
  const rows = Array.isArray(db[code]) ? db[code] : [];
  const devices = rows.map(r =>
    (r.deviceId && r.deviceId.length > 8)
      ? r.deviceId.slice(0, 4) + '...' + r.deviceId.slice(-4)
      : (r.deviceId || '')
  );
  res.json({ code, count: rows.length, devices });
});

app.get('/api/summary-all', requireAdmin, (req, res) => {
  const db = loadData();
  const out = Object.keys(db).map(code => ({ code, count: (db[code] || []).length }));
  res.json(out);
});

app.post('/api/reset', requireAdmin, (req, res) => {
  const code = (req.body.code || '').trim();
  if (!code) return res.status(400).json({ message: 'code zorunlu' });
  const db = loadData();
  if (db[code]) {
    delete db[code];
    saveData(db);
    return res.json({ message: 'Sıfırlandı' });
  }
  return res.json({ message: 'Kod bulunamadı (zaten yok)' });
});

/* ===========================
   EXPORT (CSV & EXCEL)
   =========================== */
app.get('/api/export', requireAdmin, (req, res) => {
  const code = (req.query.code || '').trim();
  const db = loadData();
  const rows = Array.isArray(db[code]) ? db[code] : [];
  const header = 'code,time,name,studentNo,deviceId';
  const csv = [header].concat(
    rows.map(r => {
      const safe = s => (s == null ? '' : String(s).replace(/"/g, '""'));
      return `"${safe(code)}","${safe(r.time)}","${safe(r.name)}","${safe(r.studentNo)}","${safe(r.deviceId)}"`;
    })
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${code || 'export'}.csv"`);
  res.send(csv);
});

/* ===========================
   ROSTER DURUMU (SADECE STUDENTNO)
   =========================== */
// İsimle EŞLEŞME YOK! (kasıtlı)
app.get('/api/roster-status', (req, res) => {
  const code = (req.query.code || '').trim();
  const roster = loadRoster(); // [{studentNo,name}]
  const db = loadData();
  const rows = Array.isArray(db[code]) ? db[code] : [];

  // Sadece studentNo ile map
  const byNo = new Map();
  for (const r of rows) {
    if (r.studentNo) byNo.set(String(r.studentNo).trim(), r);
  }

  let presentCount = 0;
  const list = roster.map(s => {
    const sNo = String(s.studentNo || '').trim();
    const rec = sNo && byNo.get(sNo) ? byNo.get(sNo) : null;
    const present = !!rec;
    if (present) presentCount++;
    return { studentNo: s.studentNo, name: s.name, present, time: rec ? rec.time : undefined };
  });

  res.json({ code, total: roster.length, present: presentCount, list });
});

/* ===========================
   EXCEL: ROSTER + ✓ / ✗  (SADECE STUDENTNO)
   =========================== */
app.get('/api/export-roster', requireAdmin, async (req, res) => {
  try {
    const code = (req.query.code || '').trim();
    if (!code) return res.status(400).send('code zorunlu');

    const roster = loadRoster();
    const db = loadData();
    const rows = Array.isArray(db[code]) ? db[code] : [];

    const byNo = new Map();
    for (const r of rows) {
      if (r.studentNo) byNo.set(String(r.studentNo).trim(), r);
    }

    const wb = new ExcelJS.Workbook();
    const sh = wb.addWorksheet('Yoklama');

    sh.insertRow(1, []);
    sh.insertRow(2, []);

    sh.columns = [
      { header: 'Sıra',       key: 'sira',      width: 6  },
      { header: 'Öğrenci No', key: 'studentNo', width: 14 },
      { header: 'Ad Soyad',   key: 'name',      width: 28 },
      { header: 'Durum',      key: 'durum',     width: 8  },
      { header: 'Zaman',      key: 'time',      width: 22 },
      { header: 'Kod',        key: 'code',      width: 22 },
      { header: 'Not',        key: 'note',      width: 18 },
    ];

    let sira = 1;
    let presentCount = 0;
    for (const s of roster) {
      const sNo = String(s.studentNo || '').trim();
      const rec = sNo && byNo.get(sNo) ? byNo.get(sNo) : null;

      const ok = !!rec;
      if (ok) presentCount++;

      sh.addRow({
        sira,
        studentNo: s.studentNo,
        name: s.name,
        durum: ok ? '✓' : '✗',
        time: ok ? rec.time : '',
        code,
        note: ''
      });
      sira++;
    }

    const total = roster.length;
    const absent = total - presentCount;
    sh.getCell('C2').value = `Kod: ${code}`;
    sh.getCell('D2').value = `Toplam: ${total}`;
    sh.getCell('E2').value = `Gelen: ${presentCount}`;
    sh.getCell('F2').value = `Gel(e)meyen: ${absent}`;
    sh.getRow(3).font = { bold: true };

    const filename = `roster_${code}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).send('Excel oluşturulamadı');
  }
});

/* ===========================
   SUNUCU
   =========================== */
app.listen(PORT, () => {
  ensureDataFiles();
  console.log(`http://localhost:${PORT} adresinde çalışıyor`);
});
