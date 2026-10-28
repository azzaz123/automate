require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs'); // 🔧 NUEVO: para /api/download
const { Resend } = require('resend');
const wokeDyno = require('woke-dyno');
require('./cron');

const supabaseRoutes = require('./routes/supabase');
const captchaRoutes = require('./routes/captcha');
const configuracionRoutes = require('./routes/configuracion');
const vendedoresRoutes = require('./routes/vendedores');
const notificacionesRoutes = require('./routes/notificaciones');
const botRoutes = require('./routes/bot');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex');
const JWT_EXPIRES_IN = '7d';
const SALT_ROUNDS = 12;

const MAX_NIES = parseInt(process.env.MAX_NIES_POR_CODIGO || '2');

const resend = new Resend(process.env.RESEND_API_KEY);
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://tu-app.onrender.com';

// ==========================================
// ✅ MAPS EN MEMORIA
// ==========================================
const deviceKeys = new Map();
const estadosPorDispositivo = new Map();
const comandosPendientes = new Map();
const comandosHistorial = new Map();

const TTL_DISPOSITIVO_MS = 2 * 60 * 1000;
const TTL_COMANDO_MS = 30 * 1000;

// ==========================================
// 🔧 NUEVO: MAP PARA TOKENS DE DESCARGA
// ==========================================
const downloadTokens = new Map();

// ==========================================
// ✅ HELPERS FECHA/HORA
// ==========================================
function formatearFecha(fecha) {
  if (!fecha || fecha === 'N/A') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  const partes = fecha.split(/[\/\-]/);
  if (partes.length === 3) {
    const dia = partes[0].padStart(2, '0');
    const mes = partes[1].padStart(2, '0');
    const anio = partes[2];
    if (!isNaN(dia) && !isNaN(mes) && !isNaN(anio)) return `${anio}-${mes}-${dia}`;
  }
  console.log(`⚠️ formatearFecha: formato no reconocido: "${fecha}"`);
  return null;
}

function formatearHora(hora) {
  if (!hora || hora === 'N/A') return null;
  if (/^\d{2}:\d{2}:\d{2}$/.test(hora)) return hora;
  if (/^\d{1,2}:\d{2}$/.test(hora)) {
    const partes = hora.split(':');
    const hh = partes[0].padStart(2, '0');
    const mm = partes[1].padStart(2, '0');
    return `${hh}:${mm}:00`;
  }
  console.log(`⚠️ formatearHora: formato no reconocido: "${hora}"`);
  return null;
}

// ==========================================
// ✅ MIDDLEWARES BASE
// ==========================================
app.set('trust proxy', 1);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(helmet());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization', 'x-vendedor-email', 'x-vendedor-password'],
}));

// ==========================================
// 🔧 FIX: WEBHOOKS STRIPE ANTES DE express.json()
// ==========================================
app.post('/api/vendedores/stripe-webhook', express.raw({ type: 'application/json' }), vendedoresRoutes);

app.use('/api/bot', botRoutes);

// ==========================================
// ✅ MIDDLEWARES GENERALES (después de los webhooks)
// ==========================================
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 5000 }));
app.use(express.json({ limit: '10mb' }));

// ⚠️ NOTA: si quieres que el APK SOLO se pueda descargar con token,
// comenta o elimina esta línea, y mueve el APK a private/app.apk
app.use('/downloads', express.static('downloads'));

// ==========================================
// ✅ HELPERS JWT / PASSWORD / IP
// ==========================================
function generarJWT(payload, tipo) {
  return jwt.sign({ ...payload, tipo, jti: crypto.randomBytes(16).toString('hex') }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}
function verificarJWT(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.connection?.remoteAddress || 'unknown';
}
async function hashPassword(p) {
  if (!p) return null;
  return await bcrypt.hash(p, await bcrypt.genSalt(SALT_ROUNDS));
}
async function verifyPassword(p, h) {
  if (!p || !h) return false;
  return await bcrypt.compare(p, h);
}

// ==========================================
// ✅ TTLs deviceKeys
// ==========================================
setInterval(() => {
  const now = Date.now();
  for (const [id, d] of deviceKeys.entries()) {
    if (now > d.expiresAt) deviceKeys.delete(id);
  }
}, 300000);

// 🔧 NUEVO: limpieza periódica de tokens de descarga expirados
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of downloadTokens.entries()) {
    if (now > data.expira) downloadTokens.delete(token);
  }
}, 5 * 60 * 1000);

// ==========================================
// ✅ MIDDLEWARES AUTH
// ==========================================
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API Key requerida' });
  if (apiKey === process.env.API_KEY) { req.esAdmin = true; return next(); }
  const adminData = deviceKeys.get('admin_panel');
  if (adminData && adminData.key === apiKey) {
    if (Date.now() > adminData.expiresAt) { deviceKeys.delete('admin_panel'); return res.status(401).json({ error: 'Expirada' }); }
    req.device_android_id = 'admin_panel'; req.esAdmin = true; return next();
  }
  for (const [id, d] of deviceKeys.entries()) {
    if (d.key === apiKey) {
      if (Date.now() > d.expiresAt) { deviceKeys.delete(id); return res.status(401).json({ error: 'Expirada' }); }
      req.device_android_id = id; req.esAdmin = false; return next();
    }
  }
  return res.status(401).json({ error: 'No autorizado' });
};

const authenticateMixed = (req, res, next) => {
  if (req.headers['x-api-key']) return authenticateApiKey(req, res, next);
  const token = req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].substring(7) : null;
  if (!token) return res.status(401).json({ error: 'Autenticación requerida' });
  const decoded = verificarJWT(token);
  if (!decoded) return res.status(401).json({ error: 'Token inválido' });
  req.device_android_id = decoded.sub; req.esAdmin = decoded.role === 'admin'; next();
};

const authenticateCliente = (req, res, next) => {
  const token = req.headers['authorization']?.startsWith('Bearer ')
    ? req.headers['authorization'].substring(7)
    : null;
  if (!token) return res.status(401).json({ success: false, error: 'Token requerido' });
  const decoded = verificarJWT(token);
  if (!decoded || decoded.tipo !== 'cliente') {
    return res.status(401).json({ success: false, error: 'Token inválido o expirado' });
  }
  req.device_android_id = decoded.sub;
  req.cliente_codigo = decoded.codigo;
  next();
};

