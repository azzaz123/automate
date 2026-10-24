const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const Stripe = require('stripe');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const VENDEDOR_BOT = '00000000-0000-0000-0000-0000000000b0';
const PRECIO_CODIGO = 25.00;
const DURACION_DIAS = 90;

const getSupabaseHeaders = () => ({
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
});

// ─── Auth ───
function authApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    console.log('❌ [AUTH] Falta la API Key');
    return res.status(401).json({ error: 'API Key requerida' });
  }
  if (apiKey !== process.env.API_KEY) {
    console.log('❌ [AUTH] API Key inválida');
    return res.status(401).json({ error: 'API Key inválida' });
  }
  next();
}

// ─── Helpers ───
function generarCodigo() {
  return `${Math.floor(1000000000 + Math.random() * 9000000000)}`;
}

// ═══════════════════════════════════════════════
// POST /api/bot/comprar-codigo
// ═══════════════════════════════════════════════
router.post('/comprar-codigo', authApiKey, express.json(), async (req, res) => {
  try {
    const { user_id, username, email } = req.body;
    if (!user_id) {
      console.log('❌ [COMPRA] Falta user_id');
      return res.status(400).json({ error: 'user_id requerido' });
    }

    console.log(`\n💳 [COMPRA] Iniciando compra para user_id: ${user_id} (${username || 'sin nombre'})`);

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'Código Premium - 3 meses',
              description: 'Código de activación válido por 90 días para 2 NIEs',
            },
            unit_amount: PRECIO_CODIGO * 100,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=pago_ok`,
      cancel_url: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=pago_cancel`,
      customer_email: email || undefined,
      metadata: {
        user_id: String(user_id),
        username: username || '',
        tipo: 'compra_codigo_bot',
      },
    });

    console.log(`   ✅ [COMPRA] Sesión de Stripe creada: ${session.id}`);
    console.log(`   🔗 [COMPRA] URL de pago: ${session.url}`);

    const guardarRes = await fetch(`${SUPABASE_URL}/rest/v1/compras_bot`, {
      method: 'POST',
      headers: { ...getSupabaseHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        user_id: String(user_id),
        username: username || '',
        codigo: `PENDIENTE_${session.id}`,
        entregado: false,
        stripe_session_id: session.id,
        precio: PRECIO_CODIGO,
        email: email || null,
      }),
    });

    if (!guardarRes.ok) {
      console.log(`   ⚠️ [COMPRA] Error guardando en Supabase: ${await guardarRes.text()}`);
    } else {
      console.log(`   💾 [COMPRA] Registro guardado en Supabase`);
    }

    res.json({
      success: true,
      checkout_url: session.url,
      session_id: session.id,
    });
  } catch (error) {
    console.error('❌ [COMPRA] Error creando checkout:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════
router.post('/bot/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('\n========================================');
  console.log('🚨 [WEBHOOK] ¡Petición recibida de Stripe!');
  
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET_BOT;

    console.log('   [WEBHOOK] Stripe Signature:', sig ? 'SÍ' : 'NO');
    console.log('   [WEBHOOK] Secret configurado:', webhookSecret ? 'SÍ' : 'NO');

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret, 600); 
      console.log('   ✅ [WEBHOOK] Firma verificada.');
      console.log('   📦 [WEBHOOK] Tipo de evento:', event.type);
    } catch (err) {
      console.error('   ❌ [WEBHOOK] ERROR DE FIRMA:', err.message);
      return res.status(200).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed' || event.type === 'v1.checkout.session.completed') {
      
      let sessionId = null;
      if (event.data && event.data.object && event.data.object.id) {
        sessionId = event.data.object.id;
      } else if (event.related_object && event.related_object.id) {
        sessionId = event.related_object.id;
      }

      if (!sessionId) {
        console.error('   ❌ [WEBHOOK] No se encontró el sessionId en el evento.');
        return res.status(200).send('No session ID');
      }

      console.log(`   🔍 [WEBHOOK] Procesando sesión de pago: ${sessionId}`);

      // Buscar compra en Supabase
      const compraRes = await fetch(
        `${SUPABASE_URL}/rest/v1/compras_bot?stripe_session_id=eq.${sessionId}&select=*`,
        { headers: getSupabaseHeaders() }
      );
      const compras = await compraRes.json();
      
      if (!compras || compras.length === 0) {
        console.error(`   ❌ [WEBHOOK] Compra NO encontrada en Supabase para la sesión: ${sessionId}`);
        return res.status(200).send('Compra no encontrada');
      }

      const compra = compras[0];
      const userId = compra.user_id;
      const username = compra.username;
      
      console.log(`   ✅ [WEBHOOK] Compra encontrada. UserId: ${userId} (${username})`);

      // Generar código
      let codigoNuevo;
      let intentos = 0;
      while (intentos < 5) {
        codigoNuevo = generarCodigo();
        const checkRes = await fetch(
          `${SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigoNuevo}&select=id`,
          { headers: getSupabaseHeaders() }
        );
        const existentes = await checkRes.json();
        if (!existentes || existentes.length === 0) break;
        intentos++;
      }

      // Insertar código
      console.log(`   💾 [WEBHOOK] Insertando código ${codigoNuevo} en Supabase...`);
      const insertCodigo = await fetch(`${SUPABASE_URL}/rest/v1/codigos_activacion`, {
        method: 'POST',
        headers: { ...getSupabaseHeaders(), 'Prefer': 'return=minimal' },
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
          telefono_bot: `tg_${userId}`,
          fecha_envio_bot: new Date().toISOString(),
          stripe_session_id: sessionId,
          stripe_payment_status: 'completed',
        }),
      });

      if (insertCodigo.status !== 201) {
        console.error(`   ❌ [WEBHOOK] Error insertando código en Supabase: ${await insertCodigo.text()}`);
        return res.status(200).send('Error guardando código');
      }

      console.log(`   ✅ [WEBHOOK] Código ${codigoNuevo} guardado en Supabase.`);

      // Actualizar compra
      await fetch(
        `${SUPABASE_URL}/rest/v1/compras_bot?stripe_session_id=eq.${sessionId}`,
        {
          method: 'PATCH',
          headers: { ...getSupabaseHeaders(), 'Prefer': 'return=minimal' },
          body: JSON.stringify({ codigo: codigoNuevo }),
        }
      );

      console.log(`   🎁 [WEBHOOK] Código generado exitosamente: ${codigoNuevo}`);

      // ==========================================
      // NOTIFICAR AL BOT DE TELEGRAM
      // ==========================================
      const botUrl = `${process.env.TELEGRAM_BOT_INTERNAL_URL || 'http://localhost:8080'}/api/notify-codigo`;
      
      console.log(`\n🚀 [CONEXIÓN BOT] Intentando avisar al bot en: ${botUrl}`);
      console.log(`🚀 [CONEXIÓN BOT] Payload: { user_id: "${userId}", codigo: "${codigoNuevo}" }`);

      try {
        const botRes = await fetch(botUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.API_KEY,
          },
          body: JSON.stringify({ user_id: userId, codigo: codigoNuevo }),
        });
        
        console.log(`✅ [CONEXIÓN BOT] Status HTTP: ${botRes.status}`);
        const botText = await botRes.text();
        console.log(`✅ [CONEXIÓN BOT] Respuesta del bot: ${botText}`);
        
      } catch (e) {
        console.error(`❌ [CONEXIÓN BOT] ERROR CRÍTICO: No se pudo conectar al bot.`);
        console.error(`❌ [CONEXIÓN BOT] Motivo: ${e.message}`);
        console.error(`❌ [CONEXIÓN BOT] ¿El bot está en el puerto 8080 y accesible desde el Server 2?`);
      }
    } else {
      console.log(`   ⚠️ [WEBHOOK] Evento ignorado: ${event.type}`);
    }

    console.log('========================================\n');
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('❌ [WEBHOOK] Error fatal:', error);
    res.status(200).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════
