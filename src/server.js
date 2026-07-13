require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';
const DOWNLOAD_URL = process.env.DOWNLOAD_URL || 'https://seusite.com/download/ZapDisparo-Setup.exe';
const SALES_ORIGIN = process.env.SALES_ORIGIN || '*';

app.use(cors({ origin: SALES_ORIGIN === '*' ? true : SALES_ORIGIN.split(',').map((item) => item.trim()) }));
app.use(express.json({ limit: '2mb' }));

const deviceSchema = new mongoose.Schema({
  deviceId: String,
  activatedAt: Date,
  lastCheckAt: Date
}, { _id: false });

const licenseSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  email: { type: String, required: true, index: true, lowercase: true, trim: true },
  licenseKey: { type: String, required: true, unique: true, index: true, trim: true },
  status: { type: String, enum: ['active', 'blocked', 'cancelled'], default: 'active', index: true },
  plan: { type: String, default: 'Mensal', index: true },
  expiresAt: { type: Date, index: true },
  dailyLimit: { type: Number, default: 300, min: 1 },
  connectionLimit: { type: Number, default: 1, min: 1 },
  allowedDevices: { type: Number, default: 1, min: 1 },
  devices: [deviceSchema],
  notes: String,
  lastEmailSentAt: Date
}, { timestamps: true });

const purchaseSchema = new mongoose.Schema({
  orderCode: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  email: { type: String, required: true, index: true, lowercase: true, trim: true },
  phone: String,
  cpfCnpj: String,
  plan: { type: String, default: 'Mensal' },
  amount: { type: Number, default: 97 },
  paymentMethod: { type: String, default: 'pix' },
  paymentReference: String,
  status: { type: String, enum: ['pending', 'paid', 'cancelled'], default: 'pending', index: true },
  licenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'License' },
  licenseKey: String,
  downloadUrl: String,
  paidAt: Date,
  emailSentAt: Date,
  emailError: String,
  notes: String
}, { timestamps: true });

const auditSchema = new mongoose.Schema({
  action: { type: String, required: true, index: true },
  entityType: String,
  entityId: String,
  summary: String,
  metadata: mongoose.Schema.Types.Mixed,
  ip: String
}, { timestamps: true });

const License = mongoose.model('License', licenseSchema);
const Purchase = mongoose.model('Purchase', purchaseSchema);
const Audit = mongoose.model('Audit', auditSchema);

function requireAdmin(req, res, next) {
  const supplied = String(req.headers['x-admin-key'] || '');
  const expected = String(ADMIN_KEY);
  const valid = supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) return res.status(401).json({ ok: false, message: 'Admin não autorizado.' });
  next();
}

