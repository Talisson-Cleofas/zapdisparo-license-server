require('dotenv').config();

// Horário oficial dos jobs de licença. Pode ser alterado por variável de ambiente.
process.env.TZ = process.env.LICENSE_REMINDER_TIMEZONE || 'America/Sao_Paulo';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const DOWNLOAD_URL = process.env.DOWNLOAD_URL || 'https://seusite.com/download/ZapDisparo-Setup.exe';
const DEMO_DOWNLOAD_URL = process.env.DEMO_DOWNLOAD_URL || DOWNLOAD_URL;
const CUSTOMER_PANEL_URL = process.env.CUSTOMER_PANEL_URL || process.env.MERCADO_PAGO_SUBSCRIPTION_BACK_URL || 'https://seusite.com/painel';
const EMAIL_LOGO_URL = process.env.EMAIL_LOGO_URL || '';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || process.env.SMTP_USER || '';
const SALES_ORIGIN = process.env.SALES_ORIGIN || '*';
const MERCADO_PAGO_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN || '';
const MERCADO_PAGO_WEBHOOK_SECRET = process.env.MERCADO_PAGO_WEBHOOK_SECRET || '';
const MERCADO_PAGO_WEBHOOK_URL = process.env.MERCADO_PAGO_WEBHOOK_URL || 'https://zapdisparo-license-server.onrender.com/api/payments/mercadopago/webhook';
const MERCADO_PAGO_SUBSCRIPTION_BACK_URL = process.env.MERCADO_PAGO_SUBSCRIPTION_BACK_URL || 'https://seusite.com/sales.html';
const LICENSE_REMINDER_HOUR = Math.min(23, Math.max(0, Number(process.env.LICENSE_REMINDER_HOUR || 8)));
const LICENSE_REMINDER_MINUTE = Math.min(59, Math.max(0, Number(process.env.LICENSE_REMINDER_MINUTE || 0)));
const LICENSE_SIGNING_SECRET = process.env.LICENSE_SIGNING_SECRET || '';
const LICENSE_PRIVATE_KEY_B64 = process.env.LICENSE_PRIVATE_KEY_B64 || '';
const PUBLIC_RATE_LIMIT_WINDOW_MS = Math.max(1000, Number(process.env.PUBLIC_RATE_LIMIT_WINDOW_MS || 60000));
const PUBLIC_RATE_LIMIT_MAX = Math.max(1, Number(process.env.PUBLIC_RATE_LIMIT_MAX || 60));
const BACKUP_ENABLED = String(process.env.BACKUP_ENABLED || 'true').toLowerCase() === 'true';
const BACKUP_HOUR = Math.min(23, Math.max(0, Number(process.env.BACKUP_HOUR || 2)));
const BACKUP_MINUTE = Math.min(59, Math.max(0, Number(process.env.BACKUP_MINUTE || 0)));
const BACKUP_RETENTION_DAYS = Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS || 7));
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: SALES_ORIGIN === '*' ? true : SALES_ORIGIN.split(',').map((item) => item.trim()) }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'sales.html')));

const deviceSchema = new mongoose.Schema({
  deviceId: String,
  activatedAt: Date,
  lastCheckAt: Date
}, { _id: false });

const licenseSchema = new mongoose.Schema({
  // Identificador comercial estável, separado do _id interno do MongoDB.
  id: { type: String, required: true, unique: true, index: true, default: () => crypto.randomUUID() },
  email: { type: String, required: true, index: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true },
  // Planos novos são normalizados nas rotas de escrita. O schema permanece
  // compatível com rótulos legados já persistidos (por exemplo, "Full Admin").
  plan: { type: String, required: true, trim: true, default: 'Mensal', index: true },
  licenseType: { type: String, enum: ['demo', 'paid'], default: 'paid', index: true },
  // token é o nome oficial na coleção; licenseKey permanece por compatibilidade com o aplicativo atual.
  token: { type: String, required: true, unique: true, index: true, trim: true, uppercase: true },
  licenseKey: { type: String, required: true, unique: true, index: true, trim: true, uppercase: true },
  status: { type: String, enum: ['active', 'blocked', 'cancelled', 'expired'], default: 'active', index: true },
  expiresAt: { type: Date, default: null, index: true },
  renewCount: { type: Number, default: 0, min: 0, index: true },
  dailyLimit: { type: Number, default: 300, min: 1 },
  connectionLimit: { type: Number, default: 1, min: 1 },
  allowedDevices: { type: Number, default: 1, min: 1 },
  devices: [deviceSchema],
  notes: String,
  lastEmailSentAt: Date,
  tokenSignature: { type: String, index: true },
  signatureVersion: { type: Number, default: 1 }
}, { timestamps: true, id: false });

// Mantém token e licenseKey sincronizados durante a migração e nas gravações futuras.
licenseSchema.pre('validate', function syncLicenseToken() {
  const currentToken = String(this.token || this.licenseKey || '').trim().toUpperCase();
  this.token = currentToken;
  this.licenseKey = currentToken;
});
licenseSchema.index({ email: 1, createdAt: 1 });
licenseSchema.index({ status: 1, expiresAt: 1 });
licenseSchema.index({ plan: 1, status: 1 });

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
  mercadoPagoPaymentId: { type: String, index: true },
  mercadoPagoStatus: String,
  mercadoPagoStatusDetail: String,
  mercadoPagoQrCode: String,
  mercadoPagoQrCodeBase64: String,
  mercadoPagoTicketUrl: String,
  mercadoPagoExpiresAt: Date,
  mercadoPagoSubscriptionId: { type: String, index: true },
  mercadoPagoSubscriptionStatus: String,
  checkoutUrl: String,
  paymentApprovedAt: Date,
  paymentLastCheckedAt: Date,
  status: { type: String, enum: ['pending', 'paid', 'cancelled'], default: 'pending', index: true },
  licenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'License' },
  licenseKey: String,
  downloadUrl: String,
  paidAt: Date,
  emailSentAt: Date,
  emailError: String,
  notes: String,
  accessTokenHash: { type: String, select: false }
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

const demoTrialSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true, index: true },
  licenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'License', required: true },
  startedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  convertedAt: Date,
  convertedLicenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'License' },
  status: { type: String, enum: ['active', 'expired', 'converted'], default: 'active', index: true }
}, { timestamps: true });
const DemoTrial = mongoose.model('DemoTrial', demoTrialSchema);

const downloadEventSchema = new mongoose.Schema({
  downloadId: { type: String, required: true, unique: true, index: true },
  source: { type: String, default: 'sales-page', index: true },
  pageUrl: String,
  referrer: String,
  userAgent: String,
  ipHash: String,
  requestedAt: { type: Date, default: Date.now, index: true },
  downloadedAt: Date,
  status: { type: String, enum: ['registered', 'redirected', 'failed'], default: 'registered', index: true },
  error: String
}, { timestamps: true });
const DownloadEvent = mongoose.model('DownloadEvent', downloadEventSchema);

const Purchase = mongoose.model('Purchase', purchaseSchema);
const paymentEventSchema = new mongoose.Schema({
  provider: { type: String, default: 'mercado-pago', index: true },
  providerPaymentId: { type: String, required: true, unique: true, index: true },
  orderCode: { type: String, index: true },
  subscriptionId: { type: String, index: true },
  email: { type: String, index: true, lowercase: true, trim: true },
  amount: Number,
  status: String,
  processedAt: Date,
  licenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'License' },
  action: { type: String, enum: ['created', 'renewed', 'ignored'], default: 'ignored' },
  error: String
}, { timestamps: true });
const Audit = mongoose.model('Audit', auditSchema);
const PaymentEvent = mongoose.model('PaymentEvent', paymentEventSchema);

const licenseHistorySchema = new mongoose.Schema({
  licenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'License', required: true, index: true },
  purchaseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', index: true },
  orderCode: { type: String, index: true },
  providerPaymentId: { type: String, index: true },
  email: { type: String, index: true, lowercase: true, trim: true },
  action: { type: String, enum: ['created', 'renewed'], required: true, index: true },
  plan: String,
  amount: Number,
  addedDays: Number,
  previousExpiresAt: Date,
  newExpiresAt: Date,
  source: String,
  emailStatus: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
  emailError: String
}, { timestamps: true });
const LicenseHistory = mongoose.model('LicenseHistory', licenseHistorySchema);

// Registro idempotente dos lembretes e das desativações por vencimento.
const expirationEventSchema = new mongoose.Schema({
  licenseId: { type: mongoose.Schema.Types.ObjectId, ref: 'License', required: true, index: true },
  licenseCommercialId: { type: String, index: true },
  email: { type: String, index: true, lowercase: true, trim: true },
  type: { type: String, enum: ['reminder_7', 'reminder_3', 'reminder_0', 'expired'], required: true, index: true },
  expirationKey: { type: String, required: true, index: true },
  scheduledFor: Date,
  processedAt: Date,
  status: { type: String, enum: ['processing', 'sent', 'completed', 'failed'], default: 'processing', index: true },
  error: String
}, { timestamps: true });
expirationEventSchema.index({ licenseId: 1, type: 1, expirationKey: 1 }, { unique: true });
const ExpirationEvent = mongoose.model('ExpirationEvent', expirationEventSchema);

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