// GET /api/bot/mis-compras/:user_id
// ═══════════════════════════════════════════════
router.get('/mis-compras/:userId', authApiKey, async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`🔍 [MIS-COMPRAS] Buscando compras de: ${userId}`);

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/compras_bot?user_id=eq.${userId}&codigo=not.like.PENDIENTE_*&select=*&order=creado_en.desc`,
      { headers: getSupabaseHeaders() }
    );
    const compras = await response.json();

    console.log(`   ✅ [MIS-COMPRAS] Encontradas ${compras.length} compras.`);
    res.json({
      success: true,
      compras: Array.isArray(compras) ? compras : [],
    });
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
    console.log(`📦 [ENTREGAR] Marcando código ${codigo} como entregado a ${userId}`);

    await fetch(
      `${SUPABASE_URL}/rest/v1/compras_bot?user_id=eq.${userId}&codigo=eq.${codigo}`,
      {
        method: 'PATCH',
        headers: { ...getSupabaseHeaders(), 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          entregado: true,
          entregado_en: new Date().toISOString(),
        }),
      }
    );

    res.json({ success: true });
  } catch (error) {
    console.error('❌ [ENTREGAR] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════
// GET /api/bot/stats
// ═══════════════════════════════════════════════
router.get('/stats', authApiKey, async (req, res) => {
  try {
    const hoy = new Date().toISOString().split('T')[0];

    const todasRes = await fetch(
      `${SUPABASE_URL}/rest/v1/compras_bot?select=id,precio,entregado,creado_en&codigo=not.like.PENDIENTE_*`,
      { headers: getSupabaseHeaders() }
    );
    const todas = await todasRes.json();

    const hoyRes = await fetch(
      `${SUPABASE_URL}/rest/v1/compras_bot?select=id,precio&creado_en=gte.${hoy}T00:00:00Z&codigo=not.like.PENDIENTE_*`,
      { headers: getSupabaseHeaders() }
    );
    const deHoy = await hoyRes.json();

    const totalIngresos = (Array.isArray(todas) ? todas : []).reduce(
      (sum, c) => sum + parseFloat(c.precio || 0), 0
    );
    const ingresosHoy = (Array.isArray(deHoy) ? deHoy : []).reduce(
      (sum, c) => sum + parseFloat(c.precio || 0), 0
    );

    res.json({
      success: true,
      total_compras: (Array.isArray(todas) ? todas.length : 0),
      total_ingresos: totalIngresos.toFixed(2),
      compras_hoy: (Array.isArray(deHoy) ? deHoy.length : 0),
      ingresos_hoy: ingresosHoy.toFixed(2),
      pendientes_entrega: (Array.isArray(todas) ? todas : []).filter(c => !c.entregado).length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;