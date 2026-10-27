const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const VENDEDOR_BOT = '00000000-0000-0000-0000-0000000000b0';
const PRECIO_CODIGO = 25.0;
const PRECIO_STARS = parseInt(process.env.PRECIO_STARS || '150', 10);
const STARS_CURRENCY = 'XTR';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const getSupabaseHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
});

// ─── Auth ───
function authApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API Key requerida' });
  if (apiKey !== process.env.API_KEY) return res.status(401).json({ error: 'API Key inválida' });
  next();
}

// ─── Helpers ───
function generarCodigo() {
  // crypto.randomInt: criptográficamente seguro
  return String(crypto.randomInt(1000000000, 10000000000));
}

async function supabaseFetch(url, options = {}) {
  const res = await fetch(url, options);
  return res;
}

// ═══════════════════════════════════════════════
// ⭐ STARS: guardar compra pending
// ═══════════════════════════════════════════════
router.post('/stars/pending', authApiKey, express.json(), async (req, res) => {
  try {
    const { payload, user_id, username, amount_stars } = req.body;

    if (!payload || !user_id || amount_stars === undefined || amount_stars === null) {
      return res.status(400).json({ error: 'Faltan datos' });
    }

    if (!UUID_V4.test(String(payload))) {
      return res.status(400).json({ error: 'payload inválido' });
    }

    // El precio lo fija el backend, NO el bot
    const amount = parseInt(amount_stars, 10);
    if (amount !== PRECIO_STARS) {
      return res.status(400).json({ error: 'amount_stars inválido' });
    }

    const r = await fetch(`${SUPABASE_URL}/rest/v1/compras_stars`, {
      method: 'POST',
      headers: { ...getSupabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        payload,
        user_id: String(user_id),
        username: username || '',
        amount_stars: amount,
        estado: 'pending',
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('❌ [STARS/pending] Error Supabase:', errText);
      return res.status(500).json({ error: 'Error guardando compra' });
    }

    console.log(`⭐ [STARS/pending] Compra pending guardada: ${payload}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ [STARS/pending] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════
// ⭐ STARS: verificar pending (para pre_checkout_query)
// Valida que el payload exista, esté pending Y pertenezca al user_id.
// ═══════════════════════════════════════════════
router.get('/stars/verificar-pending', authApiKey, async (req, res) => {
  try {
    const { payload, user_id } = req.query;
    if (!payload || !user_id) return res.status(400).json({ valido: false });
    if (!UUID_V4.test(String(payload))) return res.status(400).json({ valido: false });

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/compras_stars?payload=eq.${encodeURIComponent(payload)}&select=id,estado,user_id,amount_stars`,
      { headers: getSupabaseHeaders() }
    );
    const rows = await r.json();
    const row = rows?.[0];

    if (!row || row.estado !== 'pending') return res.json({ valido: false });

    // 🔴 CRÍTICO: el pagador debe ser el dueño del pending
    if (String(row.user_id) !== String(user_id)) {
      console.warn(`⚠️ [STARS/verificar-pending] user_id no coincide: ${row.user_id} vs ${user_id}`);
      return res.json({ valido: false });
    }

    // También validamos que el amount guardado sea el correcto
    if (parseInt(row.amount_stars, 10) !== PRECIO_STARS) {
      console.warn(`⚠️ [STARS/verificar-pending] amount_stars corrupto: ${row.amount_stars}`);
      return res.json({ valido: false });
    }

    res.json({ valido: true, user_id: row.user_id, amount_stars: row.amount_stars });
  } catch (err) {
    console.error('❌ [STARS/verificar-pending] Error:', err);
    res.status(500).json({ valido: false });
  }
});

// ═══════════════════════════════════════════════
// ⭐ STARS: procesar pago (en successful_payment)
// Idempotente por charge_id. Recupera reintentos si estado=paid sin codigo.
// ═══════════════════════════════════════════════
router.post('/stars/procesar-pago', authApiKey, express.json(), async (req, res) => {
  try {
    const { payload, user_id, charge_id, amount, currency } = req.body;

    if (!payload || !user_id || !charge_id) {
      return res.status(400).json({ success: false, error: 'Faltan datos' });
    }
    if (!UUID_V4.test(String(payload))) {
      return res.status(400).json({ success: false, error: 'payload inválido' });
    }
    if (currency && currency !== STARS_CURRENCY) {
      return res.status(400).json({ success: false, error: 'Moneda inválida' });
    }

    // 1. Leer la compra
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/compras_stars?payload=eq.${encodeURIComponent(payload)}&select=*`,
      { headers: getSupabaseHeaders() }
    );
    const rows = await checkRes.json();
    const compra = rows?.[0];

    if (!compra) {
      console.error(`❌ [STARS/procesar] Compra no encontrada: ${payload}`);
      return res.status(404).json({ success: false, error: 'Compra no encontrada' });
    }

    // 2. Validaciones de identidad/importe
    if (String(compra.user_id) !== String(user_id)) {
      console.error(`❌ [STARS/procesar] user_id no coincide: ${compra.user_id} vs ${user_id}`);
      return res.status(403).json({ success: false, error: 'user_id no coincide' });
    }
    if (parseInt(compra.amount_stars, 10) !== PRECIO_STARS || parseInt(amount, 10) !== PRECIO_STARS) {
      console.error(`❌ [STARS/procesar] amount no coincide: compra=${compra.amount_stars} body=${amount}`);
      return res.status(403).json({ success: false, error: 'amount no coincide' });
    }

    // 3. Idempotencia
    if (compra.estado === 'entregado' && compra.codigo) {
      // Reenvío legítimo: devolvemos el mismo código
      return res.json({ success: true, codigo: compra.codigo, idempotente: true });
    }

    if (compra.estado === 'paid') {
      // Reintento tras fallo a medias. Solo si el charge_id coincide.
      if (compra.telegram_payment_charge_id && compra.telegram_payment_charge_id !== charge_id) {
        console.error(
          `❌ [STARS/procesar] charge_id distinto para estado=paid: ${compra.telegram_payment_charge_id} vs ${charge_id}`
        );
        return res.status(409).json({ success: false, error: 'Compra ya procesada', estado: compra.estado });
      }
      // Si no hay codigo, seguimos hacia la generación (recuperación)
      console.warn(`⚠️ [STARS/procesar] Recuperando compra en estado=paid sin código: ${payload}`);
    } else if (compra.estado !== 'pending') {
      console.error(`❌ [STARS/procesar] Estado no procesable: ${compra.estado} (${payload})`);
      return res.status(409).json({ success: false, error: 'Compra ya procesada', estado: compra.estado });
    }

    // 4. Marcar paid (atómico: solo si estado=pending)
    if (compra.estado === 'pending') {
      const markPaid = await fetch(
        `${SUPABASE_URL}/rest/v1/compras_stars?payload=eq.${encodeURIComponent(payload)}&estado=eq.pending`,
        {
          method: 'PATCH',
          headers: { ...getSupabaseHeaders(), Prefer: 'return=representation' },
          body: JSON.stringify({
            estado: 'paid',
            telegram_payment_charge_id: charge_id,
            paid_at: new Date().toISOString(),
          }),
        }
      );
      const patched = await markPaid.json();
      if (!patched || patched.length === 0) {
        // Race: otro proceso lo marcó antes
        console.warn(`⚠️ [STARS/procesar] Race condition detectada para ${payload}`);
        // Releer para ver si ya hay código
        const re = await fetch(
          `${SUPABASE_URL}/rest/v1/compras_stars?payload=eq.${encodeURIComponent(payload)}&select=estado,codigo`,
          { headers: getSupabaseHeaders() }
        );
        const reRows = await re.json();
        const reRow = reRows?.[0];
        if (reRow?.estado === 'entregado' && reRow.codigo) {
          return res.json({ success: true, codigo: reRow.codigo, idempotente: true });
        }
        return res.status(409).json({ success: false, error: 'Compra ya procesada' });
      }
      console.log(`✅ [STARS/procesar] Compra marcada como paid: ${payload}`);
    } else {
      // estado=paid sin codigo: aseguramos charge_id consistente (no sobreescribimos si ya existe distinto)
      if (!compra.telegram_payment_charge_id) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/compras_stars?payload=eq.${encodeURIComponent(payload)}`,
          {
            method: 'PATCH',
            headers: { ...getSupabaseHeaders(), Prefer: 'return=minimal' },
            body: JSON.stringify({ telegram_payment_charge_id: charge_id }),
          }
        );
      }
    }

    // 5. Generar código único
    let codigoNuevo = null;
    for (let intentos = 0; intentos < 5; intentos++) {
      const candidato = generarCodigo();
      const checkCod = await fetch(
        `${SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${candidato}&select=id`,
        { headers: getSupabaseHeaders() }
      );
      const existentes = await checkCod.json();
      if (!existentes || existentes.length === 0) {
        codigoNuevo = candidato;
        break;
      }
    }
    if (!codigoNuevo) {
      console.error(`❌ [STARS/procesar] No se pudo generar código único para ${payload}`);
      await fetch(`${SUPABASE_URL}/rest/v1/compras_stars?payload=eq.${encodeURIComponent(payload)}`, {
        method: 'PATCH',
        headers: { ...getSupabaseHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify({ estado: 'error' }),
      });
      return res.status(500).json({ success: false, error: 'Error generando código' });
    }

    // 6. Insertar en codigos_activacion
    const insertCodigo = await fetch(`${SUPABASE_URL}/rest/v1/codigos_activacion`, {
      method: 'POST',
      headers: { ...getSupabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        codigo: codigoNuevo,
        vendedor_id: VENDEDOR_BOT,
        estado: 'disponible',
        precio_compra: PRECIO_CODIGO,
        fecha_compra: new Date().toISOString(),
        fecha_expiracion: null,
        max_nies: 2,
        ampliaciones_compradas: 0,
        nies_usados: [],
        telefono_bot: `tg_${compra.user_id}`,
        fecha_envio_bot: new Date().toISOString(),
        stripe_session_id: null,
        stripe_payment_status: 'stars_completed',
        stars_payload: payload,
        stars_charge_id: charge_id,
      }),
    });

    if (!insertCodigo.ok) {
      const errText = await insertCodigo.text();
      console.error(`❌ [STARS/procesar] Error insertando código: ${errText}`);
      await fetch(`${SUPABASE_URL}/rest/v1/compras_stars?payload=eq.${encodeURIComponent(payload)}`, {
        method: 'PATCH',
        headers: { ...getSupabaseHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify({ estado: 'error' }),
      });
      return res.status(500).json({ success: false, error: 'Error guardando código' });
    }

    // 7. Marcar entregado
    await fetch(`${SUPABASE_URL}/rest/v1/compras_stars?payload=eq.${encodeURIComponent(payload)}`, {
      method: 'PATCH',
      headers: { ...getSupabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        estado: 'entregado',
        codigo: codigoNuevo,
        entregado_at: new Date().toISOString(),
      }),
    });

    console.log(`🎁 [STARS/procesar] Compra entregada: ${payload} → ${codigoNuevo}`);
    res.json({ success: true, codigo: codigoNuevo });
  } catch (err) {
    console.error('❌ [STARS/procesar] Error fatal:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════
// GET /api/bot/mis-compras/:user_id
// Une compras_bot (legacy Stripe) + compras_stars (actual)
// ═══════════════════════════════════════════════
router.get('/mis-compras/:userId', authApiKey, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ success: false, error: 'userId requerido' });

    console.log(`🔍 [MIS-COMPRAS] Buscando compras de: ${userId}`);

    const [botRes, starsRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/compras_bot?user_id=eq.${encodeURIComponent(userId)}&codigo=not.like.PENDIENTE_*&select=codigo,entregado,creado_en&order=creado_en.desc`,
        { headers: getSupabaseHeaders() }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/compras_stars?user_id=eq.${encodeURIComponent(userId)}&estado=eq.entregado&select=codigo,entregado_at,paid_at&order=paid_at.desc`,
        { headers: getSupabaseHeaders() }
      ),
    ]);

    const comprasBot = await botRes.json().catch(() => []);
    const comprasStars = await starsRes.json().catch(() => []);

    const normalizadas = [
      ...(Array.isArray(comprasBot) ? comprasBot : []).map((c) => ({
        codigo: c.codigo,
        entregado: !!c.entregado,
        creado_en: c.creado_en,
        origen: 'stripe',
      })),
      ...(Array.isArray(comprasStars) ? comprasStars : [])
        .filter((c) => !!c.codigo)
        .map((c) => ({
          codigo: c.codigo,
          entregado: true,
          creado_en: c.entregado_at || c.paid_at,
          origen: 'stars',
        })),
    ].sort((a, b) => new Date(b.creado_en || 0) - new Date(a.creado_en || 0));

    console.log(`   ✅ [MIS-COMPRAS] Encontradas ${normalizadas.length} compras.`);
    res.json({ success: true, compras: normalizadas });
  } catch (error) {
    console.error('❌ [MIS-COMPRAS] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════
// POST /api/bot/entregar/:user_id
// ═══════════════════════════════════════════════
router.post('/entregar/:userId', authApiKey, express.json(), async (req, res) => {
  try {
    const { userId } = req.params;
    const { codigo } = req.body;
    if (!userId || !codigo) return res.status(400).json({ success: false, error: 'Datos incompletos' });

    console.log(`📦 [ENTREGAR] Marcando código ${codigo} como entregado a ${userId}`);

    // Intentar marcar en compras_bot (legacy) Y en compras_stars (si existe ahí)
    const [rBot, rStars] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/compras_bot?user_id=eq.${encodeURIComponent(userId)}&codigo=eq.${encodeURIComponent(codigo)}`,
        {
          method: 'PATCH',
          headers: { ...getSupabaseHeaders(), Prefer: 'return=representation' },
          body: JSON.stringify({ entregado: true, entregado_en: new Date().toISOString() }),
        }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/compras_stars?user_id=eq.${encodeURIComponent(userId)}&codigo=eq.${encodeURIComponent(codigo)}`,
        {
          method: 'PATCH',
          headers: { ...getSupabaseHeaders(), Prefer: 'return=representation' },
          body: JSON.stringify({ estado: 'entregado', entregado_at: new Date().toISOString() }),
        }
      ),
    ]);

    const botRows = await rBot.json().catch(() => []);
    const starsRows = await rStars.json().catch(() => []);

    const afectadas = (Array.isArray(botRows) ? botRows.length : 0) + (Array.isArray(starsRows) ? starsRows.length : 0);
    if (afectadas === 0) {
      console.warn(`⚠️ [ENTREGAR] No se actualizó ninguna fila para user=${userId} codigo=${codigo}`);
    }

    res.json({ success: true, actualizadas: afectadas });
  } catch (error) {
    console.error('❌ [ENTREGAR] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════
// GET /api/bot/stats
// Une compras_bot + compras_stars
// ═══════════════════════════════════════════════
router.get('/stats', authApiKey, async (req, res) => {
  try {
    const hoy = new Date().toISOString().split('T')[0];

    const [todasBotRes, hoyBotRes, todasStarsRes, hoyStarsRes] = await Promise.all([
      fetch(
        `${SUPABASE_URL}/rest/v1/compras_bot?select=id,precio,entregado,creado_en&codigo=not.like.PENDIENTE_*`,
        { headers: getSupabaseHeaders() }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/compras_bot?select=id,precio&creado_en=gte.${hoy}T00:00:00Z&codigo=not.like.PENDIENTE_*`,
        { headers: getSupabaseHeaders() }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/compras_stars?estado=eq.entregado&select=id,amount_stars,entregado_at,paid_at`,
        { headers: getSupabaseHeaders() }
      ),
      fetch(
        `${SUPABASE_URL}/rest/v1/compras_stars?estado=eq.entregado&paid_at=gte.${hoy}T00:00:00Z&select=id,amount_stars`,
        { headers: getSupabaseHeaders() }
      ),
    ]);

    const todasBot = await todasBotRes.json().catch(() => []);
    const deHoyBot = await hoyBotRes.json().catch(() => []);
    const todasStars = await todasStarsRes.json().catch(() => []);
    const deHoyStars = await hoyStarsRes.json().catch(() => []);

    // Para Stars, cada compra entregada equivale a PRECIO_CODIGO en EUR (precio de venta)
    const ingresosBotTotal = (Array.isArray(todasBot) ? todasBot : []).reduce(
      (sum, c) => sum + parseFloat(c.precio || 0),
      0
    );
    const ingresosBotHoy = (Array.isArray(deHoyBot) ? deHoyBot : []).reduce(
      (sum, c) => sum + parseFloat(c.precio || 0),
      0
    );
    const ingresosStarsTotal = (Array.isArray(todasStars) ? todasStars : []).length * PRECIO_CODIGO;
    const ingresosStarsHoy = (Array.isArray(deHoyStars) ? deHoyStars : []).length * PRECIO_CODIGO;

    res.json({
      success: true,
      total_compras: (Array.isArray(todasBot) ? todasBot.length : 0) + (Array.isArray(todasStars) ? todasStars.length : 0),
      total_ingresos: (ingresosBotTotal + ingresosStarsTotal).toFixed(2),
      compras_hoy: (Array.isArray(deHoyBot) ? deHoyBot.length : 0) + (Array.isArray(deHoyStars) ? deHoyStars.length : 0),
      ingresos_hoy: (ingresosBotHoy + ingresosStarsHoy).toFixed(2),
      pendientes_entrega: (Array.isArray(todasBot) ? todasBot : []).filter((c) => !c.entregado).length,
      desglose: {
        stripe_legacy: {
          compras: (Array.isArray(todasBot) ? todasBot.length : 0),
          ingresos: ingresosBotTotal.toFixed(2),
        },
        stars: {
          compras: (Array.isArray(todasStars) ? todasStars.length : 0),
          ingresos: ingresosStarsTotal.toFixed(2),
        },
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;