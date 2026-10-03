require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Database ----------
const db = new Database(path.join(__dirname, 'reports.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  priority INTEGER NOT NULL,
  description TEXT NOT NULL,
  note TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  image TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  ai_source TEXT NOT NULL DEFAULT 'claude',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

// Add AI detail columns to existing databases (safe to run every start)
for (const col of ['ai_department TEXT', 'ai_action TEXT', 'ai_confidence INTEGER']) {
  try { db.exec(`ALTER TABLE reports ADD COLUMN ${col}`); } catch (e) { /* already exists */ }
}

// ---------- AI analysis ----------
const DEPARTMENTS = ['Roads & Traffic', 'Electricity', 'Water & Sewage', 'Sanitation', 'Parks & Public Spaces', 'Other'];
const PROBLEM_TYPES = ['Pothole', 'Broken Street Light', 'Garbage', 'Water Leak / Sewage', 'Damaged Road Sign', 'Damaged Sidewalk', 'Graffiti / Vandalism', 'Other'];
const SEVERITIES = ['High', 'Medium', 'Low'];

const SYSTEM_PROMPT = `You triage municipal issue reports for the city of Slemani (Sulaymaniyah), Iraq.
Look at the photo and respond with ONLY a JSON object, no prose, no code fences:
{
  "problem_type": one of ${JSON.stringify(PROBLEM_TYPES)},
  "severity": "High" | "Medium" | "Low",
  "priority": integer 1-5 (5 = fix immediately, 1 = routine),
  "description": one or two sentences describing what is visible, factual and concise,
  "department": one of ${JSON.stringify(DEPARTMENTS)} (the city department that should handle it),
  "suggested_action": one short sentence telling the crew what to do (e.g. "Fill and compact the pothole, place a warning cone until repaired"),
  "confidence": integer 0-100 (how sure you are about problem_type and severity),
  "is_municipal_issue": true/false (false if the photo shows no municipal problem)
}
Severity guide: High = immediate danger to people/vehicles or major service failure (deep pothole on a busy road, exposed wires, sewage flooding). Medium = clear nuisance or degrading condition. Low = cosmetic or minor.`;

let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
} else {
  console.warn('[warn] ANTHROPIC_API_KEY not set: using MOCK analysis (for demo/testing only).');
}

function normalize(raw) {
  const problem_type = PROBLEM_TYPES.includes(raw.problem_type) ? raw.problem_type : 'Other';
  const severity = SEVERITIES.includes(raw.severity) ? raw.severity : 'Medium';
  let priority = parseInt(raw.priority, 10);
  if (!(priority >= 1 && priority <= 5)) priority = severity === 'High' ? 5 : severity === 'Medium' ? 3 : 1;
  const description = String(raw.description || 'No description available.').slice(0, 500);
  const department = DEPARTMENTS.includes(raw.department) ? raw.department : 'Other';
  const suggested_action = String(raw.suggested_action || '').slice(0, 300);
  let confidence = parseInt(raw.confidence, 10);
  if (!(confidence >= 0 && confidence <= 100)) confidence = null;
  return { problem_type, severity, priority, description, department, suggested_action, confidence, is_municipal_issue: raw.is_municipal_issue !== false };
}

async function analyzeImage(buffer, mimeType) {
  if (!anthropic) {
    const pick = PROBLEM_TYPES[Math.floor(Math.random() * 3)];
    const sev = SEVERITIES[Math.floor(Math.random() * 3)];
    return { ...normalize({ problem_type: pick, severity: sev, description: `[MOCK] Simulated analysis of a ${pick.toLowerCase()}.`, department: DEPARTMENTS[Math.floor(Math.random() * 4)], suggested_action: '[MOCK] Send a crew to inspect and repair.', confidence: 70 + Math.floor(Math.random() * 28) }), source: 'mock' };
  }
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } },
        { type: 'text', text: 'Analyze this municipal issue photo.' }
      ]
    }]
  });
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return JSON');
  return { ...normalize(JSON.parse(match[0])), source: 'claude' };
}