// ==========================================
// ✅ SUPABASE HELPER
// ==========================================
async function supabaseQuery(endpoint, options = {}) {
  const { method = 'GET', body = null, params = {} } = options;
  let url = `${process.env.SUPABASE_URL}/rest/v1/${endpoint}`;
  const qp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined) qp.append(k, v);
  });
  if (qp.toString()) url += `?${qp.toString()}`;

  const headers = {
    'apikey': process.env.SUPABASE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (options.returnMinimal) headers['Prefer'] = 'return=minimal';

  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : null });

  if (!r.ok) {
    const errorText = await r.text();
    console.error('═══════════════════════════════════════════');
    console.error(`❌ Supabase error ${r.status} en '${endpoint}'`);
    console.error('📤 Body enviado:');
    console.error(JSON.stringify(body, null, 2));
    console.error('📥 Respuesta Supabase:');
    console.error(errorText);
    console.error('═══════════════════════════════════════════');
    throw new Error(`Supabase: ${r.status} - ${errorText}`);
  }

  const ct = r.headers.get('content-type');
  return (ct && ct.includes('application/json')) ? await r.json() : r;
}

// ==========================================
// ✅ CÓDIGO ACTIVO Y NIE
// ==========================================
async function obtenerCodigoActivo(android_id) {
  if (!android_id) return null;
  try {
    const ahora = new Date().toISOString();
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/codigos_activacion?android_id_activado=eq.${android_id}&estado=eq.usado&fecha_expiracion=gte.${ahora}&select=codigo,vendedor_id,fecha_uso,fecha_expiracion,nies_usados,max_nies&order=fecha_uso.desc&limit=1`,
      { headers: { 'apikey': process.env.SUPABASE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_KEY}`, 'Content-Type': 'application/json' } }
    );
    const codigos = await response.json();
    const codigo = codigos?.[0] || null;
    if (codigo) console.log(`🔑 Código activo: ${codigo.codigo} | NIE: ${codigo.nies_usados?.length || 0}/${codigo.max_nies || MAX_NIES}`);
    else console.log(`⚠️ No hay código activo para ${android_id}`);
    return codigo;
  } catch (e) {
    console.error('❌ Error obteniendo código activo:', e.message);
    return null;
  }
}

async function validarYRegistrarNIE(codigo, nie) {
  if (!codigo || !nie) return { permitido: true, motivo: 'Sin código o NIE, no se valida' };
  try {
    const nieNorm = nie.toString().trim().toUpperCase();
    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}&select=codigo,nies_usados,estado,max_nies,ampliaciones_compradas`,
      { headers: { 'apikey': process.env.SUPABASE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const codigos = await response.json();
    const codigoData = codigos?.[0];
    if (!codigoData) return { permitido: false, motivo: 'Código no encontrado' };
    const niesUsados = codigoData.nies_usados || [];
    const maxNiesCodigo = codigoData.max_nies || MAX_NIES;
    if (niesUsados.includes(nieNorm)) {
      console.log(`✅ NIE ${nieNorm} ya registrado en ${codigo} (${niesUsados.length}/${maxNiesCodigo})`);
      return { permitido: true, motivo: 'NIE repetido', nies_usados: niesUsados, max: maxNiesCodigo };
    }
    if (niesUsados.length >= maxNiesCodigo) {
      console.log(`🚫 Código ${codigo} alcanzó el máximo de ${maxNiesCodigo} NIE. Intento: ${nieNorm}`);
      return {
        permitido: false,
        motivo: `Este código ya ha sido usado para ${maxNiesCodigo} NIE diferentes. Puedes ampliar el cupo desde la app.`,
        nies_usados: niesUsados,
        max: maxNiesCodigo,
      };
    }
    const nuevosNies = [...niesUsados, nieNorm];
    await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}`,
      {
        method: 'PATCH',
        headers: { 'apikey': process.env.SUPABASE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ nies_usados: nuevosNies }),
      }
    );
    console.log(`✅ NIE ${nieNorm} añadido al código ${codigo} (${nuevosNies.length}/${maxNiesCodigo})`);
    return { permitido: true, motivo: `NIE registrado (${nuevosNies.length}/${maxNiesCodigo})`, nies_usados: nuevosNies, max: maxNiesCodigo };
  } catch (e) {
    console.error('❌ Error en validarYRegistrarNIE:', e.message);
    return { permitido: true, motivo: 'Error interno, se permite por defecto' };
  }
}