function assertSecurityConfiguration() {
  if (!LICENSE_SIGNING_SECRET || LICENSE_SIGNING_SECRET.length < 32) {
    throw new Error('Configure LICENSE_SIGNING_SECRET com pelo menos 32 caracteres.');
  }
  if (!LICENSE_PRIVATE_KEY_B64) throw new Error('Configure LICENSE_PRIVATE_KEY_B64 para assinar as licenças com Ed25519.');
  try { licensePrivateKey(); } catch (error) { throw new Error(`LICENSE_PRIVATE_KEY_B64 inválida: ${error.message}`); }
  if (!MERCADO_PAGO_WEBHOOK_SECRET) throw new Error('Configure MERCADO_PAGO_WEBHOOK_SECRET antes de iniciar em produção.');
  if (ADMIN_KEY.length < 24) throw new Error('Configure uma ADMIN_KEY forte com pelo menos 24 caracteres.');
  if (SALES_ORIGIN === '*') throw new Error('Configure SALES_ORIGIN com os domínios autorizados; o curinga * não é aceito em produção.');
}

function signLicense(license) {
  const payload = [license.id, normalizeEmail(license.email), String(license.token || license.licenseKey), license.plan, license.status, license.expiresAt ? new Date(license.expiresAt).toISOString() : ''].join('|');
  return crypto.createHmac('sha256', LICENSE_SIGNING_SECRET).update(payload).digest('base64url');
}

function licensePrivateKey() {
  return crypto.createPrivateKey({ key: Buffer.from(LICENSE_PRIVATE_KEY_B64, 'base64'), format: 'der', type: 'pkcs8' });
}

function publicLicenseProof(license) {
  const payloadObject = {
    id: license.id,
    email: normalizeEmail(license.email),
    token: license.token,
    plan: license.plan,
    status: license.status,
    expiresAt: license.expiresAt ? new Date(license.expiresAt).toISOString() : '',
    dailyLimit: Number(license.dailyLimit || 0),
    connectionLimit: Number(license.connectionLimit || 0),
    allowedDevices: Number(license.allowedDevices || 1),
    licenseType: license.licenseType || 'paid',
    v: 2
  };
  const payloadBuffer = Buffer.from(JSON.stringify(payloadObject));
  const signature = crypto.sign(null, payloadBuffer, licensePrivateKey());
  return `${payloadBuffer.toString('base64url')}.${signature.toString('base64url')}`;
}

const rateBuckets = new Map();
function publicRateLimit(req, res, next) {
  const key = `${req.ip || req.socket?.remoteAddress || 'unknown'}:${req.path}`;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) bucket = { count: 0, resetAt: now + PUBLIC_RATE_LIMIT_WINDOW_MS };
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  res.setHeader('X-RateLimit-Limit', String(PUBLIC_RATE_LIMIT_MAX));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, PUBLIC_RATE_LIMIT_MAX - bucket.count)));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
  if (bucket.count > PUBLIC_RATE_LIMIT_MAX) return res.status(429).json({ ok: false, active: false, reason: 'Muitas tentativas. Aguarde e tente novamente.' });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateBuckets.entries()) if (now >= value.resetAt) rateBuckets.delete(key);
}, PUBLIC_RATE_LIMIT_WINDOW_MS).unref?.();