function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function escapeRegExp(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function validEmail(email) { return /^\S+@\S+\.\S+$/.test(normalizeEmail(email)); }
function boundedNumber(value, fallback, min = 1, max = 1000000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
function generateLicenseKey(email = '') {
  const hash = crypto.randomBytes(8).toString('hex').toUpperCase();
  const prefix = String(email).split('@')[0].replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase() || 'CLIENT';
  return `ZAP-${prefix}-${hash}`;
}
function generateOrderCode() { return `PED-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function planSettings(plan) {
  const normalized = String(plan || 'Mensal').toLowerCase();
  const days = normalized.includes('vital') ? null : normalized.includes('anual') ? 365 : normalized.includes('semestral') ? 180 : normalized.includes('trimestral') ? 90 : 30;
  const amount = normalized.includes('anual') ? 697 : normalized.includes('trimestral') ? 247 : 97;
  return { days, amount };
}
function addDaysFrom(baseDate, days) {
  if (days === null) return null;
  const base = baseDate && new Date(baseDate).getTime() > Date.now() ? new Date(baseDate) : new Date();
  base.setDate(base.getDate() + Number(days || 0));
  return base;
}
function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Data inválida.');
  return date;
}
function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}
function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
async function audit(req, action, entityType, entityId, summary, metadata = {}) {
  try {
    await Audit.create({ action, entityType, entityId: entityId ? String(entityId) : '', summary, metadata, ip: req.ip });
  } catch (error) { console.error('Falha ao registrar auditoria:', error.message); }
}
async function sendLicenseEmail({ name, email, downloadUrl }, license) {
  const transporter = getTransporter();
  if (!transporter) throw new Error('SMTP não configurado no servidor de licenças.');
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER;
  const url = downloadUrl || DOWNLOAD_URL;
  const validity = license.expiresAt ? new Date(license.expiresAt).toLocaleDateString('pt-BR') : 'Sem vencimento';
  const subject = 'Seu acesso ao ZapDisparo foi liberado';
  const text = [`Olá, ${name || 'cliente'}!`, '', 'Sua licença do ZapDisparo está ativa.', '', `Usuário: ${email}`, `Token de ativação: ${license.licenseKey}`, `Plano: ${license.plan}`, `Validade: ${validity}`, '', `Download: ${url}`].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#172033"><h1 style="color:#0ca678">ZapDisparo liberado</h1><p>Olá, <strong>${escapeHtml(name || 'cliente')}</strong>!</p><p>Sua licença está ativa.</p><div style="background:#f2f5f8;border-radius:12px;padding:20px;margin:20px 0"><p><strong>Usuário:</strong> ${escapeHtml(email)}</p><p><strong>Token:</strong><br><code style="font-size:18px">${escapeHtml(license.licenseKey)}</code></p><p><strong>Plano:</strong> ${escapeHtml(license.plan)}</p><p><strong>Validade:</strong> ${validity}</p></div><p><a href="${escapeHtml(url)}" style="display:inline-block;background:#0ca678;color:#fff;text-decoration:none;padding:14px 22px;border-radius:8px;font-weight:bold">Baixar ZapDisparo</a></p></div>`;
  await transporter.sendMail({ from, to: email, subject, text, html });
  license.lastEmailSentAt = new Date();
  await license.save();
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'zapdisparo-license-server' }));

app.post('/api/sales/orders', async (req, res) => {
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  if (!body.name || !validEmail(email)) return res.status(400).json({ ok: false, message: 'Informe nome e e-mail válidos.' });
  const settings = planSettings(body.plan);
  const purchase = await Purchase.create({ orderCode: generateOrderCode(), name: String(body.name).trim(), email, phone: String(body.phone || '').trim(), cpfCnpj: String(body.cpfCnpj || '').trim(), plan: body.plan || 'Mensal', amount: settings.amount, paymentMethod: body.paymentMethod || 'pix', paymentReference: String(body.paymentReference || '').trim(), downloadUrl: DOWNLOAD_URL });
  res.status(201).json({ ok: true, message: 'Pedido recebido. Após a confirmação do pagamento, o acesso será enviado por e-mail.', order: { orderCode: purchase.orderCode, status: purchase.status, plan: purchase.plan, amount: purchase.amount } });
});
app.get('/api/sales/orders/:orderCode', async (req, res) => {
  const purchase = await Purchase.findOne({ orderCode: req.params.orderCode }).lean();
  if (!purchase) return res.status(404).json({ ok: false, message: 'Pedido não encontrado.' });
  res.json({ ok: true, order: { orderCode: purchase.orderCode, status: purchase.status, plan: purchase.plan, createdAt: purchase.createdAt, emailSentAt: purchase.emailSentAt } });
});

app.post('/api/license/verify', async (req, res) => {
  const { email, licenseKey, deviceId } = req.body || {};
  if (!email || !licenseKey || !deviceId) return res.status(400).json({ active: false, reason: 'Informe e-mail, licença e deviceId.' });
  const license = await License.findOne({ email: normalizeEmail(email), licenseKey: String(licenseKey).trim() });
  if (!license) return res.status(404).json({ active: false, reason: 'Licença não encontrada.' });
  if (license.status !== 'active') return res.status(403).json({ active: false, reason: 'Licença bloqueada ou inativa.' });
  if (license.expiresAt && license.expiresAt.getTime() < Date.now()) return res.status(403).json({ active: false, reason: 'Assinatura vencida.' });
  const devices = license.devices || [];
  const existing = devices.find((item) => item.deviceId === deviceId);
  if (!existing && devices.length >= Number(license.allowedDevices || 1)) return res.status(403).json({ active: false, reason: 'Limite de máquinas atingido para esta licença.' });
  if (existing) existing.lastCheckAt = new Date(); else devices.push({ deviceId, activatedAt: new Date(), lastCheckAt: new Date() });
  license.devices = devices;
  await license.save();
  res.json({ ok: true, active: true, status: license.status, plan: license.plan, expiresAt: license.expiresAt, dailyLimit: license.dailyLimit, connectionLimit: license.connectionLimit, allowedDevices: license.allowedDevices, devicesUsed: license.devices.length });
});

