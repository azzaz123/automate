const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secreto-cambiar-en-produccion';
const SALT_ROUNDS = 10;
const JWT_EXPIRES_IN = '7d';
const PRECIO_CODIGO = parseFloat(process.env.PRECIO_CODIGO || '15.00');
const DURACION_DIAS = parseInt(process.env.DURACION_DIAS || '90');

const getSupabaseHeaders = () => ({
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
});

// ==========================================
// HELPERS
// ==========================================

// ✅ Calcula la fecha de expiración (base + N días desde .env)
function calcularFechaExpiracion(fechaBase = new Date()) {
    const fecha = new Date(fechaBase);
    fecha.setDate(fecha.getDate() + DURACION_DIAS);
    return fecha.toISOString();
}

// ✅ Meses aproximados para textos
function mesesAproximados() {
    return Math.round(DURACION_DIAS / 30);
}

// ==========================================
// FUNCIONES DE SEGURIDAD
// ==========================================

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
           req.ip || 'unknown';
}

function getUserAgent(req) {
    return req.headers['user-agent'] || 'unknown';
}

function generarJWT(payload) {
    return jwt.sign(
        { ...payload, jti: crypto.randomBytes(16).toString('hex') },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

function verificarJWT(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return null;
    }
}

async function registrarLog(tipo, usuarioId, usuarioTipo, descripcion, resultado, detalles = {}) {
    try {
        await fetch(`${SUPABASE_URL}/rest/v1/rpc/registrar_log`, {
            method: 'POST',
            headers: getSupabaseHeaders(),
            body: JSON.stringify({
                p_tipo: tipo,
                p_usuario_id: usuarioId,
                p_usuario_tipo: usuarioTipo,
                p_descripcion: descripcion,
                p_resultado: resultado,
                p_detalles: detalles
            })
        });
    } catch (error) {
        console.error('⚠️ Error registrando log:', error.message);
    }
}

// ==========================================
// MIDDLEWARE DE AUTENTICACIÓN JWT
// ==========================================

const authJWT = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
    
    if (!token) {
        await registrarLog('auth_fallido', 'unknown', 'vendedor', 
            'Intento de acceso sin token', 'rechazado',
            { ip: getClientIP(req), motivo: 'Token no proporcionado' });
        return res.status(401).json({ error: 'Token requerido' });
    }
    
    const decoded = verificarJWT(token);
    if (!decoded) {
        await registrarLog('auth_fallido', 'unknown', 'vendedor',
            'Token inválido o expirado', 'rechazado',
            { ip: getClientIP(req), motivo: 'Token inválido' });
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
    
    const response = await fetch(
        `${SUPABASE_URL}/rest/v1/vendedores?email=eq.${decoded.email}&select=*`,
        { headers: getSupabaseHeaders() }
    );
    
    const vendedores = await response.json();
    const vendedor = vendedores?.[0];
    
    if (!vendedor || vendedor.estado !== 'activo' || vendedor.cuenta_cerrada) {
        await registrarLog('auth_fallido', decoded.email, 'vendedor',
            'Vendedor no activo o cuenta cerrada', 'rechazado');
        return res.status(401).json({ error: 'Cuenta no activa' });
    }
    
    req.vendedor = vendedor;
    req.jwt_payload = decoded;
    
    await fetch(
        `${SUPABASE_URL}/rest/v1/vendedores?id=eq.${vendedor.id}`,
        {
            method: 'PATCH',
            headers: getSupabaseHeaders(),
            body: JSON.stringify({ ultima_conexion: new Date().toISOString() })
        }
    );
    
    next();
};

const authAdmin = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    
    if (apiKey === process.env.API_KEY) {
        return next();
    }
    
    const deviceKeys = req.deviceKeys;
    if (deviceKeys) {
        for (const [id, data] of deviceKeys.entries()) {
            if (data.key === apiKey && Date.now() < data.expiresAt) {
                return next();
            }
        }
    }
    
    return res.status(401).json({ error: 'No autorizado' });
};