// ==========================================
// 📧 HTML PREMIUM
// ==========================================
function generarHTMLCita(d) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head><body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background-color:#f0f4f8;"><table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f4f8;padding:40px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);border-radius:16px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.15);"><tr><td style="padding:40px 40px 20px;text-align:center"><div style="background:rgba(255,255,255,0.2);width:80px;height:80px;border-radius:50%;display:inline-block;line-height:80px;font-size:40px;margin-bottom:20px">🎉</div><h1 style="color:#ffffff;margin:0;font-size:28px;font-weight:700">¡Cita Conseguida!</h1><p style="color:rgba(255,255,255,0.9);margin:15px 0 0;font-size:16px">Tu cita ha sido confirmada exitosamente</p></td></tr><tr><td style="padding:0 20px 20px"><table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden"><tr><td style="padding:30px"><div style="background:linear-gradient(135deg,#667eea,#764ba2);border-radius:8px;padding:15px 20px;margin-bottom:25px;text-align:center"><p style="color:rgba(255,255,255,0.8);margin:0 0 5px;font-size:12px;text-transform:uppercase;letter-spacing:1px">Justificante</p><p style="color:#ffffff;margin:0;font-size:28px;font-weight:700;letter-spacing:2px">${d.justificante||'N/A'}</p></div><table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px"><tr><td style="padding:12px 0;border-bottom:1px solid #e8ecf1"><span style="color:#64748b;font-size:13px">👤 Titular</span> <span style="color:#1e293b;font-size:15px;font-weight:600;float:right">${d.titular||'N/A'}</span></td></tr>${d.nie?`<tr><td style="padding:12px 0;border-bottom:1px solid #e8ecf1"><span style="color:#64748b;font-size:13px">🆔 NIE</span> <span style="color:#1e293b;font-size:15px;font-weight:600;float:right">${d.nie}</span></td></tr>`:''}</table><div style="border-top:2px dashed #e2e8f0;margin:20px 0"></div><table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px"><tr><td width="50%" style="padding:10px 10px 10px 0;vertical-align:top"><div style="background:#f0f9ff;border-radius:8px;padding:15px;border-left:4px solid #3b82f6"><p style="color:#64748b;margin:0 0 5px;font-size:11px;text-transform:uppercase">📅 Fecha</p><p style="color:#1e293b;margin:0;font-size:18px;font-weight:700">${d.fecha_cita||d.fecha||'N/A'}</p></div></td><td width="50%" style="padding:10px 0 10px 10px;vertical-align:top"><div style="background:#f0fdf4;border-radius:8px;padding:15px;border-left:4px solid #22c55e"><p style="color:#64748b;margin:0 0 5px;font-size:11px;text-transform:uppercase">⏰ Hora</p><p style="color:#1e293b;margin:0;font-size:18px;font-weight:700">${d.hora_cita||d.hora||'N/A'}</p></div></td></tr></table><table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px"><tr><td style="padding:12px 0;border-bottom:1px solid #e8ecf1"><span style="color:#64748b;font-size:13px">📍 Oficina</span> <span style="color:#1e293b;font-size:15px;font-weight:600;float:right">${d.oficina||'N/A'}</span></td></tr><tr><td style="padding:12px 0;border-bottom:1px solid #e8ecf1"><span style="color:#64748b;font-size:13px">🏛️ Provincia</span> <span style="color:#1e293b;font-size:15px;font-weight:600;float:right">${d.provincia||'N/A'}</span></td></tr></table>${d.telefono?`<p style="color:#64748b;font-size:13px">📞 Teléfono: <span style="color:#1e293b;font-weight:600">${d.telefono}</span></p>`:''}</td></tr><tr><td style="background:#f8fafc;padding:20px 30px;border-top:1px solid #e2e8f0;text-align:center"><p style="color:#94a3b8;font-size:12px;margin:0">📧 Correo automático • No respondas</p></td></tr></table></td></tr><tr><td style="padding:20px 40px 40px;text-align:center"><p style="color:rgba(255,255,255,0.7);font-size:12px">© ${new Date().getFullYear()} Sistema de Citas</p></td></tr></table></td></tr></table></body></html>`;
}

function generarHTMLAdmin(d) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f0f4f8;padding:40px 0"><table width="600" style="margin:0 auto;background:linear-gradient(135deg,#f59e0b,#d97706);border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,0.15)"><tr><td style="padding:40px;text-align:center"><h1 style="color:white;margin:0">🔔 Nueva Cita Conseguida</h1></td></tr><tr><td style="padding:0 20px 20px"><table width="100%" style="background:white;border-radius:12px"><tr><td style="padding:30px"><div style="background:#f59e0b;border-radius:8px;padding:15px;text-align:center;margin-bottom:20px"><p style="color:white;font-size:28px;font-weight:bold;margin:0">${d.justificante||'N/A'}</p></div><p><strong>👤 Titular:</strong> ${d.titular||'N/A'}</p>${d.nie?`<p><strong>🆔 NIE:</strong> ${d.nie}</p>`:''}<p><strong>📅 Fecha:</strong> ${d.fecha_cita||d.fecha||'N/A'}</p><p><strong>⏰ Hora:</strong> ${d.hora_cita||d.hora||'N/A'}</p><p><strong>📍 Oficina:</strong> ${d.oficina||'N/A'}</p><p><strong>🏛️ Provincia:</strong> ${d.provincia||'N/A'}</p>${d.telefono?`<p><strong>📞 Teléfono:</strong> ${d.telefono}</p>`:''}<p><strong>✉️ Email:</strong> ${d.email||'N/A'}</p><p><strong>📱 Dispositivo:</strong> ${d.android_id||'N/A'}</p></td></tr></table></td></tr></table></body></html>`;
}