app.get('/api/admin/check', requireAdmin, (req, res) => res.json({ ok: true }));
app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  const now = new Date();
  const inSevenDays = new Date(Date.now() + 7 * 86400000);
  const [pending, paid, activeLicenses, blockedLicenses, expiredLicenses, expiringSoon, totalOrders, totalLicenses, revenue] = await Promise.all([
    Purchase.countDocuments({ status: 'pending' }),
    Purchase.countDocuments({ status: 'paid' }),
    License.countDocuments({ status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }),
    License.countDocuments({ status: 'blocked' }),
    License.countDocuments({ expiresAt: { $lt: now } }),
    License.countDocuments({ status: 'active', expiresAt: { $gte: now, $lte: inSevenDays } }),
    Purchase.countDocuments(), License.countDocuments(),
    Purchase.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
  ]);
  res.json({ ok: true, metrics: { pending, paid, activeLicenses, blockedLicenses, expiredLicenses, expiringSoon, totalOrders, totalLicenses, revenue: revenue[0]?.total || 0 } });
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  if (req.query.search) {
    const regex = new RegExp(escapeRegExp(req.query.search), 'i');
    filter.$or = [{ orderCode: regex }, { name: regex }, { email: regex }, { phone: regex }, { paymentReference: regex }];
  }
  const orders = await Purchase.find(filter).sort({ createdAt: -1 }).limit(1000).lean();
  res.json({ ok: true, orders });
});
app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const allowed = ['notes', 'paymentReference', 'status'];
  const update = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowed.includes(key)));
  const order = await Purchase.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!order) return res.status(404).json({ ok: false, message: 'Pedido não encontrado.' });
  await audit(req, 'order.updated', 'Purchase', order._id, `Pedido ${order.orderCode} atualizado`, update);
  res.json({ ok: true, order, message: 'Pedido atualizado.' });
});
app.post('/api/admin/orders/:id/confirm-payment', requireAdmin, async (req, res) => {
  const purchase = await Purchase.findById(req.params.id);
  if (!purchase) return res.status(404).json({ ok: false, message: 'Pedido não encontrado.' });
  if (purchase.status === 'cancelled') return res.status(409).json({ ok: false, message: 'Pedido cancelado não pode ser confirmado.' });
  let license = purchase.licenseId ? await License.findById(purchase.licenseId) : null;
  if (!license) {
    const settings = planSettings(purchase.plan);
    license = await License.create({ name: purchase.name, email: purchase.email, licenseKey: generateLicenseKey(purchase.email), status: 'active', plan: purchase.plan, expiresAt: addDaysFrom(null, settings.days), dailyLimit: boundedNumber(req.body?.dailyLimit, 300), connectionLimit: boundedNumber(req.body?.connectionLimit, 1), allowedDevices: boundedNumber(req.body?.allowedDevices, 1), notes: `Gerada pelo pedido ${purchase.orderCode}` });
  }
  purchase.status = 'paid'; purchase.paidAt = purchase.paidAt || new Date(); purchase.licenseId = license._id; purchase.licenseKey = license.licenseKey; purchase.downloadUrl = purchase.downloadUrl || DOWNLOAD_URL; purchase.emailError = '';
  await purchase.save();
  await audit(req, 'order.payment_confirmed', 'Purchase', purchase._id, `Pagamento confirmado: ${purchase.orderCode}`, { licenseId: license._id });
  try {
    await sendLicenseEmail(purchase, license); purchase.emailSentAt = new Date(); await purchase.save();
    res.json({ ok: true, message: 'Pagamento confirmado, licença gerada e e-mail enviado.', order: purchase, license });
  } catch (error) {
    purchase.emailError = error.message; await purchase.save();
    res.status(202).json({ ok: true, emailSent: false, message: `Licença liberada, mas o e-mail não foi enviado: ${error.message}`, order: purchase, license });
  }
});
app.post('/api/admin/orders/:id/resend-email', requireAdmin, async (req, res) => {
  const purchase = await Purchase.findById(req.params.id);
  if (!purchase || !purchase.licenseId) return res.status(404).json({ ok: false, message: 'Pedido pago/licença não encontrados.' });
  const license = await License.findById(purchase.licenseId);
  if (!license) return res.status(404).json({ ok: false, message: 'Licença vinculada não encontrada.' });
  await sendLicenseEmail(purchase, license); purchase.emailSentAt = new Date(); purchase.emailError = ''; await purchase.save();
  await audit(req, 'order.email_resent', 'Purchase', purchase._id, `E-mail reenviado: ${purchase.orderCode}`);
  res.json({ ok: true, message: 'E-mail reenviado.' });
});