// ==========================================
// 0. PRECIO Y DURACIÓN (PÚBLICO)
// ==========================================
router.get('/precio', async (req, res) => {
    try {
        res.json({
            success: true,
            precio_unitario: PRECIO_CODIGO,
            moneda: 'EUR',
            duracion_dias: DURACION_DIAS,
            duracion_meses: mesesAproximados(),
            descuentos: []
        });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 1. REGISTRO DE VENDEDOR
// ==========================================
router.post('/registro', async (req, res) => {
    try {
        const { email, password, nombre, telefono } = req.body;
        
        if (!email || !password || !nombre) {
            return res.status(400).json({ error: 'Campos requeridos: email, password, nombre' });
        }
        
        if (!email.includes('@') || password.length < 6) {
            return res.status(400).json({ error: 'Email inválido o contraseña muy corta (mín 6)' });
        }
        
        const checkResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/vendedores?email=eq.${email}&select=id`,
            { headers: getSupabaseHeaders() }
        );
        
        const existentes = await checkResponse.json();
        if (existentes && existentes.length > 0) {
            await registrarLog('registro_fallido', email, 'vendedor',
                'Email ya registrado', 'rechazado', { ip: getClientIP(req) });
            return res.status(409).json({ error: 'Email ya registrado' });
        }
        
        const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
        
        const response = await fetch(`${SUPABASE_URL}/rest/v1/vendedores`, {
            method: 'POST',
            headers: getSupabaseHeaders(),
            body: JSON.stringify({
                email,
                password_hash,
                nombre,
                telefono: telefono || '',
                estado: 'activo'
            })
        });
        
        if (response.status !== 201) {
            const error = await response.text();
            console.error('❌ Error:', error);
            await registrarLog('registro_fallido', email, 'vendedor',
                'Error al crear vendedor', 'error', { error: error.substring(0, 200) });
            return res.status(500).json({ error: 'Error al registrar' });
        }
        
        await registrarLog('registro_exitoso', email, 'vendedor',
            'Vendedor registrado correctamente', 'exito', { ip: getClientIP(req), nombre });
        
        console.log(`✅ Vendedor registrado: ${email}`);
        
        const token = generarJWT({ email, nombre, tipo: 'vendedor' });
        
        res.json({
            success: true,
            message: 'Registro exitoso',
            token,
            vendedor: { email, nombre, telefono: telefono || '' }
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 2. LOGIN DE VENDEDOR
// ==========================================
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email y contraseña requeridos' });
        }
        
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/vendedores?email=eq.${email}&select=*`,
            { headers: getSupabaseHeaders() }
        );
        
        const vendedores = await response.json();
        const vendedor = vendedores?.[0];
        
        if (!vendedor) {
            await registrarLog('login_fallido', email, 'vendedor',
                'Email no encontrado', 'rechazado', { ip: getClientIP(req) });
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }
        
        const passwordValida = await bcrypt.compare(password, vendedor.password_hash);
        
        if (!passwordValida) {
            await registrarLog('login_fallido', email, 'vendedor',
                'Contraseña incorrecta', 'rechazado', { ip: getClientIP(req) });
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }
        
        if (vendedor.estado === 'suspendido' || vendedor.cuenta_cerrada) {
            await registrarLog('login_fallido', email, 'vendedor',
                'Cuenta suspendida o cerrada', 'rechazado',
                { ip: getClientIP(req), estado: vendedor.estado });
            return res.status(403).json({ error: 'Cuenta no activa' });
        }
        
        const token = generarJWT({
            email: vendedor.email,
            nombre: vendedor.nombre,
            tipo: 'vendedor',
            vendedor_id: vendedor.id
        });
        
        await registrarLog('login_exitoso', email, 'vendedor',
            'Inicio de sesión exitoso', 'exito', { ip: getClientIP(req) });
        
        console.log(`✅ Login: ${email}`);
        
        res.json({
            success: true,
            token,
            vendedor: {
                id: vendedor.id,
                email: vendedor.email,
                nombre: vendedor.nombre,
                telefono: vendedor.telefono,
                estado: vendedor.estado,
                fecha_registro: vendedor.fecha_registro
            }
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 3. COMPRAR CÓDIGO CON STRIPE CHECKOUT
// ==========================================
router.post('/comprar-codigo', authJWT, async (req, res) => {
    try {
        const { cantidad } = req.body;
        const vendedor = req.vendedor;
        
        const cantidadComprar = cantidad || 1;
        const total = PRECIO_CODIGO * cantidadComprar;
        
        console.log(`🛒 ${vendedor.email} compra ${cantidadComprar} código(s) - ${total}€`);
        
        const session = await Stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: {
                        name: 'Código de Activación',
                        description: `${cantidadComprar} código(s) - Válido(s) por ${mesesAproximados()} mes(es)`,
                    },
                    unit_amount: Math.round(PRECIO_CODIGO * 100),
                },
                quantity: cantidadComprar,
            }],
            mode: 'payment',
            success_url: `${process.env.APP_BASE_URL || 'http://localhost:5000'}/vendedor/exito?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.APP_BASE_URL || 'http://localhost:5000'}/vendedor/cancelado`,
            metadata: {
                vendedor_id: vendedor.id,
                vendedor_email: vendedor.email,
                cantidad: cantidadComprar.toString()
            }
        });
        
        await fetch(`${SUPABASE_URL}/rest/v1/transacciones`, {
            method: 'POST',
            headers: getSupabaseHeaders(),
            body: JSON.stringify({
                vendedor_id: vendedor.id,
                stripe_session_id: session.id,
                stripe_payment_status: 'pending',
                monto: total,
                tipo: 'compra_codigo',
                estado: 'pendiente',
                metadata: { cantidad: cantidadComprar, precio_unitario: PRECIO_CODIGO }
            })
        });
        
        await registrarLog('compra_iniciada', vendedor.email, 'vendedor',
            `Compra de ${cantidadComprar} código(s) por ${total}€ iniciada`, 'exito',
            { cantidad: cantidadComprar, total, stripe_session_id: session.id });
        
        res.json({
            success: true,
            url_pago: session.url,
            session_id: session.id,
            cantidad: cantidadComprar,
            total: total
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 4. WEBHOOK DE STRIPE
// ==========================================
router.post('/stripe-webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        event = Stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('❌ Webhook error:', err.message);
        await registrarLog('webhook_error', 'stripe', 'sistema',
            'Error en webhook de Stripe', 'error', { error: err.message });
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        
        console.log('💳 Pago completado:', session.id);
        
        const vendedorId = session.metadata.vendedor_id;
        const vendedorEmail = session.metadata.vendedor_email;
        const cantidad = parseInt(session.metadata.cantidad);
        
        await fetch(
            `${SUPABASE_URL}/rest/v1/transacciones?stripe_session_id=eq.${session.id}`,
            {
                method: 'PATCH',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({
                    stripe_payment_status: 'completed',
                    estado: 'completado'
                })
            }
        );
        
        const codigos_generados = [];
        
        for (let i = 0; i < cantidad; i++) {
            const codigo = `${Math.floor(1000000000 + Math.random() * 9000000000)}`;
            
            const response = await fetch(`${SUPABASE_URL}/rest/v1/codigos_activacion`, {
                method: 'POST',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({
                    codigo,
                    vendedor_id: vendedorId,
                    estado: 'disponible',
                    precio_compra: PRECIO_CODIGO,
                    fecha_compra: new Date().toISOString(),
                    fecha_expiracion: null,
                    max_nies: 2,
                    ampliaciones_compradas: 0,
                    stripe_session_id: session.id,
                    stripe_payment_status: 'completed'
                })
            });
            
            if (response.status === 201) {
                codigos_generados.push(codigo);
            }
        }
        
        await registrarLog('compra_completada', vendedorEmail, 'vendedor',
            `Compra de ${cantidad} código(s) completada - ${codigos_generados.length} generados`, 'exito',
            { cantidad, codigos: codigos_generados, stripe_session_id: session.id, total: cantidad * PRECIO_CODIGO });
        
        console.log(`✅ ${codigos_generados.length} códigos generados para ${vendedorEmail}`);
    }
    
    res.json({ received: true });
});

// ==========================================
// 5. ACTIVAR CÓDIGO
// ==========================================
router.post('/activar-codigo', async (req, res) => {
    try {
        const { codigo, android_id, email_usuario, nombre_usuario } = req.body;
        
        if (!codigo || !android_id) {
            await registrarLog('activacion_fallida', android_id || 'unknown', 'usuario',
                'Faltan datos para activación', 'rechazado', { codigo, motivo: 'Datos incompletos' });
            return res.status(400).json({ error: 'Código y android_id requeridos' });
        }
        
        console.log(`🔑 Activando: ${codigo} -> ${android_id}`);
        
        const checkResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}&select=*`,
            { headers: getSupabaseHeaders() }
        );
        const codigosCheck = await checkResponse.json();
        const codigoData = codigosCheck?.[0];
        
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/rpc/verificar_codigo_activacion`,
            {
                method: 'POST',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({
                    p_codigo: codigo,
                    p_android_id: android_id
                })
            }
        );
        
        const resultado = await response.json();
        
        if (!resultado.valido) {
            console.log(`❌ Código inválido: ${resultado.mensaje}`);
            
            await registrarLog('activacion_fallida', android_id, 'usuario',
                `Código ${codigo}: ${resultado.mensaje}`, 'rechazado',
                { codigo, motivo: resultado.mensaje, android_id,
                    codigo_estado: codigoData?.estado,
                    codigo_android_vinculado: codigoData?.android_id_activado });
            
            return res.status(400).json({ error: resultado.mensaje });
        }
        
        // ✅ NUEVO: Calcular fecha_uso y fecha_expiracion SOLO al activar
        const ahora = new Date();
        const fechaExpiracion = calcularFechaExpiracion(ahora);
        
        await fetch(
            `${SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}`,
            {
                method: 'PATCH',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({
                    fecha_uso: ahora.toISOString(),
                    fecha_expiracion: fechaExpiracion,
                    nies_usados: [],
                    max_nies: 2,
                    ampliaciones_compradas: 0,
                    usuario_email: email_usuario || '',
                    usuario_nombre: nombre_usuario || ''
                })
            }
        );
        
        console.log(`📅 Código ${codigo} activado. Expira en ${DURACION_DIAS} días: ${fechaExpiracion}`);
        
        await registrarLog('activacion_exitosa', android_id, 'usuario',
            `Código ${codigo} activado correctamente`, 'exito',
            { codigo, android_id, vendedor_id: codigoData?.vendedor_id,
                email_usuario: email_usuario || 'no proporcionado',
                valido_hasta: fechaExpiracion,
                duracion_dias: DURACION_DIAS });
        
        console.log(`✅ Código activado: ${codigo} -> ${android_id}`);
        
        res.json({
            success: true,
            message: 'Código activado correctamente',
            valido_hasta: fechaExpiracion,
            duracion_dias: DURACION_DIAS
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        await registrarLog('activacion_error', 'unknown', 'sistema',
            `Error activando código: ${error.message}`, 'error');
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 6. MIS CÓDIGOS
// ==========================================
router.get('/mis-codigos', authJWT, async (req, res) => {
    try {
        const pagina = parseInt(req.query.pagina) || 1;
        const por_pagina = parseInt(req.query.por_pagina) || 20;
        const filtro = req.query.filtro || 'todos';
        
        const vendedor = req.vendedor;
        const offset = (pagina - 1) * por_pagina;
        
        let filtroEstado = '';
        if (filtro === 'disponibles') filtroEstado = '&estado=eq.disponible';
        else if (filtro === 'usados') filtroEstado = '&estado=eq.usado';
        else if (filtro === 'expirados') filtroEstado = '&estado=eq.expirado';
        
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/codigos_activacion?vendedor_id=eq.${vendedor.id}${filtroEstado}&select=*&order=fecha_compra.desc&limit=${por_pagina}&offset=${offset}`,
            { 
                headers: {
                    ...getSupabaseHeaders(),
                    'Prefer': 'count=exact'
                }
            }
        );
        
        const codigos = await response.json();
        
        const contentRange = response.headers.get('content-range');
        let total = 0;
        if (contentRange) {
            const parts = contentRange.split('/');
            total = parseInt(parts[1]) || 0;
        } else {
            total = codigos.length;
        }
        
        const statsResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/codigos_activacion?vendedor_id=eq.${vendedor.id}&select=estado`,
            { 
                headers: {
                    ...getSupabaseHeaders(),
                    'Prefer': 'count=exact'
                }
            }
        );
        const todosCodigos = await statsResponse.json();
        
        const estadisticas = {
            total: todosCodigos.length,
            disponibles: todosCodigos.filter(c => c.estado === 'disponible').length,
            usados: todosCodigos.filter(c => c.estado === 'usado').length,
            expirados: todosCodigos.filter(c => c.estado === 'expirado').length,
            inversion_total: (todosCodigos.length * PRECIO_CODIGO).toFixed(2)
        };
        
        res.json({
            success: true,
            codigos,
            estadisticas,
            paginacion: {
                pagina_actual: pagina,
                por_pagina,
                total_paginas: Math.ceil(total / por_pagina),
                total_codigos: total
            }
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// ✅ ELIMINAR CÓDIGO (SOLO DISPONIBLES)
// ==========================================
router.delete('/eliminar-codigo/:id', authJWT, async (req, res) => {
    try {
        const { id } = req.params;
        const vendedor = req.vendedor;
        
        console.log(`🗑️ Eliminando código: ${id} - Vendedor: ${vendedor.email}`);
        
        const checkResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/codigos_activacion?id=eq.${id}&vendedor_id=eq.${vendedor.id}&estado=eq.disponible&select=id,codigo`,
            { headers: getSupabaseHeaders() }
        );
        
        const codigos = await checkResponse.json();
        
        if (!codigos || codigos.length === 0) {
            return res.status(404).json({ 
                error: 'Código no encontrado o no se puede eliminar' 
            });
        }
        
        const deleteResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/codigos_activacion?id=eq.${id}`,
            {
                method: 'DELETE',
                headers: getSupabaseHeaders()
            }
        );
        
        if (deleteResponse.ok) {
            await registrarLog('codigo_eliminado', vendedor.email, 'vendedor',
                `Código ${codigos[0].codigo} eliminado`, 'exito');
            
            console.log(`✅ Código eliminado: ${codigos[0].codigo}`);
            
            res.json({ 
                success: true, 
                message: 'Código eliminado correctamente' 
            });
        } else {
            throw new Error('Error al eliminar');
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 18. ADMIN: CÓDIGOS DE UN VENDEDOR
// ==========================================
router.get('/admin/vendedores/:id/codigos', authAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const pagina = parseInt(req.query.pagina) || 1;
        const porPagina = parseInt(req.query.por_pagina) || 50;
        const filtro = req.query.filtro || 'todos';
        
        console.log(`📋 Admin viendo códigos del vendedor: ${id}`);
        
        const offset = (pagina - 1) * porPagina;
        
        let filtroEstado = '';
        if (filtro === 'disponibles') filtroEstado = '&estado=eq.disponible';
        else if (filtro === 'usados') filtroEstado = '&estado=eq.usado';
        else if (filtro === 'expirados') filtroEstado = '&estado=eq.expirado';
        
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/codigos_activacion?vendedor_id=eq.${id}${filtroEstado}&select=*&order=fecha_compra.desc&limit=${porPagina}&offset=${offset}`,
            { headers: getSupabaseHeaders() }
        );
        
        const codigos = await response.json();
        
        console.log(`   Códigos encontrados: ${codigos.length}`);
        
        res.json({
            success: true,
            codigos: codigos || [],
            paginacion: {
                pagina_actual: pagina,
                por_pagina: porPagina,
                total_codigos: codigos.length
            }
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 7. ESTADÍSTICAS DEL VENDEDOR
// ==========================================
router.get('/estadisticas', authJWT, async (req, res) => {
    try {
        const vendedor = req.vendedor;
        
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/codigos_activacion?vendedor_id=eq.${vendedor.id}&select=*&order=fecha_compra.desc`,
            { headers: getSupabaseHeaders() }
        );
        
        const codigos = await response.json();
        
        const ahora = new Date();
        const hace30Dias = new Date(ahora - 30 * 24 * 60 * 60 * 1000);
        const hace7Dias = new Date(ahora - 7 * 24 * 60 * 60 * 1000);
        
        const porMes = {};
        codigos.forEach(c => {
            const mes = new Date(c.fecha_compra).toISOString().substring(0, 7);
            porMes[mes] = (porMes[mes] || 0) + 1;
        });
        
        const stats = {
            total_comprados: codigos.length,
            disponibles: codigos.filter(c => c.estado === 'disponible').length,
            usados: codigos.filter(c => c.estado === 'usado').length,
            expirados: codigos.filter(c => c.estado === 'expirado').length,
            inversion_total: (codigos.length * PRECIO_CODIGO).toFixed(2),
            ultimos_30_dias: codigos.filter(c => new Date(c.fecha_compra) >= hace30Dias).length,
            ultimos_7_dias: codigos.filter(c => new Date(c.fecha_compra) >= hace7Dias).length,
            por_mes: porMes,
            tasa_uso: codigos.length > 0 
                ? ((codigos.filter(c => c.estado === 'usado').length / codigos.length) * 100).toFixed(1)
                : 0
        };
        
        res.json({ success: true, estadisticas: stats });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 8. CERRAR CUENTA
// ==========================================
router.post('/cerrar-cuenta', authJWT, async (req, res) => {
    try {
        const vendedor = req.vendedor;
        const { confirmacion } = req.body;
        
        if (confirmacion !== 'CERRAR') {
            return res.status(400).json({ error: 'Escribe CERRAR para confirmar' });
        }
        
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/codigos_activacion?vendedor_id=eq.${vendedor.id}&estado=eq.disponible&select=count`,
            { headers: getSupabaseHeaders() }
        );
        const disponibles = await response.json();
        
        if (disponibles && disponibles.length > 0) {
            return res.status(400).json({ 
                error: `Tienes ${disponibles.length} códigos sin usar. Véndelos o espera a que expiren.` 
            });
        }
        
        await fetch(
            `${SUPABASE_URL}/rest/v1/vendedores?id=eq.${vendedor.id}`,
            {
                method: 'PATCH',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({
                    cuenta_cerrada: true,
                    estado: 'suspendido',
                    fecha_cierre: new Date().toISOString()
                })
            }
        );
        
        await registrarLog('cuenta_cerrada', vendedor.email, 'vendedor',
            'Cuenta cerrada permanentemente', 'exito',
            { ip: getClientIP(req), codigos_disponibles: disponibles.length });
        
        console.log(`🚫 Cuenta cerrada: ${vendedor.email}`);
        
        res.json({ success: true, message: 'Cuenta cerrada permanentemente' });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 9. VERIFICAR TOKEN
// ==========================================
router.get('/verificar-token', authJWT, async (req, res) => {
    res.json({
        success: true,
        vendedor: {
            id: req.vendedor.id,
            email: req.vendedor.email,
            nombre: req.vendedor.nombre,
            telefono: req.vendedor.telefono,
            estado: req.vendedor.estado
        }
    });
});

// ==========================================
// 10. LOGOUT
// ==========================================
router.post('/logout', authJWT, async (req, res) => {
    try {
        const jti = req.jwt_payload.jti;
        
        await fetch(`${SUPABASE_URL}/rest/v1/sesiones_jwt`, {
            method: 'POST',
            headers: getSupabaseHeaders(),
            body: JSON.stringify({
                usuario_id: req.vendedor.email,
                usuario_tipo: 'vendedor',
                token_jti: jti,
                token_expira: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                activa: false,
                revocada_en: new Date().toISOString(),
                ip_origen: getClientIP(req),
                user_agent: getUserAgent(req)
            })
        });
        
        await registrarLog('logout', req.vendedor.email, 'vendedor', 'Cierre de sesión', 'exito');
        
        res.json({ success: true, message: 'Sesión cerrada' });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 11. CREAR PAYMENT INTENT (STRIPE NATIVO)
// ==========================================
router.post('/crear-payment-intent', authJWT, async (req, res) => {
    try {
        const { cantidad } = req.body;
        const vendedor = req.vendedor;
        
        const cantidadComprar = cantidad || 1;
        const total = PRECIO_CODIGO * cantidadComprar;
        
        console.log(`💳 Creando PaymentIntent: ${vendedor.email} - ${cantidadComprar} código(s) - ${total}€`);
        
        const paymentIntent = await Stripe.paymentIntents.create({
            amount: Math.round(total * 100),
            currency: 'eur',
            metadata: {
                vendedor_id: vendedor.id,
                vendedor_email: vendedor.email,
                cantidad: cantidadComprar.toString(),
                precio_unitario: PRECIO_CODIGO.toString()
            }
        });
        
        console.log(`   PaymentIntent: ${paymentIntent.id}`);
        
        res.json({
            success: true,
            client_secret: paymentIntent.client_secret,
            payment_intent_id: paymentIntent.id,
            cantidad: cantidadComprar,
            total: total
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 12. CONFIRMAR PAGO Y GENERAR CÓDIGOS
// ==========================================
router.post('/confirmar-pago', authJWT, async (req, res) => {
    try {
        const { payment_intent_id, cantidad } = req.body;
        const vendedor = req.vendedor;
        
        console.log(`✅ Confirmando pago: ${payment_intent_id}`);
        
        const paymentIntent = await Stripe.paymentIntents.retrieve(payment_intent_id);
        
        if (paymentIntent.status !== 'succeeded') {
            return res.status(400).json({ error: 'El pago no se ha completado' });
        }
        
        const cantidadCodigos = cantidad || parseInt(paymentIntent.metadata.cantidad) || 1;
        const codigos_generados = [];
        
        for (let i = 0; i < cantidadCodigos; i++) {
            const codigo = `${Math.floor(1000000000 + Math.random() * 9000000000)}`;
            
            const response = await fetch(`${SUPABASE_URL}/rest/v1/codigos_activacion`, {
                method: 'POST',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({
                    codigo,
                    vendedor_id: vendedor.id,
                    estado: 'disponible',
                    precio_compra: PRECIO_CODIGO,
                    fecha_compra: new Date().toISOString(),
                    fecha_expiracion: null,
                    max_nies: 2,
                    ampliaciones_compradas: 0,
                    stripe_session_id: payment_intent_id,
                    stripe_payment_status: 'completed'
                })
            });
            
            if (response.status === 201) {
                codigos_generados.push(codigo);
            }
        }
        
        console.log(`✅ ${codigos_generados.length} códigos generados`);
        
        res.json({
            success: true,
            codigos_generados: codigos_generados.length,
            codigos: codigos_generados,
            message: `${codigos_generados.length} código(s) generado(s)`
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 13. ADMIN: LISTA DE VENDEDORES
// ==========================================
router.get('/admin/vendedores', authAdmin, async (req, res) => {
    try {
        const pagina = parseInt(req.query.pagina) || 1;
        const por_pagina = parseInt(req.query.por_pagina) || 20;
        const filtro = req.query.filtro || 'todos';
        
        const offset = (pagina - 1) * por_pagina;
        
        let filtroEstado = '';
        if (filtro === 'activos') filtroEstado = '&estado=eq.activo&cuenta_cerrada=eq.false';
        else if (filtro === 'suspendidos') filtroEstado = '&estado=eq.suspendido';
        else if (filtro === 'cerrados') filtroEstado = '&cuenta_cerrada=eq.true';
        
        const countResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/vendedores?select=count${filtroEstado}`,
            { headers: getSupabaseHeaders() }
        );
        const countData = await countResponse.json();
        const total = countData.length;
        
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/vendedores?select=*${filtroEstado}&order=fecha_registro.desc&limit=${por_pagina}&offset=${offset}`,
            { headers: getSupabaseHeaders() }
        );
        
        const vendedores = await response.json();
        
        const vendedoresConStats = await Promise.all(
            vendedores.map(async (vendedor) => {
                const codigosResponse = await fetch(
                    `${SUPABASE_URL}/rest/v1/codigos_activacion?vendedor_id=eq.${vendedor.id}&select=estado`,
                    { headers: getSupabaseHeaders() }
                );
                const codigos = await codigosResponse.json();
                
                return {
                    ...vendedor,
                    estadisticas: {
                        total_codigos: codigos.length,
                        disponibles: codigos.filter(c => c.estado === 'disponible').length,
                        usados: codigos.filter(c => c.estado === 'usado').length,
                        expirados: codigos.filter(c => c.estado === 'expirado').length,
                        inversion_total: (codigos.length * PRECIO_CODIGO).toFixed(2),
                        tasa_uso: codigos.length > 0 
                            ? ((codigos.filter(c => c.estado === 'usado').length / codigos.length) * 100).toFixed(1)
                            : 0
                    }
                };
            })
        );
        
        res.json({
            success: true,
            vendedores: vendedoresConStats,
            paginacion: {
                pagina_actual: pagina,
                por_pagina,
                total_paginas: Math.ceil(total / por_pagina),
                total_vendedores: total
            }
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 14. ADMIN: DETALLE VENDEDOR
// ==========================================
router.get('/admin/vendedores/:id', authAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        const vendedorResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/vendedores?id=eq.${id}&select=*`,
            { headers: getSupabaseHeaders() }
        );
        const vendedores = await vendedorResponse.json();
        
        if (!vendedores || vendedores.length === 0) {
            return res.status(404).json({ error: 'Vendedor no encontrado' });
        }
        
        const vendedor = vendedores[0];
        
        const codigosResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/codigos_activacion?vendedor_id=eq.${id}&select=*&order=fecha_compra.desc`,
            { headers: getSupabaseHeaders() }
        );
        const codigos = await codigosResponse.json();
        
        const logsResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/logs_auditoria?usuario_id=eq.${vendedor.email}&order=fecha_creacion.desc&limit=50`,
            { headers: getSupabaseHeaders() }
        );
        const logs = await logsResponse.json();
        
        const ahora = new Date();
        const hace30Dias = new Date(ahora - 30 * 24 * 60 * 60 * 1000);
        
        const porMes = {};
        codigos.forEach(c => {
            const mes = new Date(c.fecha_compra).toISOString().substring(0, 7);
            if (!porMes[mes]) porMes[mes] = { comprados: 0, usados: 0 };
            porMes[mes].comprados++;
            if (c.estado === 'usado') porMes[mes].usados++;
        });
        
        const stats = {
            totales: {
                comprados: codigos.length,
                disponibles: codigos.filter(c => c.estado === 'disponible').length,
                usados: codigos.filter(c => c.estado === 'usado').length,
                expirados: codigos.filter(c => c.estado === 'expirado').length,
                inversion_total: (codigos.length * PRECIO_CODIGO).toFixed(2),
                tasa_uso: codigos.length > 0 
                    ? ((codigos.filter(c => c.estado === 'usado').length / codigos.length) * 100).toFixed(1)
                    : 0
            },
            ultimos_30_dias: {
                comprados: codigos.filter(c => new Date(c.fecha_compra) >= hace30Dias).length,
                usados: codigos.filter(c => c.estado === 'usado' && c.fecha_uso && new Date(c.fecha_uso) >= hace30Dias).length
            },
            por_mes: porMes,
            codigos_recientes: codigos.slice(0, 10)
        };
        
        res.json({ success: true, vendedor, estadisticas: stats, logs_auditoria: logs });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 15. ADMIN: LOGS
// ==========================================
router.get('/admin/logs', authAdmin, async (req, res) => {
    try {
        const pagina = parseInt(req.query.pagina) || 1;
        const por_pagina = parseInt(req.query.por_pagina) || 50;
        const tipo = req.query.tipo || null;
        const offset = (pagina - 1) * por_pagina;
        
        let filtroTipo = '';
        if (tipo) filtroTipo = `&tipo=eq.${tipo}`;
        
        const countResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/logs_auditoria?select=count${filtroTipo}`,
            { headers: getSupabaseHeaders() }
        );
        const countData = await countResponse.json();
        const total = countData.length;
        
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/logs_auditoria?select=*${filtroTipo}&order=fecha_creacion.desc&limit=${por_pagina}&offset=${offset}`,
            { headers: getSupabaseHeaders() }
        );
        
        const logs = await response.json();
        
        res.json({
            success: true,
            logs,
            paginacion: { pagina_actual: pagina, por_pagina, total_paginas: Math.ceil(total / por_pagina), total_logs: total }
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 16. ADMIN: ESTADÍSTICAS GENERALES
// ==========================================
router.get('/admin/estadisticas-generales', authAdmin, async (req, res) => {
    try {
        const vendedoresResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/vendedores?select=id,estado,cuenta_cerrada,fecha_registro`,
            { headers: getSupabaseHeaders() }
        );
        const vendedores = await vendedoresResponse.json();
        
        const codigosResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/codigos_activacion?select=estado,fecha_compra,fecha_uso,precio_compra`,
            { headers: getSupabaseHeaders() }
        );
        const codigos = await codigosResponse.json();
        
        const logsResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/logs_auditoria?order=fecha_creacion.desc&limit=10`,
            { headers: getSupabaseHeaders() }
        );
        const logsRecientes = await logsResponse.json();
        
        const ahora = new Date();
        const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
        
        const codigosPorMes = {};
        codigos.forEach(c => {
            const mes = new Date(c.fecha_compra).toISOString().substring(0, 7);
            codigosPorMes[mes] = (codigosPorMes[mes] || 0) + 1;
        });
        
        const stats = {
            vendedores: {
                total: vendedores.length,
                activos: vendedores.filter(v => v.estado === 'activo' && !v.cuenta_cerrada).length,
                suspendidos: vendedores.filter(v => v.estado === 'suspendido' || v.cuenta_cerrada).length,
                nuevos_este_mes: vendedores.filter(v => new Date(v.fecha_registro) >= inicioMes).length
            },
            codigos: {
                total: codigos.length,
                disponibles: codigos.filter(c => c.estado === 'disponible').length,
                usados: codigos.filter(c => c.estado === 'usado').length,
                expirados: codigos.filter(c => c.estado === 'expirado').length,
                vendidos_este_mes: codigos.filter(c => new Date(c.fecha_compra) >= inicioMes).length,
                usados_este_mes: codigos.filter(c => c.fecha_uso && new Date(c.fecha_uso) >= inicioMes).length
            },
            ingresos: {
                total: (codigos.length * PRECIO_CODIGO).toFixed(2),
                este_mes: (codigos.filter(c => new Date(c.fecha_compra) >= inicioMes).length * PRECIO_CODIGO).toFixed(2)
            },
            tasa_uso_global: codigos.length > 0 
                ? ((codigos.filter(c => c.estado === 'usado').length / codigos.length) * 100).toFixed(1)
                : 0,
            codigos_por_mes: codigosPorMes,
            logs_recientes: logsRecientes
        };
        
        res.json({ success: true, estadisticas: stats });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 17. ADMIN: SUSPENDER/ACTIVAR VENDEDOR
// ==========================================
router.patch('/admin/vendedores/:id/estado', authAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { estado, motivo } = req.body;
        
        if (!estado || !['activo', 'suspendido'].includes(estado)) {
            return res.status(400).json({ error: 'Estado inválido' });
        }
        
        await fetch(
            `${SUPABASE_URL}/rest/v1/vendedores?id=eq.${id}`,
            {
                method: 'PATCH',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({
                    estado,
                    notas_admin: motivo || `Estado cambiado a ${estado}`
                })
            }
        );
        
        await registrarLog('admin_cambio_estado', 'admin', 'admin',
            `Vendedor ${id} cambiado a ${estado}: ${motivo || 'Sin motivo'}`, 'exito');
        
        res.json({ success: true, message: `Vendedor ${estado === 'activo' ? 'activado' : 'suspendido'}` });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// ✅ NUEVO: Listado de ampliaciones (ADMIN)
// ==========================================
router.get('/admin/ampliaciones', authAdmin, async (req, res) => {
  try {
    const pagina = parseInt(req.query.pagina) || 1;
    const por_pagina = parseInt(req.query.por_pagina) || 50;
    const filtro = req.query.filtro || 'todas'; // todas | 1 | 2 | 5
    const offset = (pagina - 1) * por_pagina;
    
    let filtroCantidad = '';
    if (filtro !== 'todas') filtroCantidad = `&cantidad=eq.${filtro}`;
    
    // ✅ 1. Obtener ampliaciones con JOIN al vendedor
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/ampliaciones_codigo?select=*,vendedores(nombre,email,telefono)&${filtroCantidad}&order=fecha_compra.desc&limit=${por_pagina}&offset=${offset}`,
      {
        headers: {
          ...getSupabaseHeaders(),
          'Prefer': 'count=exact'
        }
      }
    );
    
    const ampliaciones = await response.json();
    
    // ✅ 2. Calcular stats totales
    const statsResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/ampliaciones_codigo?select=cantidad,precio`,
      { headers: getSupabaseHeaders() }
    );
    const todasAmpliaciones = await statsResponse.json();
    
    const totalCantidad = todasAmpliaciones.reduce((sum, a) => sum + (a.cantidad || 0), 0);
    const totalIngresos = todasAmpliaciones.reduce((sum, a) => sum + (parseFloat(a.precio) || 0), 0);
    
    // ✅ 3. Formatear con el vendedor aplanado
    const ampliacionesFormateadas = ampliaciones.map(a => ({
      ...a,
      vendedor_nombre: a.vendedores?.nombre || null,
      vendedor_email: a.vendedores?.email || null,
      vendedor_telefono: a.vendedores?.telefono || null,
      vendedores: undefined,
    }));
    
    // ✅ 4. Conteo exacto desde el header
    const contentRange = response.headers.get('content-range');
    let total = 0;
    if (contentRange) {
      const parts = contentRange.split('/');
      total = parseInt(parts[1]) || 0;
    } else {
      total = ampliacionesFormateadas.length;
    }
    
    res.json({
      success: true,
      ampliaciones: ampliacionesFormateadas,
      estadisticas: {
        total_ampliaciones: todasAmpliaciones.length,
        total_nies_extra: totalCantidad,
        ingresos_totales: totalIngresos.toFixed(2),
      },
      paginacion: {
        pagina_actual: pagina,
        por_pagina,
        total_paginas: Math.ceil(total / por_pagina),
        total_registros: total,
      }
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ✅ NUEVO: Estadísticas por canal (ADMIN)
// ==========================================
router.get('/admin/estadisticas-canales', authAdmin, async (req, res) => {
  try {
    const APP_DIRECTA_ID = process.env.APP_DIRECTA_VENDEDOR_ID;
    
    if (!APP_DIRECTA_ID) {
      return res.status(500).json({ error: 'APP_DIRECTA_VENDEDOR_ID no configurado' });
    }
    
    // ✅ 1. Todos los códigos
    const codigosResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/codigos_activacion?select=estado,precio_compra,vendedor_id,ampliaciones_compradas`,
      { headers: getSupabaseHeaders() }
    );
    const codigos = await codigosResponse.json();
    
    // ✅ 2. Todas las ampliaciones
    const ampliacionesResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/ampliaciones_codigo?select=cantidad,precio`,
      { headers: getSupabaseHeaders() }
    );
    const ampliaciones = await ampliacionesResponse.json();
    
    // ✅ 3. Separar por canal
    const codigosVendedores = codigos.filter(c => c.vendedor_id !== APP_DIRECTA_ID);
    const codigosAppDirecta = codigos.filter(c => c.vendedor_id === APP_DIRECTA_ID);
    
    const calcularStats = (arr) => ({
      total: arr.length,
      disponibles: arr.filter(c => c.estado === 'disponible').length,
      usados: arr.filter(c => c.estado === 'usado').length,
      expirados: arr.filter(c => c.estado === 'expirado').length,
      ingresos: arr.reduce((sum, c) => sum + (parseFloat(c.precio_compra) || 0), 0).toFixed(2),
      tasa_uso: arr.length > 0 
        ? ((arr.filter(c => c.estado === 'usado').length / arr.length) * 100).toFixed(1)
        : 0,
    });
    
    const statsVendedores = calcularStats(codigosVendedores);
    const statsAppDirecta = calcularStats(codigosAppDirecta);
    
    // ✅ 4. Ampliaciones
    const totalAmpliaciones = ampliaciones.length;
    const totalNiesExtra = ampliaciones.reduce((sum, a) => sum + (a.cantidad || 0), 0);
    const ingresosAmpliaciones = ampliaciones.reduce((sum, a) => sum + (parseFloat(a.precio) || 0), 0);
    
    // ✅ 5. Comparativa
    const ingresosVendedores = parseFloat(statsVendedores.ingresos);
    const ingresosAppDirecta = parseFloat(statsAppDirecta.ingresos);
    const ingresosTotales = ingresosVendedores + ingresosAppDirecta + ingresosAmpliaciones;
    
    res.json({
      success: true,
      canales: {
        vendedores: {
          ...statsVendedores,
          porcentaje_ingresos: ingresosTotales > 0 
            ? ((ingresosVendedores / ingresosTotales) * 100).toFixed(1)
            : 0,
        },
        app_directa: {
          ...statsAppDirecta,
          porcentaje_ingresos: ingresosTotales > 0 
            ? ((ingresosAppDirecta / ingresosTotales) * 100).toFixed(1)
            : 0,
        },
      },
      ampliaciones: {
        total: totalAmpliaciones,
        nies_extra: totalNiesExtra,
        ingresos: ingresosAmpliaciones.toFixed(2),
        porcentaje_ingresos: ingresosTotales > 0 
          ? ((ingresosAmpliaciones / ingresosTotales) * 100).toFixed(1)
          : 0,
      },
      totales: {
        ingresos_totales: ingresosTotales.toFixed(2),
        codigos_totales: codigos.length,
        ampliaciones_totales: totalAmpliaciones,
      }
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: error.message });
  }
});
// ==========================================
// ✅ NUEVO: Códigos de App Directa (ADMIN)
// ==========================================
router.get('/admin/app-directa/codigos', authAdmin, async (req, res) => {
  try {
    const APP_DIRECTA_ID = process.env.APP_DIRECTA_VENDEDOR_ID;
    
    if (!APP_DIRECTA_ID) {
      return res.status(500).json({ error: 'APP_DIRECTA_VENDEDOR_ID no configurado' });
    }
    
    const pagina = parseInt(req.query.pagina) || 1;
    const por_pagina = parseInt(req.query.por_pagina) || 50;
    const filtro = req.query.filtro || 'todos';
    const offset = (pagina - 1) * por_pagina;
    
    let filtroEstado = '';
    if (filtro === 'disponibles') filtroEstado = '&estado=eq.disponible';
    else if (filtro === 'usados') filtroEstado = '&estado=eq.usado';
    else if (filtro === 'expirados') filtroEstado = '&estado=eq.expirado';
    
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/codigos_activacion?vendedor_id=eq.${APP_DIRECTA_ID}${filtroEstado}&select=*&order=fecha_compra.desc&limit=${por_pagina}&offset=${offset}`,
      {
        headers: {
          ...getSupabaseHeaders(),
          'Prefer': 'count=exact'
        }
      }
    );
    
    const codigos = await response.json();
    
    const contentRange = response.headers.get('content-range');
    let total = 0;
    if (contentRange) {
      const parts = contentRange.split('/');
      total = parseInt(parts[1]) || 0;
    } else {
      total = codigos.length;
    }
    
    res.json({
      success: true,
      codigos,
      paginacion: {
        pagina_actual: pagina,
        por_pagina,
        total_paginas: Math.ceil(total / por_pagina),
        total_codigos: total,
      }
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: error.message });
  }
});
module.exports = router;