async function enviarEmail(to, subject, html, text = null) {
  try {
    const from = `${process.env.FROM_NAME||'Cita Previa'} <${process.env.FROM_EMAIL||'citas@zyromo.com'}>`;
    const payload = {
      from,
      to: [to],
      subject,
      html,
      reply_to: process.env.REPLY_TO || process.env.FROM_EMAIL,
      headers: {
        'List-Unsubscribe': `<mailto:${process.env.FROM_EMAIL}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
    if (text) payload.text = text;
    const { data, error } = await resend.emails.send(payload);
    if (error) {
      console.error('❌ Resend:', JSON.stringify(error, null, 2));
      return false;
    }
    console.log('✅ Email enviado! ID:', data?.id);
    return true;
  } catch (e) {
    console.error('❌ Error:', e.message);
    return false;
  }
}

// ==========================================
// ✅ ENDPOINTS DE VERSIÓN Y CONFIG
// ==========================================
app.get('/api/version', (req, res) => {
  try {
    const currentVersion = req.query.current_version || '0.0.0';
    const latestVersion = process.env.APP_LATEST_VERSION || '1.0.0';
    const downloadUrl = process.env.APP_DOWNLOAD_URL || '';
    const baseUrl = process.env.APP_BASE_URL || 'https://gogo.zyromo.com';

    console.log('📱 [Version] Cliente:', currentVersion, '| Servidor:', latestVersion);

    const compareVersions = (v1, v2) => {
      const a = v1.split('.').map(n => parseInt(n) || 0);
      const b = v2.split('.').map(n => parseInt(n) || 0);
      const maxLen = Math.max(a.length, b.length);
      for (let i = 0; i < maxLen; i++) {
        const num1 = a[i] || 0;
        const num2 = b[i] || 0;
        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
      }
      return 0;
    };

    const hayActualizacion = compareVersions(latestVersion, currentVersion) > 0;

    res.json({
      success: true,
      data: {
        current_version: latestVersion,
        download_url: downloadUrl,
        has_update: hayActualizacion,
        force_update: false,
        release_notes: `Nueva versión ${latestVersion} disponible`,
        base_url: baseUrl,
      },
    });

    console.log('📱 [Version] has_update:', hayActualizacion);
  } catch (e) {
    console.error('❌ [Version] Error:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

app.get('/api/app/config', (req, res) => {
  try {
    res.json({
      success: true,
      version_url: process.env.APP_VERSION_URL || '',
      download_url: process.env.APP_DOWNLOAD_URL || '',
      base_url: process.env.APP_BASE_URL || 'https://gogo.zyromo.com',
    });
    console.log('✅ [AppConfig] Enviado');
  } catch (e) {
    console.error('❌ [AppConfig] Error:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ==========================================
// ✅ ENDPOINTS AUTH / INIT
// ==========================================
app.post('/api/config/init', async (req, res) => {
  const { android_id } = req.body;
  if (!android_id) return res.status(400).json({ error: 'android_id requerido' });
  const key = crypto.randomBytes(32).toString('hex');
  deviceKeys.set(android_id, { key, createdAt: Date.now(), expiresAt: Date.now() + 3600000 });
  res.json({ success: true, apiKey: key, expiresIn: 3600 });
});

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (email === 'admin@citas.com' && password === 'admin') {
    const key = crypto.randomBytes(32).toString('hex');
    deviceKeys.set('admin_panel', { key, createdAt: Date.now(), expiresAt: Date.now() + 86400000 });
    const token = generarJWT({ sub: 'admin_panel', email, nombre: 'Administrador', role: 'admin' }, 'admin');
    res.json({ success: true, apiKey: key, token, expiresIn: 86400, usuario: { email, nombre: 'Administrador', role: 'admin' } });
  } else res.status(401).json({ error: 'Credenciales inválidas' });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/usuarios?email=eq.${email}&select=*`, { headers: { 'apikey': process.env.SUPABASE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_KEY}` } });
  const users = await r.json();
  if (!users[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (!await verifyPassword(password, users[0].password_hash)) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const { password_hash, ...user } = users[0];
  const token = generarJWT({ sub: user.android_id, email: user.email, nombre: user.nombre, role: 'usuario' }, 'usuario');
  res.json({ success: true, token, usuario: { ...user, role: 'usuario' } });
});

// ==========================================
// ✅ ESTADOS DE DISPOSITIVOS
// ==========================================
app.post('/api/estado', authenticateApiKey, express.json(), (req, res) => {
  const { mensaje, android_id, intentos, intentos_hora, citas, pagina_actual, provincia } = req.body;
  if (!mensaje || !android_id) return res.status(400).json({ error: 'Datos requeridos' });

  estadosPorDispositivo.set(android_id, {
    android_id,
    mensaje,
    intentos: intentos || 0,
    intentos_hora: intentos_hora || 0,
    citas: citas || 0,
    pagina: pagina_actual || 'INICIO',
    provincia,
    ultima_actualizacion: new Date().toISOString(),
  });

  res.json({ success: true });
});

app.get('/api/estado/todos', authenticateApiKey, (req, res) => {
  const ahora = Date.now();
  const data = Array.from(estadosPorDispositivo.values()).map(d => {
    const ts = new Date(d.ultima_actualizacion).getTime();
    const edadMs = ahora - ts;
    return { ...d, edad_ms: edadMs, muerto: edadMs > TTL_DISPOSITIVO_MS };
  });
  res.json({ success: true, data });
});

app.post('/api/estado/desconectar', authenticateApiKey, express.json(), (req, res) => {
  const { android_id } = req.body;
  if (android_id) {
    const existia = estadosPorDispositivo.delete(android_id);
    comandosPendientes.delete(android_id);
    comandosHistorial.delete(android_id);
    console.log(`👋 [Desconectar] ${android_id} → vivo=${existia}`);
  }
  res.json({ success: true });
});

setInterval(() => {
  const ahora = Date.now();
  let eliminados = 0;
  for (const [id, d] of estadosPorDispositivo.entries()) {
    const ts = new Date(d.ultima_actualizacion).getTime();
    if (ahora - ts > TTL_DISPOSITIVO_MS) {
      estadosPorDispositivo.delete(id);
      eliminados++;
    }
  }
  if (eliminados > 0) console.log(`🧹 [TTL] ${eliminados} dispositivos muertos eliminados del Map`);
}, 5 * 60 * 1000);

// ==========================================
// ✅ COMANDOS CON ACK
// ==========================================
app.post('/api/control/:androidId', authenticateApiKey, express.json(), (req, res) => {
  const androidId = req.params.androidId;
  const comando = req.body.comando;
  const datos = req.body.datos || {};
  if (!comando) return res.status(400).json({ success: false, error: 'comando requerido' });

  comandosPendientes.set(androidId, { comando, datos, timestamp: Date.now(), estado: 'pendiente' });

  const hist = comandosHistorial.get(androidId) || [];
  hist.unshift({ comando, datos, ts: new Date().toISOString(), estado: 'pendiente' });
  comandosHistorial.set(androidId, hist.slice(0, 20));

  res.json({ success: true, comando, estado: 'pendiente' });
});

app.get('/api/control/:androidId', authenticateApiKey, (req, res) => {
  const c = comandosPendientes.get(req.params.androidId);

  if (c && Date.now() - c.timestamp > TTL_COMANDO_MS) {
    comandosPendientes.delete(req.params.androidId);
    console.log(`⏰ [Comando] Expirado: ${c.comando} para ${req.params.androidId}`);
    return res.json({ success: true, comando: null });
  }

  if (c) {
    comandosPendientes.delete(req.params.androidId);
    const hist = comandosHistorial.get(req.params.androidId) || [];
    const item = hist.find(h => h.comando === c.comando && h.estado === 'pendiente');
    if (item) item.estado = 'entregado';
    res.json({ success: true, comando: c.comando, datos: c.datos, estado: 'entregado' });
  } else {
    res.json({ success: true, comando: null });
  }
});

app.post('/api/control/:androidId/ack', authenticateApiKey, express.json(), (req, res) => {
  const { comando, estado, error } = req.body;
  const androidId = req.params.androidId;
  const hist = comandosHistorial.get(androidId) || [];
  const item = hist.find(h => h.comando === comando && h.estado === 'entregado');
  if (item) {
    item.estado = estado === 'error' ? 'error' : 'ejecutado';
    item.error = error || null;
    item.confirmado_en = new Date().toISOString();
  }
  comandosHistorial.set(androidId, hist);
  console.log(`✅ [ACK] ${androidId} → ${comando} = ${estado}`);
  res.json({ success: true });
});

app.get('/api/control/:androidId/historial', authenticateApiKey, (req, res) => {
  const hist = comandosHistorial.get(req.params.androidId) || [];
  res.json({ success: true, data: hist });
});

// ==========================================
// 🎉 CITA CONSEGUIDA + VALIDACIÓN NIE + PUSH
// ==========================================
app.post('/api/cita/conseguida', authenticateMixed, express.json(), async (req, res) => {
  try {
    const { android_id, justificante, titular, nie, fecha, hora, oficina, provincia, telefono, email } = req.body;

    console.log('========================================');
    console.log('📥 NUEVA CITA');
    console.log('📌 Justificante:', justificante);
    console.log('👤 Titular:', titular);
    console.log('🆔 NIE:', nie || 'SIN NIE');
    console.log('📅 Fecha:', fecha);
    console.log('⏰ Hora:', hora);
    console.log('✉️ Email:', email || 'NO TIENE');

    if (!justificante) return res.status(400).json({ error: 'Justificante requerido' });

    const androidIdFinal = android_id || req.device_android_id || 'desconocido';

    try {
      const yaExiste = await supabaseQuery('citas_notificadas', {
        params: {
          android_id: `eq.${androidIdFinal}`,
          justificante: `eq.${justificante}`,
          select: 'id,justificante,fecha_notificacion,email',
          limit: '1',
        },
      });

      if (yaExiste && yaExiste.length > 0) {
        console.log(`⚠️ CITA DUPLICADA DETECTADA: ${justificante}`);
        console.log(`   Ya registrada el: ${yaExiste[0].fecha_notificacion}`);
        console.log(`   → NO se envía email duplicado`);
        console.log('========================================');
        return res.json({
          success: true,
          duplicado: true,
          message: 'Cita ya registrada anteriormente',
          data: yaExiste[0],
        });
      }
    } catch (e) {
      console.error('⚠️ Error verificando duplicado (continuando):', e.message);
    }

    const codigoActivo = await obtenerCodigoActivo(androidIdFinal);

    if (codigoActivo?.codigo && nie) {
      const validacion = await validarYRegistrarNIE(codigoActivo.codigo, nie);
      if (!validacion.permitido) {
        console.log(`🚫 CITA DENEGADA: ${validacion.motivo}`);
        return res.status(403).json({
          success: false,
          error: validacion.motivo,
          codigo: codigoActivo.codigo,
          nies_usados: validacion.nies_usados,
          max_nies: validacion.max,
          tipo: 'limite_nie_alcanzado',
        });
      }
      console.log(`✅ NIE OK: ${validacion.motivo}`);
    }

    const nuevaCita = {
      android_id: androidIdFinal,
      justificante,
      titular: titular || 'N/A',
      nie: nie || null,
      fecha_cita: formatearFecha(fecha),
      hora_cita: formatearHora(hora),
      oficina: oficina || 'N/A',
      provincia: provincia || 'N/A',
      telefono: telefono || null,
      email: email || null,
      estado: 'pendiente',
      fecha_notificacion: new Date().toISOString(),
      codigo_activacion: codigoActivo?.codigo || null,
      vendedor_id: codigoActivo?.vendedor_id || null,
    };

    await supabaseQuery('citas_notificadas', { method: 'POST', body: nuevaCita, returnMinimal: true });
    console.log('💾 Guardada en Supabase');
    console.log(`🔑 Código: ${nuevaCita.codigo_activacion || 'SIN CÓDIGO'}`);
    console.log(`🏪 Vendedor: ${nuevaCita.vendedor_id || 'SIN VENDEDOR'}`);

    if (nuevaCita.email?.includes('@')) {
      const ok = await enviarEmail(
        nuevaCita.email,
        `🎉 ¡Cita Conseguida! - ${nuevaCita.oficina}`,
        generarHTMLCita(nuevaCita),
        `¡Cita Conseguida!\n\nJustificante: ${nuevaCita.justificante}\nFecha: ${nuevaCita.fecha_cita}\nHora: ${nuevaCita.hora_cita}\nOficina: ${nuevaCita.oficina}\n\nCorreo automático, no respondas.`
      );
      console.log(ok ? '✅ Email USUARIO' : '❌ Fallo USUARIO');
    } else {
      console.log('⚠️ Sin email de usuario - No se envía');
    }

    const okAdmin = await enviarEmail(
      process.env.ADMIN_EMAIL || 'admin@citas.com',
      `🔔 Nueva Cita: ${nuevaCita.justificante} - ${nuevaCita.titular}`,
      generarHTMLAdmin(nuevaCita)
    );
    console.log(okAdmin ? '✅ Email ADMIN' : '❌ Fallo ADMIN');

    // ✅ NUEVO: push al cliente si tiene FCM token
    try {
      const userRes = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${androidIdFinal}&select=fcm_token`,
        { headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}` } }
      );
      const user = (await userRes.json())?.[0];

      if (user?.fcm_token) {
        const { enviarPush } = require('./services/firebase');
        await enviarPush(
          [user.fcm_token],
          '🎉 ¡Cita conseguida!',
          `Justificante ${justificante} · ${oficina || 'Oficina'} · ${fecha || ''}`,
          null,
          { tipo: 'cita', justificante }
        );
        console.log('✅ Push enviado al cliente');
      }
    } catch (e) {
      console.error('⚠️ Error enviando push:', e.message);
    }

    console.log('========================================');

    res.json({ success: true, data: nuevaCita });
  } catch (e) {
    console.error('❌ Error:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ==========================================
// ✅ CITAS
// ==========================================
app.get('/api/citas', authenticateMixed, async (req, res) => {
  try {
    const { pagina = 1, por_pagina = 20, provincia, estado, busqueda } = req.query;

    const params = {
      select: '*,vendedores(nombre,email,telefono)',
      order: 'fecha_notificacion.desc',
      limit: por_pagina.toString(),
      offset: ((pagina - 1) * por_pagina).toString(),
    };

    if (!req.esAdmin) params.android_id = `eq.${req.device_android_id}`;
    if (req.esAdmin && provincia) params.provincia = `eq.${provincia}`;
    if (req.esAdmin && estado) params.estado = `eq.${estado}`;
    if (busqueda) params.or = `(justificante.ilike.*${busqueda}*,titular.ilike.*${busqueda}*)`;

    const citas = await supabaseQuery('citas_notificadas', { params });

    const citasFormateadas = citas.map(c => ({
      ...c,
      vendedor_nombre: c.vendedores?.nombre || null,
      vendedor_email: c.vendedores?.email || null,
      vendedor_telefono: c.vendedores?.telefono || null,
      vendedores: undefined,
    }));

    const countR = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/citas_notificadas?select=id&limit=0`,
      { headers: { 'apikey': process.env.SUPABASE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_KEY}`, 'Prefer': 'count=exact' } }
    );

    res.json({
      success: true,
      data: citasFormateadas,
      total: parseInt(countR.headers.get('content-range')?.split('/')[1] || '0'),
      pagina: parseInt(pagina),
    });
  } catch (e) {
    console.error('❌ Error en GET /api/citas:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/cita/ultima', authenticateMixed, async (req, res) => {
  const params = { select: '*', order: 'fecha_notificacion.desc', limit: '1' };
  if (!req.esAdmin) params.android_id = `eq.${req.device_android_id}`;
  const c = await supabaseQuery('citas_notificadas', { params });
  res.json({ success: true, data: c[0] || null });
});

app.get('/api/citas/notificadas', authenticateMixed, async (req, res) => {
  const params = { select: '*', order: 'fecha_notificacion.desc', limit: (req.query.limite || '10').toString() };
  if (!req.esAdmin) params.android_id = `eq.${req.device_android_id}`;
  res.json({ success: true, data: await supabaseQuery('citas_notificadas', { params }) });
});

app.patch('/api/citas/:id', authenticateMixed, express.json(), async (req, res) => {
  if (!req.esAdmin) return res.status(403).json({ error: 'Solo admin' });
  const { estado, notas_admin } = req.body;
  const updates = {};
  if (estado) updates.estado = estado;
  if (notas_admin !== undefined) updates.notas_admin = notas_admin;
  res.json({ success: true, data: (await supabaseQuery(`citas_notificadas?id=eq.${req.params.id}`, { method: 'PATCH', body: updates }))[0] });
});

app.delete('/api/citas/:id', authenticateMixed, async (req, res) => {
  if (!req.esAdmin) return res.status(403).json({ error: 'Solo admin' });
  await supabaseQuery(`citas_notificadas?id=eq.${req.params.id}`, { method: 'DELETE' });
  res.json({ success: true });
});

app.get('/api/citas/exportar-csv', authenticateMixed, async (req, res) => {
  if (!req.esAdmin) return res.status(403).json({ error: 'Solo admin' });
  const citas = await supabaseQuery('citas_notificadas', { params: { select: '*', order: 'fecha_notificacion.desc', limit: '10000' } });
  const csv = 'ID,Justificante,Titular,NIE,Fecha,Hora,Oficina,Provincia,Teléfono,Email,Estado\n' + citas.map(c => [c.id, `"${c.justificante}"`, `"${c.titular}"`, c.nie, c.fecha_cita, c.hora_cita, `"${c.oficina}"`, `"${c.provincia}"`, c.telefono, c.email, c.estado].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=citas_${new Date().toISOString().split('T')[0]}.csv`);
  res.send(csv);
});

// ==========================================
// ✅ AUTO-COMPLETAR CITAS
// ==========================================
setInterval(async () => {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/citas_notificadas?estado=eq.pendiente&fecha_cita=lt.${hoy}&limit=50`, { headers: { 'apikey': process.env.SUPABASE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_KEY}` } });
    for (const c of await r.json() || []) {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/citas_notificadas?id=eq.${c.id}`, {
        method: 'PATCH',
        headers: { 'apikey': process.env.SUPABASE_KEY, 'Authorization': `Bearer ${process.env.SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ estado: 'completado' }),
      });
    }
  } catch (e) {}
}, 1800000);

