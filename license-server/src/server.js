require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';

app.use(cors());
app.use(express.json({ limit: '2mb' }));

const licenseSchema = new mongoose.Schema({
  name: String,
  email: { type: String, required: true, index: true },
  licenseKey: { type: String, required: true, unique: true, index: true },
  status: { type: String, default: 'active' },
  plan: { type: String, default: 'Mensal' },
  expiresAt: Date,
  dailyLimit: { type: Number, default: 300 },
  connectionLimit: { type: Number, default: 1 },
  allowedDevices: { type: Number, default: 1 },
  devices: [{ deviceId: String, activatedAt: Date, lastCheckAt: Date }],
  notes: String
}, { timestamps: true });

const License = mongoose.model('License', licenseSchema);

function requireAdmin(req, res, next) {
  if (String(req.headers['x-admin-key'] || '') !== String(ADMIN_KEY)) {
    return res.status(401).json({ ok: false, message: 'Admin não autorizado.' });
  }
  next();
}

function generateLicenseKey(email = '') {
  const hash = crypto.randomBytes(4).toString('hex').toUpperCase();
  const prefix = String(email).split('@')[0].replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase() || 'CLIENT';
  return `ZAP-${prefix}-${hash}`;
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'zapdisparo-license-server' }));

app.post('/api/license/verify', async (req, res) => {
  const { email, licenseKey, deviceId } = req.body || {};
  if (!email || !licenseKey || !deviceId) {
    return res.status(400).json({ active: false, reason: 'Informe e-mail, licença e deviceId.' });
  }

  const license = await License.findOne({ email: String(email).trim().toLowerCase(), licenseKey: String(licenseKey).trim() });
  if (!license) return res.status(404).json({ active: false, reason: 'Licença não encontrada.' });
  if (!['active', 'ativo'].includes(String(license.status).toLowerCase())) return res.status(403).json({ active: false, reason: 'Licença bloqueada ou inativa.' });
  if (license.expiresAt && new Date(license.expiresAt).getTime() < Date.now()) return res.status(403).json({ active: false, reason: 'Assinatura vencida.' });

  const devices = license.devices || [];
  const existing = devices.find((item) => item.deviceId === deviceId);
  if (!existing && devices.length >= Number(license.allowedDevices || 1)) return res.status(403).json({ active: false, reason: 'Limite de máquinas atingido para esta licença.' });

  if (existing) existing.lastCheckAt = new Date();
  else devices.push({ deviceId, activatedAt: new Date(), lastCheckAt: new Date() });

  license.devices = devices;
  await license.save();

  res.json({
    ok: true,
    active: true,
    status: license.status,
    plan: license.plan,
    expiresAt: license.expiresAt,
    dailyLimit: license.dailyLimit,
    connectionLimit: license.connectionLimit,
    allowedDevices: license.allowedDevices,
    devicesUsed: license.devices.length
  });
});

app.get('/api/admin/licenses', requireAdmin, async (req, res) => {
  const licenses = await License.find().sort({ createdAt: -1 }).lean();
  res.json({ ok: true, licenses });
});

app.post('/api/admin/licenses', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const license = await License.create({
    name: body.name || '',
    email: String(body.email || '').trim().toLowerCase(),
    licenseKey: body.licenseKey || generateLicenseKey(body.email),
    status: body.status || 'active',
    plan: body.plan || 'Mensal',
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    dailyLimit: Number(body.dailyLimit || 300),
    connectionLimit: Number(body.connectionLimit || 1),
    allowedDevices: Number(body.allowedDevices || 1),
    notes: body.notes || ''
  });
  res.json({ ok: true, license });
});

app.patch('/api/admin/licenses/:id', requireAdmin, async (req, res) => {
  const license = await License.findByIdAndUpdate(req.params.id, req.body || {}, { new: true });
  res.json({ ok: true, license });
});

app.delete('/api/admin/licenses/:id', requireAdmin, async (req, res) => {
  await License.findByIdAndDelete(req.params.id);
  res.json({ ok: true, deleted: true });
});

async function start() {
  if (!MONGODB_URI) throw new Error('Configure MONGODB_URI no .env');
  await mongoose.connect(MONGODB_URI);
  app.listen(PORT, () => console.log(`License server running on port ${PORT}`));
}

start().catch((error) => { console.error(error); process.exit(1); });