function planSettings(plan) {
  const normalized = String(plan || 'Mensal').trim().toLowerCase();
  if (normalized.includes('anual')) {
    return { name: 'Anual', days: 365, amount: 1199.99, recurringMonths: 12 };
  }
  if (normalized.includes('semestral')) {
    return { name: 'Semestral', days: 180, amount: 599.99, recurringMonths: 6 };
  }
  return { name: 'Mensal', days: 30, amount: 99.99, recurringMonths: 1 };
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
function formatDatePtBr(value) {
  return value ? new Date(value).toLocaleDateString('pt-BR') : 'Sem vencimento';
}

function emailShell({ preheader, title, subtitle, content, primaryButton, secondaryButton, footerNote }) {
  const logo = EMAIL_LOGO_URL
    ? `<img src="${escapeHtml(EMAIL_LOGO_URL)}" width="190" alt="ZapDisparo" style="display:block;max-width:190px;height:auto;margin:0 auto 18px" />`
    : `<div style="font-size:30px;line-height:1;font-weight:900;letter-spacing:-1px;color:#ffffff;text-align:center;margin-bottom:18px">Zap<span style="color:#25d366">Disparo</span></div>`;
  const button = (item, secondary = false) => !item?.url ? '' : `<a href="${escapeHtml(item.url)}" style="display:inline-block;margin:6px 4px;padding:14px 22px;border-radius:10px;text-decoration:none;font-weight:800;font-size:15px;${secondary ? 'background:#ffffff;color:#172033;border:1px solid #d9e2ec' : 'background:#25d366;color:#062b18;border:1px solid #25d366'}">${escapeHtml(item.label)}</a>`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;padding:0;background:#eef2f6;font-family:Arial,Helvetica,sans-serif;color:#172033"><span style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader || subtitle || title)}</span><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef2f6;padding:24px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:660px;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 12px 35px rgba(23,32,51,.10)"><tr><td style="background:#101820;padding:34px 28px;text-align:center">${logo}<h1 style="margin:0;color:#ffffff;font-size:28px;line-height:1.25">${escapeHtml(title)}</h1><p style="margin:10px 0 0;color:#c8d3dc;font-size:16px;line-height:1.6">${escapeHtml(subtitle || '')}</p></td></tr><tr><td style="padding:32px 28px">${content}<div style="text-align:center;margin-top:26px">${button(primaryButton)}${button(secondaryButton, true)}</div></td></tr><tr><td style="background:#f7f9fb;padding:22px 28px;text-align:center;color:#697887;font-size:12px;line-height:1.6"><p style="margin:0 0 6px">${escapeHtml(footerNote || 'Este é um e-mail automático do ZapDisparo.')}</p>${SUPPORT_EMAIL ? `<p style="margin:0">Suporte: ${escapeHtml(SUPPORT_EMAIL)}</p>` : ''}</td></tr></table></td></tr></table></body></html>`;
}

function licenseDetailsHtml(license, extraRows = '') {
  return `<div style="background:#f4f7f9;border:1px solid #e1e8ee;border-radius:14px;padding:20px;margin:22px 0"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:6px 0;color:#697887">Plano</td><td align="right" style="padding:6px 0;font-weight:800">${escapeHtml(license.plan)}</td></tr><tr><td style="padding:6px 0;color:#697887">Token</td><td align="right" style="padding:6px 0;font-weight:800;font-family:Consolas,monospace;word-break:break-all">${escapeHtml(license.token || license.licenseKey)}</td></tr><tr><td style="padding:6px 0;color:#697887">Validade</td><td align="right" style="padding:6px 0;font-weight:800">${formatDatePtBr(license.expiresAt)}</td></tr>${extraRows}</table></div>`;
}

async function deliverEmail({ to, subject, text, html, license }) {
  const transporter = getTransporter();
  if (!transporter) throw new Error('SMTP não configurado no servidor de licenças.');
  const from = process.env.EMAIL_FROM || process.env.SMTP_USER;
  await transporter.sendMail({ from, to, subject, text, html });
  if (license) {
    license.lastEmailSentAt = new Date();
    await license.save();
  }
}

async function sendLicenseEmail({ name, email, downloadUrl }, license) {
  const url = downloadUrl || DOWNLOAD_URL;
  const validity = formatDatePtBr(license.expiresAt);
  const subject = 'Obrigado pela compra! Sua licença ZapDisparo está pronta';
  const text = [`Olá, ${name || 'cliente'}!`, '', 'Obrigado pela compra!', 'Sua licença do ZapDisparo está ativa.', '', `Plano: ${license.plan}`, `Token: ${license.token || license.licenseKey}`, `Validade: ${validity}`, '', `Baixar ZapDisparo: ${url}`, `Painel do Cliente: ${CUSTOMER_PANEL_URL}`].join('\n');
  const content = `<p style="margin:0 0 14px;font-size:17px;line-height:1.7">Olá, <strong>${escapeHtml(name || 'cliente')}</strong>!</p><p style="margin:0;font-size:16px;line-height:1.7">Seu pagamento foi confirmado. Abaixo estão as informações necessárias para ativar o ZapDisparo.</p>${licenseDetailsHtml(license)}<div style="background:#ecfff4;border-left:4px solid #25d366;border-radius:10px;padding:14px 16px;color:#155b35;line-height:1.6"><strong>Guarde seu token.</strong> Ele será solicitado na ativação do aplicativo.</div>`;
  const html = emailShell({ preheader: 'Seu pagamento foi confirmado e sua licença está pronta.', title: 'Obrigado pela compra!', subtitle: 'Sua licença ZapDisparo foi criada com sucesso.', content, primaryButton: { label: 'Baixar ZapDisparo', url }, secondaryButton: { label: 'Painel do Cliente', url: CUSTOMER_PANEL_URL }, footerNote: 'Você recebeu este e-mail porque adquiriu uma licença do ZapDisparo.' });
  await deliverEmail({ to: email, subject, text, html, license });
}

async function sendRenewalEmail({ name, email, downloadUrl }, license, addedDays) {
  const url = downloadUrl || DOWNLOAD_URL;
  const validity = formatDatePtBr(license.expiresAt);
  const subject = 'Sua licença ZapDisparo foi renovada';
  const text = [`Olá, ${name || 'cliente'}!`, '', 'Sua licença foi renovada.', `Período acrescentado: ${addedDays} dias`, `Plano: ${license.plan}`, `Token: ${license.token || license.licenseKey}`, `Nova validade: ${validity}`, '', `Baixar ZapDisparo: ${url}`, `Painel do Cliente: ${CUSTOMER_PANEL_URL}`].join('\n');
  const extra = `<tr><td style="padding:6px 0;color:#697887">Período acrescentado</td><td align="right" style="padding:6px 0;font-weight:800">${Number(addedDays)} dias</td></tr>`;
  const content = `<p style="margin:0 0 14px;font-size:17px;line-height:1.7">Olá, <strong>${escapeHtml(name || 'cliente')}</strong>!</p><p style="margin:0;font-size:16px;line-height:1.7">Seu pagamento foi confirmado e a renovação foi aplicada automaticamente.</p>${licenseDetailsHtml(license, extra)}<div style="background:#ecfff4;border-left:4px solid #25d366;border-radius:10px;padding:14px 16px;color:#155b35;line-height:1.6"><strong>Nova validade:</strong> ${validity}</div>`;
  const html = emailShell({ preheader: `Sua licença foi renovada até ${validity}.`, title: 'Sua licença foi renovada.', subtitle: `Nova validade: ${validity}`, content, primaryButton: { label: 'Abrir Painel do Cliente', url: CUSTOMER_PANEL_URL }, secondaryButton: { label: 'Baixar ZapDisparo', url }, footerNote: 'Renovação processada automaticamente após a confirmação do pagamento.' });
  await deliverEmail({ to: email, subject, text, html, license });
}

async function sendExpirationReminderEmail({ name, email }, license, daysRemaining) {
  const days = Math.max(0, Number(daysRemaining || 0));
  const validity = formatDatePtBr(license.expiresAt);
  const dayLabel = days === 1 ? 'dia' : 'dias';
  const subject = days === 0 ? 'Sua licença ZapDisparo vence hoje' : `Faltam ${days} dias para sua licença ZapDisparo vencer`;
  const headline = days === 0 ? 'Sua licença vence hoje.' : `Faltam ${days} ${dayLabel}`;
  const text = [`Olá, ${name || 'cliente'}!`, '', headline, 'para sua licença ZapDisparo vencer.', '', `Plano: ${license.plan}`, `Token: ${license.token || license.licenseKey}`, `Validade: ${validity}`, '', `Renovar licença: ${CUSTOMER_PANEL_URL}`].join('\n');
  const content = `<p style="margin:0 0 14px;font-size:17px;line-height:1.7">Olá, <strong>${escapeHtml(name || 'cliente')}</strong>!</p><div style="text-align:center;background:#fff7e6;border:1px solid #ffe0a3;border-radius:14px;padding:24px;margin:18px 0"><div style="font-size:42px;font-weight:900;color:#b96b00">${days}</div><div style="font-size:18px;font-weight:800;color:#7a4a00">${dayLabel} para sua licença vencer</div></div>${licenseDetailsHtml(license)}<p style="margin:0;font-size:16px;line-height:1.7">Renove antes do vencimento para continuar utilizando o ZapDisparo sem interrupções.</p>`;
  const html = emailShell({ preheader: `${headline} para sua licença vencer.`, title: headline, subtitle: 'Renove agora e evite a interrupção do acesso.', content, primaryButton: { label: 'Renovar minha licença', url: CUSTOMER_PANEL_URL }, secondaryButton: { label: 'Baixar ZapDisparo', url: DOWNLOAD_URL }, footerNote: 'Aviso automático de vencimento da sua licença ZapDisparo.' });
  await deliverEmail({ to: email, subject, text, html, license });
}


function localDayStart(value = new Date()) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function expirationKey(value) {
  const date = new Date(value);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function calendarDaysRemaining(expiresAt, reference = new Date()) {
  const expiryDay = localDayStart(expiresAt);
  const today = localDayStart(reference);
  return Math.round((expiryDay.getTime() - today.getTime()) / 86400000);
}

async function claimExpirationEvent(license, type) {
  const key = expirationKey(license.expiresAt);
  try {
    return await ExpirationEvent.create({
      licenseId: license._id,
      licenseCommercialId: license.id,
      email: license.email,
      type,
      expirationKey: key,
      scheduledFor: new Date(),
      status: 'processing'
    });
  } catch (error) {
    if (error && error.code === 11000) {
      const existing = await ExpirationEvent.findOne({ licenseId: license._id, type, expirationKey: key });
      // Eventos concluídos não podem ser repetidos. Falhas podem ser reenviadas manualmente no mesmo dia.
      if (existing && ['sent', 'completed', 'processing'].includes(existing.status)) return null;
      if (existing) {
        existing.status = 'processing';
        existing.error = '';
        existing.scheduledFor = new Date();
        await existing.save();
        return existing;
      }
    }
    throw error;
  }
}

async function runLicenseReminderJob(source = 'scheduler') {
  const now = new Date();
  const result = { startedAt: now, source, remindersSent: 0, remindersFailed: 0, expired: 0, skipped: 0 };

  // Primeiro desativa tudo que já venceu. Licenças sem validade não entram nesse fluxo.
  const expiredLicenses = await License.find({ status: 'active', expiresAt: { $ne: null, $lt: now } });
  for (const license of expiredLicenses) {
    const event = await claimExpirationEvent(license, 'expired');
    if (!event) { result.skipped += 1; continue; }
    try {
      license.status = 'expired';
      await license.save();
      event.status = 'completed';
      event.processedAt = new Date();
      await event.save();
      await Audit.create({
        action: 'license.expired_automatically', entityType: 'License', entityId: String(license._id),
        summary: `Licença desativada automaticamente por vencimento: ${license.email}`,
        metadata: { source, expiresAt: license.expiresAt, plan: license.plan }
      });
      result.expired += 1;
    } catch (error) {
      event.status = 'failed'; event.error = error.message; event.processedAt = new Date(); await event.save();
      console.error(`Falha ao desativar licença ${license.email}:`, error.message);
    }
  }

  // Busca somente licenças ativas que ainda não venceram e possuem e-mail válido.
  const reminderCandidates = await License.find({ status: 'active', expiresAt: { $ne: null, $gte: now } });
  for (const license of reminderCandidates) {
    const days = calendarDaysRemaining(license.expiresAt, now);
    if (![7, 3, 0].includes(days) || !validEmail(license.email)) continue;
    const type = `reminder_${days}`;
    const event = await claimExpirationEvent(license, type);
    if (!event) { result.skipped += 1; continue; }
    try {
      await sendExpirationReminderEmail({ name: license.name, email: license.email }, license, days);
      event.status = 'sent'; event.processedAt = new Date(); await event.save();
      await Audit.create({
        action: 'license.expiration_email_sent', entityType: 'License', entityId: String(license._id),
        summary: `Lembrete automático de ${days} dia(s) enviado: ${license.email}`,
        metadata: { source, daysRemaining: days, expiresAt: license.expiresAt, plan: license.plan }
      });
      result.remindersSent += 1;
    } catch (error) {
      event.status = 'failed'; event.error = error.message; event.processedAt = new Date(); await event.save();
      result.remindersFailed += 1;
      console.error(`Falha ao enviar lembrete para ${license.email}:`, error.message);
    }
  }

  result.finishedAt = new Date();
  console.log('Job de vencimentos concluído:', result);
  return result;
}

function millisecondsUntilNextReminderRun() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(LICENSE_REMINDER_HOUR, LICENSE_REMINDER_MINUTE, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return Math.max(1000, next.getTime() - now.getTime());
}

function scheduleLicenseReminderJob() {
  const delay = millisecondsUntilNextReminderRun();
  const nextRun = new Date(Date.now() + delay);
  console.log(`Próximo job de vencimentos: ${nextRun.toLocaleString('pt-BR')} (${process.env.TZ})`);
  const timer = setTimeout(async () => {
    try { await runLicenseReminderJob('scheduler'); }
    catch (error) { console.error('Erro no job diário de vencimentos:', error); }
    scheduleLicenseReminderJob();
    scheduleDatabaseBackup();
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
}

function validateMercadoPagoSignature(req, dataId) {
  if (!MERCADO_PAGO_WEBHOOK_SECRET) return true;
  const signature = String(req.headers['x-signature'] || '');
  const requestId = String(req.headers['x-request-id'] || '');
  const parts = Object.fromEntries(signature.split(',').map((item) => item.trim().split('=')));
  if (!parts.ts || !parts.v1 || !requestId || !dataId) return false;
  const timestampSeconds = Number(parts.ts);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() - timestampSeconds * 1000) > 5 * 60 * 1000) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', MERCADO_PAGO_WEBHOOK_SECRET).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(parts.v1), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createOrderAccessToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashOrderAccessToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function hasValidOrderAccess(purchase, req) {
  const supplied = String(req.headers['x-order-token'] || req.query.orderToken || req.body?.orderToken || '');
  const expected = String(purchase?.accessTokenHash || '');
  if (!supplied || !expected) return false;
  const actualHash = hashOrderAccessToken(supplied);
  return actualHash.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(expected));
}

function requireOrderAccess(purchase, req, res) {
  if (hasValidOrderAccess(purchase, req)) return true;
  res.status(401).json({ ok: false, message: 'Token de acompanhamento do pedido inválido ou ausente.' });
  return false;
}

function publicOrder(purchase) {
  return {
    orderCode: purchase.orderCode,
    status: purchase.status,
    plan: purchase.plan,
    amount: purchase.amount,
    paymentMethod: purchase.paymentMethod,
    paymentStatus: purchase.mercadoPagoStatus || purchase.status,
    paymentStatusDetail: purchase.mercadoPagoStatusDetail || '',
    qrCode: purchase.status === 'pending' ? purchase.mercadoPagoQrCode : undefined,
    qrCodeBase64: purchase.status === 'pending' ? purchase.mercadoPagoQrCodeBase64 : undefined,
    ticketUrl: purchase.status === 'pending' ? purchase.mercadoPagoTicketUrl : undefined,
    paymentExpiresAt: purchase.mercadoPagoExpiresAt,
    createdAt: purchase.createdAt,
    paidAt: purchase.paidAt,
    emailSentAt: purchase.emailSentAt,
    downloadUrl: purchase.status === 'paid' ? (purchase.downloadUrl || DOWNLOAD_URL) : undefined,
    licenseKey: purchase.status === 'paid' ? purchase.licenseKey : undefined,
    email: purchase.status === 'paid' ? purchase.email : undefined,
    checkoutUrl: purchase.checkoutUrl || undefined,
    subscriptionId: purchase.mercadoPagoSubscriptionId || undefined
  };
}
async function mercadoPagoRequest(path, options = {}) {
  if (!MERCADO_PAGO_ACCESS_TOKEN) throw new Error('MERCADO_PAGO_ACCESS_TOKEN não configurado.');
  const response = await fetch(`https://api.mercadopago.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || data.error || `Mercado Pago respondeu ${response.status}.`);
    error.status = 502;
    error.details = data;
    throw error;
  }
  return data;
}
async function createMercadoPagoPix(purchase) {
  const [firstName, ...rest] = String(purchase.name || 'Cliente').trim().split(/\s+/);
  const document = String(purchase.cpfCnpj || '').replace(/\D/g, '');
  const payload = {
    transaction_amount: Number(purchase.amount),
    description: `Licença ZapDisparo - ${purchase.plan}`,
    payment_method_id: 'pix',
    external_reference: purchase.orderCode,
    notification_url: MERCADO_PAGO_WEBHOOK_URL,
    date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    payer: {
      email: purchase.email,
      first_name: firstName || 'Cliente',
      last_name: rest.join(' ') || 'ZapDisparo'
    }
  };
  if ([11, 14].includes(document.length)) payload.payer.identification = { type: document.length === 11 ? 'CPF' : 'CNPJ', number: document };
  const payment = await mercadoPagoRequest('/v1/payments', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': `zap-${purchase.orderCode}` },
    body: JSON.stringify(payload)
  });
  const tx = payment.point_of_interaction?.transaction_data || {};
  purchase.mercadoPagoPaymentId = String(payment.id);
  purchase.paymentReference = String(payment.id);
  purchase.mercadoPagoStatus = payment.status;
  purchase.mercadoPagoStatusDetail = payment.status_detail;
  purchase.mercadoPagoQrCode = tx.qr_code || '';
  purchase.mercadoPagoQrCodeBase64 = tx.qr_code_base64 || '';
  purchase.mercadoPagoTicketUrl = tx.ticket_url || '';
  purchase.mercadoPagoExpiresAt = payment.date_of_expiration ? new Date(payment.date_of_expiration) : null;
  purchase.paymentLastCheckedAt = new Date();
  await purchase.save();
  return payment;
}
async function createMercadoPagoSubscription(purchase) {
  const payload = {
    reason: `Licença mensal ZapDisparo - ${purchase.email}`,
    external_reference: purchase.orderCode,
    payer_email: purchase.email,
    back_url: MERCADO_PAGO_SUBSCRIPTION_BACK_URL,
    notification_url: MERCADO_PAGO_WEBHOOK_URL,
    status: 'pending',
    auto_recurring: {
      frequency: planSettings(purchase.plan).recurringMonths,
      frequency_type: 'months',
      transaction_amount: Number(purchase.amount),
      currency_id: 'BRL'
    }
  };
  const subscription = await mercadoPagoRequest('/preapproval', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': `zap-sub-${purchase.orderCode}` },
    body: JSON.stringify(payload)
  });
  purchase.paymentMethod = 'card_recurring';
  purchase.mercadoPagoSubscriptionId = String(subscription.id || '');
  purchase.mercadoPagoSubscriptionStatus = subscription.status || 'pending';
  purchase.checkoutUrl = subscription.init_point || '';
  purchase.paymentReference = purchase.mercadoPagoSubscriptionId;
  await purchase.save();
  return subscription;
}

async function finalizePurchase(purchase, source = 'automatic', providerPaymentId = '') {
  const paymentId = String(providerPaymentId || purchase.mercadoPagoPaymentId || '').trim();
  let event = null;

  if (paymentId) {
    event = await PaymentEvent.findOneAndUpdate(
      { providerPaymentId: paymentId },
      { $setOnInsert: { providerPaymentId: paymentId, orderCode: purchase.orderCode, subscriptionId: purchase.mercadoPagoSubscriptionId, email: purchase.email, amount: purchase.amount, status: 'approved' } },
      { new: true, upsert: true }
    );
    if (event.processedAt) {
      const knownLicense = event.licenseId ? await License.findById(event.licenseId) : null;
      return { purchase, license: knownLicense, alreadyProcessed: true, action: event.action };
    }
  }

  const settings = planSettings(purchase.plan);
  let license = await License.findOne({ email: normalizeEmail(purchase.email) }).sort({ createdAt: 1 });
  const isNewLicense = !license;
  const action = isNewLicense ? 'created' : 'renewed';
  const previousExpiresAt = license?.expiresAt ? new Date(license.expiresAt) : null;

  try {
    if (!license) {
      const generatedToken = generateLicenseKey(purchase.email);
      license = await License.create({
        name: purchase.name,
        email: purchase.email,
        token: generatedToken,
        licenseKey: generatedToken,
        status: 'active',
        plan: settings.name,
        expiresAt: addDaysFrom(null, settings.days),
        dailyLimit: 300,
        connectionLimit: 1,
        allowedDevices: 1,
        renewCount: 0,
        notes: `Gerada pelo pedido ${purchase.orderCode} (${source})`
      });
    } else {
      license.name = purchase.name || license.name;
      license.status = 'active';
      license.plan = settings.name;
      license.expiresAt = addDaysFrom(license.expiresAt, settings.days);
      license.renewCount = Number(license.renewCount || 0) + 1;
      license.notes = `${license.notes || ''}\nRenovada por ${settings.days} dias via ${source}, pedido ${purchase.orderCode}, pagamento ${paymentId || 'sem-id'}`.trim();
      await license.save();
    }

    license.tokenSignature = signLicense(license);
    await license.save();

    purchase.status = 'paid';
    purchase.paidAt = purchase.paidAt || new Date();
    purchase.paymentApprovedAt = purchase.paymentApprovedAt || new Date();
    purchase.licenseId = license._id;
    purchase.licenseKey = license.licenseKey;
    purchase.downloadUrl = purchase.downloadUrl || DOWNLOAD_URL;
    purchase.emailError = '';
    await purchase.save();

    const history = await LicenseHistory.findOneAndUpdate(
      paymentId ? { providerPaymentId: paymentId } : { orderCode: purchase.orderCode, action },
      {
        $setOnInsert: {
          licenseId: license._id,
          purchaseId: purchase._id,
          orderCode: purchase.orderCode,
          providerPaymentId: paymentId,
          email: purchase.email,
          action,
          plan: settings.name,
          amount: purchase.amount,
          addedDays: settings.days,
          previousExpiresAt,
          newExpiresAt: license.expiresAt,
          source,
          emailStatus: 'pending'
        }
      },
      { new: true, upsert: true }
    );

    if (!purchase.emailSentAt) {
      try {
        if (isNewLicense) await sendLicenseEmail(purchase, license);
        else await sendRenewalEmail(purchase, license, settings.days);
        purchase.emailSentAt = new Date();
        history.emailStatus = 'sent';
        history.emailError = '';
      } catch (error) {
        purchase.emailError = error.message;
        history.emailStatus = 'failed';
        history.emailError = error.message;
      }
      await Promise.all([purchase.save(), history.save()]);
    }

    if (event) {
      event.processedAt = new Date();
      event.licenseId = license._id;
      event.action = action;
      event.error = '';
      await event.save();
    }

    await Audit.create({
      action: `license.${action}`,
      entityType: 'License',
      entityId: String(license._id),
      summary: action === 'created' ? `Licença criada para ${purchase.email}` : `Licença renovada por ${settings.days} dias para ${purchase.email}`,
      metadata: { orderCode: purchase.orderCode, providerPaymentId: paymentId, plan: settings.name, amount: purchase.amount, previousExpiresAt, newExpiresAt: license.expiresAt, source }
    }).catch((error) => console.error('Falha ao registrar auditoria do pagamento:', error.message));

    return { purchase, license, alreadyProcessed: false, action, history };
  } catch (error) {
    if (event) {
      event.error = error.message;
      await event.save().catch(() => {});
    }
    throw error;
  }
}
async function syncMercadoPagoPayment(purchase) {
  if (!purchase.mercadoPagoPaymentId || purchase.status === 'paid') return purchase;
  const payment = await mercadoPagoRequest(`/v1/payments/${encodeURIComponent(purchase.mercadoPagoPaymentId)}`);
  purchase.mercadoPagoStatus = payment.status;
  purchase.mercadoPagoStatusDetail = payment.status_detail;
  purchase.paymentLastCheckedAt = new Date();
  if (payment.status === 'approved') {
    const externalReference = String(payment.external_reference || '');
    if (externalReference !== purchase.orderCode) throw new Error('Referência externa do pagamento não confere.');
    if (Math.abs(Number(payment.transaction_amount) - Number(purchase.amount)) > 0.009) throw new Error('Valor do pagamento não confere.');
    await finalizePurchase(purchase, 'mercado-pago', String(payment.id));
  } else if (['cancelled', 'rejected', 'refunded', 'charged_back'].includes(payment.status)) {
    purchase.mercadoPagoQrCode = '';
    purchase.mercadoPagoQrCodeBase64 = '';
    await purchase.save();
  } else {
    await purchase.save();
  }
  return purchase;
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'zapdisparo-license-server' }));

app.post('/api/sales/orders', publicRateLimit, async (req, res) => {
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  if (!body.name || !validEmail(email)) return res.status(400).json({ ok: false, message: 'Informe nome e e-mail válidos.' });
  const settings = planSettings(body.plan);
  const orderToken = createOrderAccessToken();
  const purchase = await Purchase.create({
    orderCode: generateOrderCode(), name: String(body.name).trim(), email,
    phone: String(body.phone || '').trim(), cpfCnpj: String(body.cpfCnpj || '').trim(),
    plan: settings.name,
    amount: settings.amount,
    paymentMethod: body.paymentMethod === 'card_recurring' ? 'card_recurring' : 'pix', downloadUrl: DOWNLOAD_URL,
    accessTokenHash: hashOrderAccessToken(orderToken)
  });
  res.status(201).json({ ok: true, message: 'Pedido criado.', orderToken, order: publicOrder(purchase) });
});
app.post('/api/payments/pix/static/start', publicRateLimit, async (req, res) => {
  const purchase = await Purchase.findOne({ orderCode: String(req.body?.orderCode || '').trim() }).select('+accessTokenHash');
  if (!purchase) return res.status(404).json({ ok: false, message: 'Pedido não encontrado.' });
  if (!requireOrderAccess(purchase, req, res)) return;
  if (purchase.status === 'paid') return res.json({ ok: true, order: publicOrder(purchase) });
  await createMercadoPagoPix(purchase);
  res.json({ ok: true, message: 'PIX dinâmico criado. Aguardando confirmação do Mercado Pago.', order: publicOrder(purchase) });
});

app.post('/api/payments/mercadopago/create', publicRateLimit, async (req, res) => {
  const purchase = await Purchase.findOne({ orderCode: String(req.body?.orderCode || '').trim() }).select('+accessTokenHash');
  if (!purchase) return res.status(404).json({ ok: false, message: 'Pedido não encontrado.' });
  if (!requireOrderAccess(purchase, req, res)) return;
  if (purchase.status === 'paid') return res.json({ ok: true, order: publicOrder(purchase) });
  await createMercadoPagoPix(purchase);
  res.json({ ok: true, order: publicOrder(purchase) });
});
app.get('/api/sales/orders/:orderCode', publicRateLimit, async (req, res) => {
  const purchase = await Purchase.findOne({ orderCode: req.params.orderCode }).select('+accessTokenHash');
  if (!purchase) return res.status(404).json({ ok: false, message: 'Pedido não encontrado.' });
  if (!requireOrderAccess(purchase, req, res)) return;
  try {
    const lastCheck = purchase.paymentLastCheckedAt ? purchase.paymentLastCheckedAt.getTime() : 0;
    if (purchase.status === 'pending' && purchase.mercadoPagoPaymentId && Date.now() - lastCheck > 5000) await syncMercadoPagoPayment(purchase);
  } catch (error) { console.error('Falha ao consultar pagamento:', error.message); }
  res.json({ ok: true, order: publicOrder(purchase) });
});
app.post('/api/payments/mercadopago/subscription/create', publicRateLimit, async (req, res) => {
  const purchase = await Purchase.findOne({ orderCode: String(req.body?.orderCode || '').trim() }).select('+accessTokenHash');
  if (!purchase) return res.status(404).json({ ok: false, message: 'Pedido não encontrado.' });
  if (!requireOrderAccess(purchase, req, res)) return;
  if (purchase.checkoutUrl) return res.json({ ok: true, order: publicOrder(purchase) });
  await createMercadoPagoSubscription(purchase);
  res.json({ ok: true, message: 'Assinatura criada. Finalize o cadastro do cartão no Mercado Pago.', order: publicOrder(purchase) });
});

app.post('/api/payments/mercadopago/webhook', async (req, res) => {
  try {
    const dataId = String(req.query['data.id'] || req.body?.data?.id || '');
    const type = String(req.query.type || req.body?.type || '');
    if (MERCADO_PAGO_WEBHOOK_SECRET) {
      if (!validateMercadoPagoSignature(req, dataId)) throw new Error('Assinatura inválida.');
    }
    res.status(200).json({ ok: true });
    if (type && type !== 'payment') return;
    setImmediate(async () => {
      try {
        const payment = await mercadoPagoRequest(`/v1/payments/${encodeURIComponent(dataId)}`);
        const subscriptionId = String(payment.subscription_id || payment.preapproval_id || payment.metadata?.subscription_id || '');
        let purchase = await Purchase.findOne({ $or: [{ mercadoPagoPaymentId: String(payment.id) }, { orderCode: String(payment.external_reference || '') }, ...(subscriptionId ? [{ mercadoPagoSubscriptionId: subscriptionId }] : [])] });
        // Somente PIX dinâmico com external_reference exclusivo é aceito.
        // Nunca associamos pagamento apenas por valor/data, pois isso pode liberar o pedido errado.
        if (!purchase) return;
        purchase.mercadoPagoPaymentId = String(payment.id);
        purchase.mercadoPagoStatus = payment.status;
        purchase.mercadoPagoStatusDetail = payment.status_detail;
        purchase.paymentLastCheckedAt = new Date();
        if (payment.status === 'approved') {
          const externalReference = String(payment.external_reference || '');
          if (externalReference && externalReference !== purchase.orderCode && !String(purchase.paymentReference || '').startsWith('STATIC-PIX-')) throw new Error('Referência externa inválida.');
          if (Math.abs(Number(payment.transaction_amount) - Number(purchase.amount)) > 0.009) throw new Error('Valor recebido diferente do pedido.');
          await finalizePurchase(purchase, 'webhook-mercado-pago', String(payment.id));
        } else await purchase.save();
      } catch (error) { console.error('Erro ao processar webhook Mercado Pago:', error); }
    });
  } catch (error) {
    console.error('Webhook Mercado Pago rejeitado:', error.message);
    res.status(401).json({ ok: false, message: 'Assinatura de webhook inválida.' });
  }
});


app.post('/api/public/demo/download/register', publicRateLimit, async (req, res) => {
  try {
    const target = new URL(DEMO_DOWNLOAD_URL);
    if (target.protocol !== 'https:' && target.hostname !== 'localhost') {
      return res.status(503).json({ ok: false, message: 'O download seguro da demonstração ainda não foi configurado.' });
    }
    const downloadId = `DL-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
    await DownloadEvent.create({
      downloadId,
      source: String(req.body?.source || 'sales-page').slice(0, 80),
      pageUrl: String(req.body?.pageUrl || '').slice(0, 500),
      referrer: String(req.body?.referrer || '').slice(0, 500),
      userAgent: String(req.body?.userAgent || req.headers['user-agent'] || '').slice(0, 800),
      ipHash: ip ? crypto.createHash('sha256').update(ip).digest('hex') : ''
    });
    res.status(201).json({ ok: true, downloadId, downloadUrl: `${req.protocol}://${req.get('host')}/api/public/demo/download/${encodeURIComponent(downloadId)}` });
  } catch (error) {
    console.error('Erro ao registrar download da demo:', error);
    res.status(500).json({ ok: false, message: 'Não foi possível preparar o download da demonstração.' });
  }
});