// ==========================================
// ✅ ENDPOINTS APP CLIENTE  (antes de las rutas externas)
// ==========================================

// 1. Activar código (login)
app.post('/api/cliente/activar', async (req, res) => {
  try {
    const { codigo, nie } = req.body;

    if (!codigo) {
      return res.status(400).json({ success: false, error: 'codigo requerido' });
    }

    console.log(`🔑 [Cliente] Login con código ${codigo}`);

    // 1. Buscar el código
    const codRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}&select=*`,
      { headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const codigos = await codRes.json();
    const codigoData = codigos?.[0];

    if (!codigoData) {
      return res.json({ success: false, error: 'Código no encontrado' });
    }

    // 2. Rechazar si no está activado por el bot
    if (codigoData.estado === 'disponible') {
      return res.json({
        success: false,
        error: 'Este código aún no ha sido activado. Primero actívalo en la app del bot.',
      });
    }
    if (codigoData.estado === 'expirado') {
      return res.json({ success: false, error: 'Este código está expirado' });
    }
    if (codigoData.fecha_expiracion && new Date(codigoData.fecha_expiracion) < new Date()) {
      return res.json({ success: false, error: 'Este código ha expirado' });
    }
    if (!codigoData.android_id_activado) {
      return res.json({
        success: false,
        error: 'Este código no tiene un dispositivo vinculado. Actívalo primero en la app del bot.',
      });
    }

    // 3. Si no ha enviado NIE → pedirlo
    if (!nie || nie.toString().trim().isEmpty) {
      return res.json({
        success: false,
        error: 'Introduce tu NIE para verificar tu identidad',
        requiere_nie: true,
      });
    }

    // 4. Buscar el usuario vinculado al android_id del código
    const userRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${codigoData.android_id_activado}&select=nie,nombre`,
      { headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const usuario = (await userRes.json())?.[0];

    if (!usuario) {
      return res.json({
        success: false,
        error: 'No hay datos de usuario vinculados a este código. Contacta con tu vendedor.',
      });
    }

    if (!usuario.nie) {
      return res.json({
        success: false,
        error: 'Este código no tiene un NIE registrado. Contacta con tu vendedor.',
      });
    }

    // 5. Comparar NIE (normalizado)
    const nieInput = nie.toString().trim().toUpperCase();
    const nieGuardado = usuario.nie.toString().trim().toUpperCase();

    if (nieInput !== nieGuardado) {
      console.log(`❌ [Cliente] NIE incorrecto para ${codigo}: input=${nieInput} guardado=${nieGuardado}`);
      return res.json({
        success: false,
        error: 'El NIE no coincide con el titular del código',
        nie_incorrecto: true,
      });
    }

    // 6. NIE OK → JWT
    const token = generarJWT({ sub: codigo, codigo, tipo: 'cliente' }, 'cliente');

    console.log(`✅ [Cliente] Login OK: ${codigo} (NIE ${nieInput})`);

    res.json({
      success: true,
      token,
      codigo: codigoData.codigo,
      fecha_expiracion: codigoData.fecha_expiracion,
      nies_usados: codigoData.nies_usados || [],
      max_nies: codigoData.max_nies || 2,
      ampliaciones_compradas: codigoData.ampliaciones_compradas || 0,
    });
  } catch (e) {
    console.error('❌ [Cliente/activar]', e);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});
const loginClienteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Demasiados intentos. Espera 15 min.' },
  standardHeaders: true,
  legacyHeaders: false,
});
// 2. Mis citas
app.get('/api/cliente/mis-citas', authenticateCliente, async (req, res) => {
  try {
    const codigo = req.cliente_codigo;

    // 1. Obtener el android_id vinculado al código
    const codRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}&select=android_id_activado`,
      { headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const codigoData = (await codRes.json())?.[0];
    const androidId = codigoData?.android_id_activado;

    if (!androidId) {
      return res.json({ success: true, data: [], mensaje: 'Código sin dispositivo vinculado' });
    }

    // 2. Buscar las citas de ese android_id
    const citas = await supabaseQuery('citas_notificadas', {
      params: {
        android_id: `eq.${androidId}`,
        select: 'id,justificante,titular,nie,fecha_cita,hora_cita,oficina,provincia,telefono,email,estado,fecha_notificacion',
        order: 'fecha_notificacion.desc',
        limit: '100',
      },
    });

    res.json({ success: true, data: citas });
  } catch (e) {
    console.error('❌ [Cliente/mis-citas]', e);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// 3. Mi código
app.get('/api/cliente/mi-codigo', authenticateCliente, async (req, res) => {
  try {
    const codigo = req.cliente_codigo;
    const codRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}&select=codigo,fecha_uso,fecha_expiracion,nies_usados,max_nies,ampliaciones_compradas`,
      { headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const codigoData = (await codRes.json())?.[0];
    if (!codigoData) return res.json({ success: false, error: 'Código no encontrado' });

    res.json({
      success: true,
      data: {
        codigo: codigoData.codigo,
        fecha_uso: codigoData.fecha_uso,
        fecha_expiracion: codigoData.fecha_expiracion,
        nies_usados: codigoData.nies_usados || [],
        total_nies: (codigoData.nies_usados || []).length,
        max_nies: codigoData.max_nies || 2,
        ampliaciones_compradas: codigoData.ampliaciones_compradas || 0,
        puede_ampliar: (codigoData.ampliaciones_compradas || 0) < 5,
      },
    });
  } catch (e) {
    console.error('❌ [Cliente/mi-codigo]', e);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});
// 4. Mi estado en vivo
app.get('/api/cliente/mi-estado', authenticateCliente, async (req, res) => {
  try {
    const codigo = req.cliente_codigo;

    // 1. Obtener android_id del código
    const codRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}&select=android_id_activado`,
      { headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const codigoData = (await codRes.json())?.[0];
    const androidId = codigoData?.android_id_activado;

    if (!androidId) {
      return res.json({
        success: true,
        data: null,
        vivo: false,
        mensaje: 'Código sin dispositivo vinculado',
      });
    }

    // 2. Buscar el estado en vivo
    const estado = estadosPorDispositivo.get(androidId);

    if (!estado) {
      return res.json({
        success: true,
        data: null,
        vivo: false,
        mensaje: 'El bot no está corriendo ahora mismo',
      });
    }

    const ahora = Date.now();
    const edadMs = ahora - new Date(estado.ultima_actualizacion).getTime();
    const muerto = edadMs > TTL_DISPOSITIVO_MS;

    res.json({
      success: true,
      data: { ...estado, edad_ms: edadMs, muerto },
      vivo: !muerto,
    });
  } catch (e) {
    console.error('❌ [Cliente/mi-estado]', e);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});
// 5. Guardar/actualizar mis datos
app.post('/api/cliente/mis-datos', authenticateCliente, express.json(), async (req, res) => {
  try {
    const codigo = req.cliente_codigo;
    const { nie, nombre, email, telefono, nacionalidad, provincia, telefonoCliente } = req.body;

    if (!nie || !nombre || !email || !telefono || !nacionalidad || !provincia || !telefonoCliente) {
      return res.status(400).json({ success: false, error: 'Faltan campos' });
    }

    // 1. Obtener android_id del código
    const codRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}&select=android_id_activado`,
      { headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const codigoData = (await codRes.json())?.[0];
    const androidId = codigoData?.android_id_activado;

    if (!androidId) {
      return res.status(400).json({ success: false, error: 'Código sin dispositivo vinculado' });
    }

    const datos = {
      android_id: androidId,
      nie, nombre, email, telefono, nacionalidad,
      provincia,
      telefono_cliente: telefonoCliente,
      ultima_conexion: new Date().toISOString(),
    };

    // Upsert
    const existeRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${androidId}&select=android_id`,
      { headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const existe = (await existeRes.json())?.length > 0;

    if (existe) {
      await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${androidId}`,
        {
          method: 'PATCH',
          headers: {
            apikey: process.env.SUPABASE_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify(datos),
        }
      );
    } else {
      await fetch(`${process.env.SUPABASE_URL}/rest/v1/usuarios`, {
        method: 'POST',
        headers: {
          apikey: process.env.SUPABASE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ ...datos, estado: 'activo', fecha_activacion: new Date().toISOString() }),
      });
    }

    res.json({ success: true, message: 'Datos guardados' });
  } catch (e) {
    console.error('❌ [Cliente/mis-datos POST]', e);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});