// ---------- Web server ----------
const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(ALLOWED[file.mimetype] ? null : new Error('Only JPG, PNG or WebP images are allowed'), !!ALLOWED[file.mimetype])
});

const app = express();
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const publicFields = 'id, problem_type, severity, priority, description, lat, lng, image, status, created_at, ai_department, ai_action, ai_confidence';

// Public client config (Google Maps browser keys are public; restrict yours by HTTP referrer in Google Cloud)
app.get('/api/config', (req, res) => {
  res.json({ googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || null });
});

// Submit a report
app.post('/api/reports', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Photo is required' });
    const lat = parseFloat(req.body.lat), lng = parseFloat(req.body.lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'Valid location is required' });
    }
    const ai = await analyzeImage(req.file.buffer, req.file.mimetype);
    if (!ai.is_municipal_issue) {
      return res.status(422).json({ error: 'The AI could not see a municipal issue in this photo. Please retake it closer to the problem.', analysis: ai });
    }
    const filename = crypto.randomUUID() + ALLOWED[req.file.mimetype];
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);
    const note = (req.body.note || '').toString().slice(0, 300);
    const info = db.prepare(`INSERT INTO reports (problem_type, severity, priority, description, note, lat, lng, image, ai_source, ai_department, ai_action, ai_confidence)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(ai.problem_type, ai.severity, ai.priority, ai.description, note, lat, lng, '/uploads/' + filename, ai.source, ai.department, ai.suggested_action, ai.confidence);
    res.status(201).json(db.prepare(`SELECT ${publicFields} FROM reports WHERE id=?`).get(info.lastInsertRowid));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not analyze the photo. Please try again.' });
  }
});

// Public list (for the live map)
app.get('/api/reports', (req, res) => {
  const { severity, status } = req.query;
  let sql = `SELECT ${publicFields} FROM reports WHERE 1=1`;
  const params = [];
  if (SEVERITIES.includes(severity)) { sql += ' AND severity=?'; params.push(severity); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY id DESC LIMIT 1000';
  res.json(db.prepare(sql).all(...params));
});

// Admin
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || '';
  const a = Buffer.from(key), b = Buffer.from(ADMIN_KEY);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const count = (sql) => db.prepare(sql).all();
  res.json({
    total: db.prepare('SELECT COUNT(*) c FROM reports').get().c,
    open: db.prepare("SELECT COUNT(*) c FROM reports WHERE status!='resolved'").get().c,
    bySeverity: count('SELECT severity k, COUNT(*) n FROM reports GROUP BY severity'),
    byType: count('SELECT problem_type k, COUNT(*) n FROM reports GROUP BY problem_type ORDER BY n DESC'),
    byStatus: count('SELECT status k, COUNT(*) n FROM reports GROUP BY status'),
    last7days: count("SELECT date(created_at) k, COUNT(*) n FROM reports WHERE created_at >= datetime('now','-7 days') GROUP BY date(created_at) ORDER BY k")
  });
});

app.get('/api/admin/reports', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM reports ORDER BY priority DESC, id DESC LIMIT 2000').all());
});

app.patch('/api/admin/reports/:id', requireAdmin, (req, res) => {
  const { status, severity, priority } = req.body || {};
  const cur = db.prepare('SELECT * FROM reports WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const newStatus = ['open', 'in_progress', 'resolved'].includes(status) ? status : cur.status;
  const newSev = SEVERITIES.includes(severity) ? severity : cur.severity;
  const p = parseInt(priority, 10);
  const newPri = p >= 1 && p <= 5 ? p : cur.priority;
  db.prepare('UPDATE reports SET status=?, severity=?, priority=? WHERE id=?').run(newStatus, newSev, newPri, cur.id);
  res.json(db.prepare('SELECT * FROM reports WHERE id=?').get(cur.id));
});

app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || 'Bad request' });
});

app.listen(PORT, () => console.log(`Slemani Fix AI running on http://localhost:${PORT}`));