app.get('/api/admin/licenses', requireAdmin, async (req, res) => {
  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  if (req.query.plan && req.query.plan !== 'all') filter.plan = req.query.plan;
  if (req.query.expiry === 'expired') filter.expiresAt = { $lt: new Date() };
  if (req.query.expiry === 'soon') filter.expiresAt = { $gte: new Date(), $lte: new Date(Date.now() + 7 * 86400000) };
  if (req.query.search) {
    const regex = new RegExp(escapeRegExp(req.query.search), 'i');
    filter.$or = [{ name: regex }, { email: regex }, { licenseKey: regex }, { notes: regex }];
  }
  const licenses = await License.find(filter).sort({ createdAt: -1 }).limit(2000).lean();
  res.json({ ok: true, licenses });
});
app.get('/api/admin/licenses/:id', requireAdmin, async (req, res) => {
  const license = await License.findById(req.params.id).lean();
  if (!license) return res.status(404).json({ ok: false, message: 'Licença não encontrada.' });
  res.json({ ok: true, license });
});
app.post('/api/admin/licenses', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  if (!body.name || !validEmail(email)) return res.status(400).json({ ok: false, message: 'Nome e e-mail válidos são obrigatórios.' });
  const settings = planSettings(body.plan);
  const expiresAt = body.lifetime ? null : body.expiresAt ? parseDate(body.expiresAt) : addDaysFrom(null, boundedNumber(body.days, settings.days || 30));
  const license = await License.create({ name: String(body.name).trim(), email, licenseKey: String(body.licenseKey || generateLicenseKey(email)).trim().toUpperCase(), status: body.status || 'active', plan: body.plan || 'Mensal', expiresAt, dailyLimit: boundedNumber(body.dailyLimit, 300), connectionLimit: boundedNumber(body.connectionLimit, 1), allowedDevices: boundedNumber(body.allowedDevices, 1), notes: String(body.notes || '').trim() });
  await audit(req, 'license.created', 'License', license._id, `Licença criada para ${license.email}`, { plan: license.plan });
  let emailMessage = '';
  if (body.sendEmail) {
    try { await sendLicenseEmail({ name: license.name, email: license.email, downloadUrl: DOWNLOAD_URL }, license); emailMessage = ' E-mail enviado.'; }
    catch (error) { emailMessage = ` E-mail não enviado: ${error.message}`; }
  }
  res.status(201).json({ ok: true, license, message: `Licença criada.${emailMessage}` });
});
app.patch('/api/admin/licenses/:id', requireAdmin, async (req, res) => {
  const allowed = ['name', 'email', 'status', 'plan', 'expiresAt', 'dailyLimit', 'connectionLimit', 'allowedDevices', 'notes'];
  const update = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowed.includes(key)));
  if ('email' in update) { update.email = normalizeEmail(update.email); if (!validEmail(update.email)) return res.status(400).json({ ok: false, message: 'E-mail inválido.' }); }
  if ('expiresAt' in update) update.expiresAt = update.expiresAt ? parseDate(update.expiresAt) : null;
  ['dailyLimit', 'connectionLimit', 'allowedDevices'].forEach((key) => { if (key in update) update[key] = boundedNumber(update[key], 1); });
  const license = await License.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!license) return res.status(404).json({ ok: false, message: 'Licença não encontrada.' });
  await audit(req, 'license.updated', 'License', license._id, `Licença atualizada: ${license.email}`, update);
  res.json({ ok: true, license, message: 'Licença atualizada.' });
});
app.post('/api/admin/licenses/:id/renew', requireAdmin, async (req, res) => {
  const license = await License.findById(req.params.id);
  if (!license) return res.status(404).json({ ok: false, message: 'Licença não encontrada.' });
  const days = boundedNumber(req.body?.days, 30, 1, 3650);
  license.expiresAt = addDaysFrom(license.expiresAt, days);
  license.status = 'active';
  await license.save();
  await audit(req, 'license.renewed', 'License', license._id, `Licença renovada por ${days} dias`, { days, expiresAt: license.expiresAt });
  res.json({ ok: true, license, message: `Licença renovada por ${days} dias.` });
});
app.post('/api/admin/licenses/:id/regenerate-key', requireAdmin, async (req, res) => {
  const license = await License.findById(req.params.id);
  if (!license) return res.status(404).json({ ok: false, message: 'Licença não encontrada.' });
  license.licenseKey = generateLicenseKey(license.email); license.devices = []; await license.save();
  await audit(req, 'license.key_regenerated', 'License', license._id, `Token regenerado: ${license.email}`);
  res.json({ ok: true, license, message: 'Novo token gerado e máquinas desvinculadas.' });
});
app.post('/api/admin/licenses/:id/reset-devices', requireAdmin, async (req, res) => {
  const license = await License.findByIdAndUpdate(req.params.id, { devices: [] }, { new: true });
  if (!license) return res.status(404).json({ ok: false, message: 'Licença não encontrada.' });
  await audit(req, 'license.devices_reset', 'License', license._id, `Máquinas desvinculadas: ${license.email}`);
  res.json({ ok: true, license, message: 'Dispositivos desvinculados.' });
});
app.post('/api/admin/licenses/:id/send-email', requireAdmin, async (req, res) => {
  const license = await License.findById(req.params.id);
  if (!license) return res.status(404).json({ ok: false, message: 'Licença não encontrada.' });
  await sendLicenseEmail({ name: license.name, email: license.email, downloadUrl: DOWNLOAD_URL }, license);
  await audit(req, 'license.email_sent', 'License', license._id, `E-mail enviado: ${license.email}`);
  res.json({ ok: true, message: 'E-mail da licença enviado.' });
});
app.delete('/api/admin/licenses/:id', requireAdmin, async (req, res) => {
  const license = await License.findById(req.params.id);
  if (!license) return res.status(404).json({ ok: false, message: 'Licença não encontrada.' });
  await License.findByIdAndDelete(req.params.id);
  await audit(req, 'license.deleted', 'License', req.params.id, `Licença excluída: ${license.email}`);
  res.json({ ok: true, deleted: true, message: 'Licença excluída.' });
});
app.get('/api/admin/audit', requireAdmin, async (req, res) => {
  const entries = await Audit.find().sort({ createdAt: -1 }).limit(200).lean();
  res.json({ ok: true, entries });
});

app.use((error, req, res, next) => {
  console.error(error);
  const message = error.code === 11000 ? 'Já existe um registro com esse e-mail/token.' : (error.message || 'Erro interno.');
  res.status(error.status || 500).json({ ok: false, message });
});

async function start() {
  if (!MONGODB_URI) throw new Error('Configure MONGODB_URI no .env');
  await mongoose.connect(MONGODB_URI);
  app.listen(PORT, () => console.log(`License server running on port ${PORT}`));
}
start().catch((error) => { console.error(error); process.exit(1); });