// 6. Leer mis datos
app.get('/api/cliente/mis-datos', authenticateCliente, async (req, res) => {
  try {
    const codigo = req.cliente_codigo;

    // 1. Obtener android_id del código
    const codRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}&select=android_id_activado`,
      { headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const codigoData = (await codRes.json())?.[0];
    const androidId = codigoData?.android_id_activado;

    if (!androidId) {
      return res.json({ success: true, data: null });
    }

    // 2. Leer datos del usuario vinculado a ese android_id
    const r = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${androidId}&select=nie,nombre,email,telefono,nacionalidad,provincia,telefono_cliente`,
      { headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const data = (await r.json())?.[0] || null;

    res.json({ success: true, data });
  } catch (e) {
    console.error('❌ [Cliente/mis-datos GET]', e);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// 7. Guardar FCM token del cliente
app.post('/api/cliente/fcm-token', authenticateCliente, express.json(), async (req, res) => {
  try {
    const androidId = req.device_android_id;
    const { fcm_token } = req.body;
    if (!fcm_token) return res.status(400).json({ success: false, error: 'fcm_token requerido' });

    await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${androidId}`,
      {
        method: 'PATCH',
        headers: {
          apikey: process.env.SUPABASE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ fcm_token }),
      }
    );

    res.json({ success: true });
  } catch (e) {
    console.error('❌ [Cliente/fcm-token]', e);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// ==========================================
// ✅ RUTAS EXTERNAS
// ==========================================
app.use('/api/supabase', authenticateApiKey, supabaseRoutes);
app.use('/api/captcha', authenticateApiKey, captchaRoutes);
app.use('/api/config', configuracionRoutes);
app.use('/api/notificaciones', authenticateApiKey, notificacionesRoutes);
app.use('/api/vendedores', (req, res, next) => { req.deviceKeys = deviceKeys; next(); }, vendedoresRoutes);

// ==========================================
// 🔧 NUEVO: DESCARGA SEGURA DE LA APP (token firmado)
// ==========================================
const DOWNLOAD_SECRET = process.env.DOWNLOAD_SECRET;
const DOWNLOAD_TOKEN_TTL = parseInt(process.env.DOWNLOAD_TOKEN_TTL || '900000'); // 15 min
const APK_PATH = process.env.APK_PATH || 'downloads/app.apk';

// Endpoint que sirve el APK (con token firmado, caducidad y un solo uso)
app.get('/api/download/:token', rateLimit({ windowMs: 60 * 1000, max: 10 }), (req, res) => {
  try {
    const { token } = req.params;

    if (!DOWNLOAD_SECRET) {
      console.error('❌ [DOWNLOAD] DOWNLOAD_SECRET no configurado');
      return res.status(500).json({ error: 'Servicio no configurado' });
    }

    const [payloadB64, firma] = token.split('.');
    if (!payloadB64 || !firma) {
      return res.status(400).json({ error: 'Token inválido' });
    }

    // Verificar firma HMAC
    const expected = crypto
      .createHmac('sha256', DOWNLOAD_SECRET)
      .update(payloadB64)
      .digest('base64url');

    if (expected !== firma) {
      console.log('❌ [DOWNLOAD] Firma inválida');
      return res.status(403).json({ error: 'Token inválido o manipulado' });
    }

    // Decodificar payload
    let payload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Token corrupto' });
    }

    // Verificar caducidad
    if (Date.now() > payload.exp) {
      console.log(`⏰ [DOWNLOAD] Token expirado para user ${payload.uid}`);
      return res.status(410).json({ error: 'Enlace expirado. Pide uno nuevo con /descargar' });
    }

    // Verificar un solo uso
    const data = downloadTokens.get(token);
    if (!data || data.usado) {
      console.log(`⚠️ [DOWNLOAD] Token ya usado o no registrado: ${token.slice(0, 20)}...`);
      return res.status(410).json({ error: 'Este enlace ya se ha usado. Pide uno nuevo con /descargar' });
    }
    data.usado = true;

    // Servir el APK
    const filePath = path.join(__dirname, APK_PATH);
    if (!fs.existsSync(filePath)) {
      console.error(`❌ [DOWNLOAD] APK no encontrado en: ${filePath}`);
      return res.status(404).json({ error: 'APK no disponible' });
    }

    console.log(`✅ [DOWNLOAD] Sirviendo APK a user ${payload.uid}`);

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="cita-previa.apk"');
    res.setHeader('Cache-Control', 'no-store');

    res.sendFile(filePath);
  } catch (e) {
    console.error('❌ [DOWNLOAD] Error:', e);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Endpoint interno para que el bot registre el token recién creado (un solo uso)
app.post('/api/download/register', authenticateApiKey, express.json(), (req, res) => {
  const { token, exp, uid } = req.body;
  if (!token || !exp) return res.status(400).json({ error: 'Faltan datos' });
  downloadTokens.set(token, { usado: false, expira: exp, user_id: uid });
  console.log(`📝 [DOWNLOAD] Token registrado para user ${uid} (expira en ${Math.round((exp - Date.now()) / 1000)}s)`);
  res.json({ success: true });
});

// ==========================================
// ✅ ROOT / FALLBACKS  (SIEMPRE AL FINAL)
// ==========================================
app.get('/', (req, res) => res.json({ status: 'online', version: '6.0.1', emails: 'Resend Premium', timestamp: new Date().toISOString() }));
app.use((err, req, res, next) => res.status(500).json({ error: 'Error interno' }));
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// ==========================================
// 🚀 LISTEN
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor ${PORT} | 📧 Emails Premium ACTIVADO | 🎯 MAX_NIES=${MAX_NIES}`);

  // 💓 Keep-alive para Render (evita que el servicio gratuito se duerma)
  if (SELF_URL && SELF_URL.startsWith('http')) {
    const dynoWaker = wokeDyno(SELF_URL);
    dynoWaker.start();
    console.log(`💓 Woke-dyno iniciado, ping a: ${SELF_URL}`);
  } else {
    console.warn('⚠️ SELF_URL no válida, woke-dyno no iniciado:', SELF_URL);
  }
});