app.get('/api/public/demo/download/:downloadId', publicRateLimit, async (req, res) => {
  const downloadId = String(req.params.downloadId || '').trim();
  try {
    const target = new URL(DEMO_DOWNLOAD_URL);
    if (target.protocol !== 'https:' && target.hostname !== 'localhost') throw new Error('URL de download sem HTTPS.');
    const event = await DownloadEvent.findOne({ downloadId });
    if (!event) return res.status(404).json({ ok: false, message: 'Download não encontrado ou expirado.' });
    event.downloadedAt = new Date();
    event.status = 'redirected';
    await event.save();
    return res.redirect(302, target.toString());
  } catch (error) {
    await DownloadEvent.updateOne({ downloadId }, { $set: { status: 'failed', error: String(error.message || error) } }).catch(() => {});
    return res.status(503).json({ ok: false, message: 'O instalador está temporariamente indisponível.' });
  }
});

app.post('/api/license/demo/start', publicRateLimit, async (req, res) => {
  try {
    const deviceId = String(req.body?.deviceId || '').trim();
    if (!deviceId || deviceId.length < 12) return res.status(400).json({ ok: false, active: false, reason: 'Identificador do dispositivo inválido.' });

    let trial = await DemoTrial.findOne({ deviceId });
    let license = trial ? await License.findById(trial.licenseId) : null;

    if (!trial || !license) {
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + 72 * 60 * 60 * 1000);
      const token = `DEMO-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
      license = await License.create({
        email: `demo-${crypto.createHash('sha256').update(deviceId).digest('hex').slice(0, 20)}@trial.local`,
        name: 'Usuário Demo', plan: 'Demo', licenseType: 'demo', token, licenseKey: token,
        status: 'active', expiresAt, dailyLimit: 50, connectionLimit: 1, allowedDevices: 1,
        devices: [{ deviceId, activatedAt: startedAt, lastCheckAt: startedAt }],
        notes: 'Demonstração automática de 72 horas.'
      });
      trial = await DemoTrial.create({ deviceId, licenseId: license._id, startedAt, expiresAt, status: 'active' });
    }

    const expired = !license.expiresAt || license.expiresAt.getTime() <= Date.now();
    if (expired && license.status === 'active') { license.status = 'expired'; await license.save(); }
    if (expired && trial.status === 'active') { trial.status = 'expired'; await trial.save(); }

    return res.status(expired ? 403 : 200).json({
      ok: !expired, active: !expired, reason: expired ? 'O período gratuito de 3 dias terminou.' : '',
      email: license.email, licenseKey: license.licenseKey, status: license.status, plan: 'Demo',
      licenseType: 'demo', isDemo: true, startedAt: trial.startedAt, expiresAt: license.expiresAt,
      dailyLimit: license.dailyLimit, connectionLimit: license.connectionLimit, allowedDevices: 1,
      devicesUsed: 1,
      licenseProof: publicLicenseProof(license),
      signatureVersion: 2
    });
  } catch (error) {
    console.error('Erro ao iniciar demonstração:', error);
    return res.status(500).json({ ok: false, active: false, reason: 'Não foi possível iniciar a demonstração.' });
  }
});

app.post('/api/license/verify', publicRateLimit, async (req, res) => {
  const { email, licenseKey, deviceId } = req.body || {};
  if (!email || !licenseKey || !deviceId) return res.status(400).json({ active: false, reason: 'Informe e-mail, licença e deviceId.' });
  const suppliedToken = String(licenseKey || '').trim().toUpperCase();
  const license = await License.findOne({ email: normalizeEmail(email), $or: [{ token: suppliedToken }, { licenseKey: suppliedToken }] });
  if (!license) return res.status(404).json({ active: false, reason: 'Licença não encontrada.' });
  if (license.status !== 'active') return res.status(403).json({ active: false, reason: 'Licença bloqueada ou inativa.' });
  if (license.expiresAt && license.expiresAt.getTime() < Date.now()) return res.status(403).json({ active: false, reason: 'Assinatura vencida.' });
  const devices = license.devices || [];
  const existing = devices.find((item) => item.deviceId === deviceId);
  if (!existing && devices.length >= Number(license.allowedDevices || 1)) return res.status(403).json({ active: false, reason: 'Limite de máquinas atingido para esta licença.' });
  if (existing) existing.lastCheckAt = new Date(); else devices.push({ deviceId, activatedAt: new Date(), lastCheckAt: new Date() });
  license.devices = devices;
  await license.save();
  if ((license.licenseType || 'paid') !== 'demo') {
    await DemoTrial.updateOne(
      { deviceId, status: { $ne: 'converted' } },
      { $set: { status: 'converted', convertedAt: new Date(), convertedLicenseId: license._id } }
    ).catch(() => {});
  }
  license.tokenSignature = signLicense(license);
  await license.save();
  res.json({ ok: true, active: true, email: license.email, licenseKey: license.licenseKey, status: license.status, plan: license.plan, licenseType: license.licenseType || 'paid', isDemo: license.licenseType === 'demo' || license.plan === 'Demo', expiresAt: license.expiresAt, dailyLimit: license.dailyLimit, connectionLimit: license.connectionLimit, allowedDevices: license.allowedDevices, devicesUsed: license.devices.length, licenseProof: publicLicenseProof(license), signatureVersion: 2 });
});

app.use('/api/admin', publicRateLimit);
app.get('/api/admin/check', requireAdmin, (req, res) => res.json({ ok: true }));
app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const inSevenDays = new Date(Date.now() + 7 * 86400000);
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const approvedDate = { $ifNull: ['$paidAt', { $ifNull: ['$paymentApprovedAt', '$createdAt'] }] };

  const [
    pixPending, pixConfirmed, activeLicenses, expiredLicenses, activeSubscriptions,
    renewals, revenueMonthRows, revenueYearRows, monthlyRevenueRows, plansSoldRows,
    latestPayments, expiringSoon, totalOrders, totalLicenses, recurringSubscriptions,
    paidSummaryRows, pixConversionRows, cardConversionRows, cancellations
  ] = await Promise.all([
    Purchase.countDocuments({ status: 'pending', paymentMethod: 'pix' }),
    Purchase.countDocuments({ status: 'paid', paymentMethod: 'pix' }),
    License.countDocuments({ status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }),
    License.countDocuments({ $or: [{ status: 'expired' }, { expiresAt: { $lt: now } }] }),
    Purchase.countDocuments({ status: 'paid', paymentMethod: 'card_recurring', mercadoPagoSubscriptionStatus: { $nin: ['cancelled', 'paused'] } }),
    LicenseHistory.countDocuments({ action: 'renewed' }),
    Purchase.aggregate([{ $match: { status: 'paid', $expr: { $gte: [approvedDate, startOfMonth] } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Purchase.aggregate([{ $match: { status: 'paid', $expr: { $gte: [approvedDate, startOfYear] } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Purchase.aggregate([
      { $match: { status: 'paid', $expr: { $gte: [approvedDate, twelveMonthsAgo] } } },
      { $project: { amount: 1, approvedAt: approvedDate } },
      { $group: { _id: { year: { $year: '$approvedAt' }, month: { $month: '$approvedAt' } }, total: { $sum: '$amount' }, payments: { $sum: 1 } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } }
    ]),
    Purchase.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: '$plan', total: { $sum: 1 }, revenue: { $sum: '$amount' } } }]),
    Purchase.find({ status: 'paid' }).sort({ paidAt: -1, paymentApprovedAt: -1, createdAt: -1 }).limit(12).lean(),
    License.countDocuments({ status: 'active', expiresAt: { $gte: now, $lte: inSevenDays } }),
    Purchase.countDocuments(),
    License.countDocuments(),
    Purchase.find({ status: 'paid', paymentMethod: 'card_recurring', mercadoPagoSubscriptionStatus: { $nin: ['cancelled', 'paused'] } }, { plan: 1, amount: 1 }).lean(),
    Purchase.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: null, revenue: { $sum: '$amount' }, payments: { $sum: 1 } } }]),
    Purchase.aggregate([{ $match: { paymentMethod: 'pix', status: { $in: ['paid', 'cancelled'] } } }, { $group: { _id: '$status', total: { $sum: 1 } } }]),
    Purchase.aggregate([{ $match: { paymentMethod: 'card_recurring', status: { $in: ['paid', 'cancelled'] } } }, { $group: { _id: '$status', total: { $sum: 1 } } }]),
    Purchase.countDocuments({ $or: [{ status: 'cancelled' }, { mercadoPagoSubscriptionStatus: 'cancelled' }] })
  ]);

  const monthNames = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const revenueMap = new Map(monthlyRevenueRows.map((row) => [`${row._id.year}-${row._id.month}`, row]));
  const monthlyRevenue = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() - 11 + index, 1);
    const found = revenueMap.get(`${date.getFullYear()}-${date.getMonth() + 1}`);
    return { key: `${date.getFullYear()}-${date.getMonth() + 1}`, month: monthNames[date.getMonth()], year: date.getFullYear(), revenue: found?.total || 0, payments: found?.payments || 0 };
  });
  const planMap = new Map(plansSoldRows.map((row) => [row._id, row]));
  const plansSold = ['Mensal', 'Semestral', 'Anual'].map((plan) => ({ plan, total: planMap.get(plan)?.total || 0, revenue: planMap.get(plan)?.revenue || 0 }));
  const monthlyRecurringRevenue = recurringSubscriptions.reduce((total, subscription) => {
    const settings = planSettings(subscription.plan);
    return total + (Number(subscription.amount || settings.amount) / Number(settings.recurringMonths || 1));
  }, 0);
  const annualRecurringRevenue = monthlyRecurringRevenue * 12;
  const paidSummary = paidSummaryRows[0] || { revenue: 0, payments: 0 };
  const averageTicket = paidSummary.payments ? Number(paidSummary.revenue || 0) / Number(paidSummary.payments) : 0;
  const conversionRate = (rows) => {
    const map = new Map(rows.map((row) => [row._id, Number(row.total || 0)]));
    const paid = map.get('paid') || 0;
    const cancelled = map.get('cancelled') || 0;
    const concluded = paid + cancelled;
    return concluded ? (paid / concluded) * 100 : 0;
  };

  const [demoDownloads, demoInstalls, demoExpired, demoConverted, firstDemo, firstConversion] = await Promise.all([
    DownloadEvent.countDocuments({ status: { $in: ['registered', 'redirected'] } }),
    DemoTrial.countDocuments(),
    DemoTrial.countDocuments({ $or: [{ status: 'expired' }, { expiresAt: { $lte: now }, status: { $ne: 'converted' } }] }),
    DemoTrial.countDocuments({ status: 'converted' }),
    DemoTrial.findOne().sort({ startedAt: 1 }).lean(),
    DemoTrial.findOne({ status: 'converted', convertedAt: { $ne: null } }).sort({ convertedAt: 1 }).lean()
  ]);
  const demoConversionRate = demoInstalls ? (demoConverted / demoInstalls) * 100 : 0;
  const averageTimeToPurchaseHours = firstDemo && firstConversion
    ? Math.max(0, (new Date(firstConversion.convertedAt).getTime() - new Date(firstDemo.startedAt).getTime()) / 3600000)
    : 0;

  res.json({
    ok: true,
    metrics: {
      activeLicenses, expiredLicenses, activeSubscriptions, revenueMonth: revenueMonthRows[0]?.total || 0,
      revenueYear: revenueYearRows[0]?.total || 0, pixPending, pixConfirmed, renewals, expiringSoon,
      totalOrders, totalLicenses, mrr: monthlyRecurringRevenue, arr: annualRecurringRevenue,
      averageTicket, pixConversion: conversionRate(pixConversionRows), cardConversion: conversionRate(cardConversionRows),
      cancellations, demoDownloads, demoInstalls, demoExpired, demoConverted, demoConversionRate, averageTimeToPurchaseHours
    },
    monthlyRevenue,
    plansSold,
    latestPayments
  });
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  if (req.query.search) {
    const regex = new RegExp(escapeRegExp(req.query.search), 'i');
    filter.$or = [{ orderCode: regex }, { name: regex }, { email: regex }, { phone: regex }, { cpfCnpj: regex }, { licenseKey: regex }, { paymentReference: regex }, { mercadoPagoPaymentId: regex }, { mercadoPagoSubscriptionId: regex }];
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
  const result = await finalizePurchase(purchase, 'confirmação-manual');
  await audit(req, 'order.payment_confirmed', 'Purchase', purchase._id, `Pagamento confirmado: ${purchase.orderCode}`, { licenseId: result.license?._id });
  res.status(purchase.emailError ? 202 : 200).json({ ok: true, emailSent: !purchase.emailError, message: purchase.emailError ? `Licença liberada, mas o e-mail não foi enviado: ${purchase.emailError}` : 'Pagamento confirmado, licença gerada e e-mail enviado.', order: purchase, license: result.license });
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

app.get('/api/admin/license-history', requireAdmin, async (req, res) => {
  const email = normalizeEmail(req.query.email || '');
  const licenseId = String(req.query.licenseId || '').trim();
  const filter = {};
  if (email) filter.email = email;
  if (licenseId && mongoose.Types.ObjectId.isValid(licenseId)) filter.licenseId = licenseId;
  const history = await LicenseHistory.find(filter).sort({ createdAt: -1 }).limit(2000).lean();
  res.json({ ok: true, history });
});

app.get('/api/admin/licenses', requireAdmin, async (req, res) => {
  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  if (req.query.plan && req.query.plan !== 'all') filter.plan = req.query.plan;
  if (req.query.expiry === 'expired') filter.expiresAt = { $lt: new Date() };
  if (req.query.expiry === 'soon') filter.expiresAt = { $gte: new Date(), $lte: new Date(Date.now() + 7 * 86400000) };
  if (req.query.search) {
    const regex = new RegExp(escapeRegExp(req.query.search), 'i');
    filter.$or = [{ id: regex }, { name: regex }, { email: regex }, { token: regex }, { licenseKey: regex }, { notes: regex }];
  }
  const licenses = await License.find(filter).sort({ createdAt: -1 }).limit(2000).lean();
  res.json({ ok: true, licenses });
});
app.get('/api/admin/licenses/:id/history', requireAdmin, async (req, res) => {
  const license = await License.findById(req.params.id).lean();
  if (!license) return res.status(404).json({ ok: false, message: 'Licença não encontrada.' });

  const [historyRows, purchases, paymentEvents] = await Promise.all([
    LicenseHistory.find({ licenseId: license._id }).sort({ createdAt: 1 }).lean(),
    Purchase.find({ $or: [{ licenseId: license._id }, { email: license.email }] }).sort({ createdAt: 1 }).lean(),
    PaymentEvent.find({ $or: [{ licenseId: license._id }, { email: license.email }] }).sort({ createdAt: 1 }).lean()
  ]);

  const timeline = historyRows.map((item) => ({
    id: String(item._id),
    type: item.action === 'created' ? 'purchase' : 'renewal',
    title: item.action === 'created' ? 'Compra inicial' : 'Renovação da licença',
    date: item.createdAt,
    plan: item.plan,
    amount: item.amount,
    addedDays: item.addedDays,
    previousExpiresAt: item.previousExpiresAt,
    newExpiresAt: item.newExpiresAt,
    orderCode: item.orderCode,
    providerPaymentId: item.providerPaymentId,
    source: item.source,
    emailStatus: item.emailStatus,
    emailError: item.emailError
  }));

  const knownPayments = new Set(timeline.map((item) => String(item.providerPaymentId || '')).filter(Boolean));
  for (const event of paymentEvents) {
    if (knownPayments.has(String(event.providerPaymentId || ''))) continue;
    timeline.push({
      id: `payment-${event._id}`,
      type: 'payment',
      title: event.status === 'approved' ? 'Pagamento aprovado' : 'Evento de pagamento',
      date: event.processedAt || event.createdAt,
      amount: event.amount,
      providerPaymentId: event.providerPaymentId,
      orderCode: event.orderCode,
      source: event.provider,
      paymentStatus: event.status,
      action: event.action,
      error: event.error
    });
  }

  timeline.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  const totalPaid = purchases.filter((item) => item.status === 'paid').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const paidPurchases = purchases.filter((item) => item.status === 'paid');

  res.json({
    ok: true,
    customer: {
      license,
      totalPaid,
      purchasesCount: paidPurchases.length,
      renewalsCount: historyRows.filter((item) => item.action === 'renewed').length,
      firstPurchaseAt: paidPurchases[0]?.paidAt || paidPurchases[0]?.createdAt || license.createdAt,
      lastPaymentAt: paidPurchases.at(-1)?.paidAt || paidPurchases.at(-1)?.createdAt || null
    },
    timeline,
    purchases
  });
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
  const generatedToken = String(body.token || body.licenseKey || generateLicenseKey(email)).trim().toUpperCase();
  const license = await License.create({ id: body.id || crypto.randomUUID(), name: String(body.name).trim(), email, token: generatedToken, licenseKey: generatedToken, status: body.status || 'active', plan: settings.name, expiresAt, renewCount: boundedNumber(body.renewCount, 0, 0), dailyLimit: boundedNumber(body.dailyLimit, 300), connectionLimit: boundedNumber(body.connectionLimit, 1), allowedDevices: boundedNumber(body.allowedDevices, 1), notes: String(body.notes || '').trim() });
  await audit(req, 'license.created', 'License', license._id, `Licença criada para ${license.email}`, { plan: license.plan });
  let emailMessage = '';
  if (body.sendEmail) {
    try { await sendLicenseEmail({ name: license.name, email: license.email, downloadUrl: DOWNLOAD_URL }, license); emailMessage = ' E-mail enviado.'; }
    catch (error) { emailMessage = ` E-mail não enviado: ${error.message}`; }
  }
  res.status(201).json({ ok: true, license, message: `Licença criada.${emailMessage}` });
});
app.patch('/api/admin/licenses/:id', requireAdmin, async (req, res) => {
  const allowed = ['name', 'email', 'status', 'plan', 'expiresAt', 'renewCount', 'dailyLimit', 'connectionLimit', 'allowedDevices', 'notes'];
  const update = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowed.includes(key)));
  if ('email' in update) { update.email = normalizeEmail(update.email); if (!validEmail(update.email)) return res.status(400).json({ ok: false, message: 'E-mail inválido.' }); }
  if ('plan' in update) update.plan = planSettings(update.plan).name;
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
  license.renewCount = Number(license.renewCount || 0) + 1;
  await license.save();
  await audit(req, 'license.renewed', 'License', license._id, `Licença renovada por ${days} dias`, { days, expiresAt: license.expiresAt });
  res.json({ ok: true, license, message: `Licença renovada por ${days} dias.` });
});
app.post('/api/admin/licenses/:id/regenerate-key', requireAdmin, async (req, res) => {
  const license = await License.findById(req.params.id);
  if (!license) return res.status(404).json({ ok: false, message: 'Licença não encontrada.' });
  license.token = generateLicenseKey(license.email); license.licenseKey = license.token; license.devices = []; await license.save();
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

app.post('/api/admin/reminders/run', requireAdmin, async (req, res) => {
  const result = await runLicenseReminderJob('admin-manual');
  await audit(req, 'reminders.job_run', 'System', '', 'Job de lembretes executado manualmente', result);
  res.json({ ok: true, result });
});

app.get('/api/admin/reminders/events', requireAdmin, async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.type) filter.type = String(req.query.type);
  if (req.query.email) filter.email = normalizeEmail(req.query.email);
  const events = await ExpirationEvent.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  res.json({ ok: true, events });
});

app.post('/api/admin/licenses/:id/send-expiration-email', requireAdmin, async (req, res) => {
  const license = await License.findById(req.params.id);
  if (!license) return res.status(404).json({ ok: false, message: 'Licença não encontrada.' });
  const calculatedDays = license.expiresAt ? Math.max(0, Math.ceil((new Date(license.expiresAt).getTime() - Date.now()) / 86400000)) : 7;
  const daysRemaining = boundedNumber(req.body?.daysRemaining, calculatedDays, 0, 3650);
  await sendExpirationReminderEmail({ name: license.name, email: license.email }, license, daysRemaining);
  await audit(req, 'license.expiration_email_sent', 'License', license._id, `Aviso de vencimento enviado: ${license.email}`, { daysRemaining });
  res.json({ ok: true, message: 'E-mail de vencimento enviado.', daysRemaining });
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


async function createDatabaseBackup(source = 'scheduler') {
  if (!BACKUP_ENABLED) return { ok: false, skipped: true, reason: 'BACKUP_ENABLED=false' };
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `zapdisparo-backup-${stamp}.json.gz`);
  const collections = { licenses: License, purchases: Purchase, paymentEvents: PaymentEvent, licenseHistory: LicenseHistory, expirationEvents: ExpirationEvent, audits: Audit };
  const data = { version: '5.0.10', createdAt: new Date().toISOString(), source, collections: {} };
  for (const [name, Model] of Object.entries(collections)) data.collections[name] = await Model.find({}).lean();
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(data))));
  const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 86400000;
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    const full = path.join(BACKUP_DIR, name);
    if (name.startsWith('zapdisparo-backup-') && fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
  }
  await Audit.create({ action: 'database.backup_created', entityType: 'Database', entityId: path.basename(file), summary: 'Backup automático criado', metadata: { source, file: path.basename(file) } });
  return { ok: true, file: path.basename(file), createdAt: data.createdAt };
}
function millisecondsUntilNextBackup() {
  const now = new Date(); const next = new Date(now); next.setHours(BACKUP_HOUR, BACKUP_MINUTE, 0, 0); if (next <= now) next.setDate(next.getDate() + 1); return next.getTime() - now.getTime();
}
function scheduleDatabaseBackup() {
  if (!BACKUP_ENABLED) return;
  const delay = millisecondsUntilNextBackup();
  console.log(`Próximo backup: ${new Date(Date.now()+delay).toLocaleString('pt-BR')} (${process.env.TZ})`);
  const timer = setTimeout(async () => { try { await createDatabaseBackup('scheduler'); } catch (e) { console.error('Erro no backup automático:', e); } scheduleDatabaseBackup(); }, delay);
  timer.unref?.();
}
app.post('/api/admin/backups/run', requireAdmin, async (req, res) => res.json(await createDatabaseBackup('admin-manual')));
app.get('/api/admin/backups', requireAdmin, (req, res) => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const files = fs.readdirSync(BACKUP_DIR).filter((n) => n.endsWith('.json.gz')).map((name) => { const stat = fs.statSync(path.join(BACKUP_DIR, name)); return { name, size: stat.size, createdAt: stat.mtime }; }).sort((a,b) => b.createdAt-a.createdAt);
  res.json({ ok: true, files });
});

app.use((error, req, res, next) => {
  console.error(error);
  const message = error.code === 11000 ? 'Já existe um registro com esse e-mail/token.' : (error.message || 'Erro interno.');
  res.status(error.status || 500).json({ ok: false, message });
});

async function start() {
  if (!MONGODB_URI) throw new Error('Configure MONGODB_URI no .env');
  assertSecurityConfiguration();
  await mongoose.connect(MONGODB_URI);

  // Migração segura para licenças criadas nas versões anteriores à 5.0.4.
  const legacyLicenses = await License.find({
    $or: [
      { id: { $exists: false } },
      { token: { $exists: false } },
      { renewCount: { $exists: false } }
    ]
  });
  for (const legacy of legacyLicenses) {
    legacy.id = legacy.id || crypto.randomUUID();
    legacy.name = String(legacy.name || legacy.email?.split('@')[0] || 'Cliente').trim();
    legacy.token = String(legacy.token || legacy.licenseKey || generateLicenseKey(legacy.email)).toUpperCase();
    legacy.licenseKey = legacy.token;
    legacy.renewCount = Number(legacy.renewCount || 0);
    legacy.tokenSignature = signLicense(legacy);
    legacy.signatureVersion = 1;
    await legacy.save();
  }
  if (legacyLicenses.length) console.log(`Migração 5.0.4: ${legacyLicenses.length} licença(s) atualizada(s).`);

  app.listen(PORT, () => {
    console.log(`License server running on port ${PORT}`);
    scheduleLicenseReminderJob();
    scheduleDatabaseBackup();
  });
}
if (require.main === module) start().catch((error) => { console.error(error); process.exit(1); });

module.exports = { app, License, start };
