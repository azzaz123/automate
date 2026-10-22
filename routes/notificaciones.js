const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { enviarPush } = require('../services/firebase');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const getHeaders = () => ({
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
});

// ==========================================
// 1. CREAR Y ENVIAR NOTIFICACIÓN (ADMIN)
// ==========================================
// ==========================================
// 1. CREAR Y ENVIAR NOTIFICACIÓN (ADMIN) - VERSIÓN MEJORADA
// ==========================================
// ==========================================
// 1. CREAR Y ENVIAR NOTIFICACIÓN (ADMIN) - SIN data_extra
// ==========================================
router.post('/crear', async (req, res) => {
    try {
        const { 
            titulo, 
            mensaje, 
            imagen_url, 
            tipo, 
            enviar_a, 
            android_ids,
            data // ✅ Datos personalizados que enviará a Firebase
        } = req.body;
        
        if (!titulo || !mensaje) {
            return res.status(400).json({ error: 'Título y mensaje requeridos' });
        }
        
        console.log(`📢 Creando notificación: "${titulo}" → "${enviar_a}"`);
        console.log('📊 Data extra:', data || 'Sin data extra');
        
        // 1. Guardar notificación en Supabase (SIN data_extra)
        const notifResponse = await fetch(`${SUPABASE_URL}/rest/v1/notificaciones`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
                titulo,
                mensaje,
                imagen_url: imagen_url || null,
                tipo: tipo || 'info',
                enviar_a: enviar_a || 'todos',
                android_ids: android_ids || [],
                fecha_creacion: new Date().toISOString()
                // ❌ ELIMINAMOS data_extra para evitar el error
            })
        });
        
        if (notifResponse.status !== 201) {
            const err = await notifResponse.text();
            console.error('❌ Error guardando notificación:', err);
            return res.status(500).json({ error: 'Error al guardar notificación' });
        }
        
        console.log('✅ Notificación guardada en BD');
        
        // 2. Obtener tokens FCM según destinatarios
        let fcmTokens = [];
        
        if (enviar_a === 'todos') {
            const response = await fetch(
                `${SUPABASE_URL}/rest/v1/usuarios?select=fcm_token&fcm_token=not.is.null`,
                { headers: getHeaders() }
            );
            const usuarios = await response.json();
            fcmTokens = usuarios.map(u => u.fcm_token).filter(Boolean);
            console.log(`📱 Tokens FCM (todos): ${fcmTokens.length}`);
            
        } else if ((enviar_a === 'seleccionados' || enviar_a === 'uno') && android_ids?.length > 0) {
            const ids = android_ids.map(id => `"${id}"`).join(',');
            const response = await fetch(
                `${SUPABASE_URL}/rest/v1/usuarios?android_id=in.(${ids})&select=fcm_token&fcm_token=not.is.null`,
                { headers: getHeaders() }
            );
            const usuarios = await response.json();
            fcmTokens = usuarios.map(u => u.fcm_token).filter(Boolean);
            console.log(`📱 Tokens FCM (seleccionados): ${fcmTokens.length}`);
        }
        
        // 3. Enviar push por Firebase con TODOS los datos
        let resultadoPush = { successCount: 0, failureCount: 0 };
        
        if (fcmTokens.length > 0) {
            // ✅ Construir datos para Firebase usando el campo data del Admin
            const datosFirebase = {
                tipo: tipo || 'info',
                screen: 'notificaciones',
                // ✅ Incluir todos los datos del Admin
                ...(data || {}),
                // ✅ Asegurar click_action
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
            };
            
            resultadoPush = await enviarPush(
                fcmTokens, 
                titulo, 
                mensaje, 
                imagen_url || null,
                datosFirebase
            );
            console.log(`✅ Push enviado: ${resultadoPush.successCount} éxito, ${resultadoPush.failureCount} fallos`);
        } else {
            console.log('⚠️ No hay tokens FCM para enviar push');
        }
        
        res.json({
            success: true,
            message: 'Notificación creada y enviada',
            guardada: true,
            push_enviado: fcmTokens.length > 0,
            enviados: resultadoPush.successCount || 0,
            fallos: resultadoPush.failureCount || 0,
            total_tokens: fcmTokens.length
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 2. GUARDAR FCM TOKEN (APP A)
// ==========================================
router.post('/guardar-token', async (req, res) => {
    try {
        const { android_id, fcm_token } = req.body;
        
        if (!android_id || !fcm_token) {
            return res.status(400).json({ error: 'android_id y fcm_token requeridos' });
        }
        
        // ✅ DIAGNÓSTICO: Mostrar el token COMPLETO que se recibe
        console.log(`💾 Guardando FCM Token para: ${android_id}`);
        console.log(`   Token recibido: ${fcm_token}`);
        console.log(`   Longitud: ${fcm_token.length}`);
        console.log(`   Empieza con: ${fcm_token.substring(0, 1)}`);
        console.log(`   Termina con: ${fcm_token.substring(fcm_token.length - 10)}`);
        
        // ✅ VALIDAR que el token tenga formato correcto
        if (fcm_token.length < 100) {
            console.error('❌ Token demasiado corto, posiblemente truncado');
            return res.status(400).json({ 
                success: false, 
                error: 'Token FCM inválido (demasiado corto)' 
            });
        }
        
        // Verificar si existe el usuario
        const checkResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${android_id}&select=id,fcm_token`,
            { headers: getHeaders() }
        );
        const usuarios = await checkResponse.json();
        
        if (!usuarios || usuarios.length === 0) {
            // Crear usuario básico si no existe
            console.log('   Creando nuevo usuario...');
            await fetch(`${SUPABASE_URL}/rest/v1/usuarios`, {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify({
                    android_id,
                    fcm_token,  // ✅ Token COMPLETO
                    estado: 'activo',
                    fecha_activacion: new Date().toISOString()
                })
            });
            console.log('✅ Usuario creado con FCM Token');
        } else {
            // Actualizar FCM token
            console.log('   Actualizando usuario existente...');
            console.log('   Token anterior:', usuarios[0].fcm_token?.substring(0, 30) + '...');
            
            const updateResponse = await fetch(
                `${SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${android_id}`,
                {
                    method: 'PATCH',
                    headers: getHeaders(),
                    body: JSON.stringify({ 
                        fcm_token: fcm_token  // ✅ Token COMPLETO
                    })
                }
            );
            
            console.log('   Update status:', updateResponse.status);
            console.log('✅ FCM Token actualizado');
        }
        
        res.json({ success: true, message: 'Token guardado' });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 3. OBTENER NOTIFICACIONES PARA APP A
// ==========================================
router.get('/mis-notificaciones/:androidId', async (req, res) => {
    try {
        const { androidId } = req.params;
        
        console.log(`🔔 Buscando notificaciones para: ${androidId}`);
        
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/notificaciones?order=fecha_creacion.desc&limit=50`,
            { headers: getHeaders() }
        );
        
        const todas = await response.json();
        
        const notificaciones = todas.filter(n => {
            if (n.enviar_a === 'todos') return true;
            if (n.android_ids && Array.isArray(n.android_ids) && n.android_ids.includes(androidId)) return true;
            return false;
        });
        
        console.log(`   ${notificaciones.length} notificaciones encontradas`);
        
        res.json({
            success: true,
            data: notificaciones,
            total: notificaciones.length
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 4. MARCAR COMO LEÍDA
// ==========================================
router.patch('/leer/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await fetch(`${SUPABASE_URL}/rest/v1/notificaciones?id=eq.${id}`, {
            method: 'PATCH',
            headers: getHeaders(),
            body: JSON.stringify({ leida: true })
        });
        
        res.json({ success: true, message: 'Marcada como leída' });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 5. MARCAR TODAS COMO LEÍDAS
// ==========================================
router.patch('/leer-todas/:androidId', async (req, res) => {
    try {
        const { androidId } = req.params;
        
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/notificaciones?leida=eq.false&select=id,enviar_a,android_ids`,
            { headers: getHeaders() }
        );
        
        const todas = await response.json();
        
        const ids = todas.filter(n => {
            if (n.enviar_a === 'todos') return true;
            if (n.android_ids && n.android_ids.includes(androidId)) return true;
            return false;
        }).map(n => n.id);
        
        if (ids.length > 0) {
            const idsStr = ids.map(id => `"${id}"`).join(',');
            await fetch(`${SUPABASE_URL}/rest/v1/notificaciones?id=in.(${idsStr})`, {
                method: 'PATCH',
                headers: getHeaders(),
                body: JSON.stringify({ leida: true })
            });
        }
        
        console.log(`✅ ${ids.length} notificaciones marcadas como leídas`);
        res.json({ success: true, marcadas: ids.length });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 6. CONTADOR DE NO LEÍDAS
// ==========================================
router.get('/no-leidas/:androidId', async (req, res) => {
    try {
        const { androidId } = req.params;
        
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/notificaciones?leida=eq.false&select=enviar_a,android_ids`,
            { headers: getHeaders() }
        );
        
        const todas = await response.json();
        
        const noLeidas = todas.filter(n => {
            if (n.enviar_a === 'todos') return true;
            if (n.android_ids && n.android_ids.includes(androidId)) return true;
            return false;
        }).length;
        
        res.json({ success: true, no_leidas: noLeidas });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 7. OBTENER USUARIOS CON FCM (CON BÚSQUEDA Y PAGINACIÓN)
// ==========================================
// ==========================================
// 7. OBTENER USUARIOS CON FCM (CON BÚSQUEDA Y PAGINACIÓN)
// ==========================================
router.get('/usuarios-fcm', async (req, res) => {
    try {
        const {
            busqueda = '',
            pagina = 1,
            limit = 30,
            orden = 'nombre.asc',
        } = req.query;

        // Sanitizar
        const page = Math.max(1, parseInt(pagina) || 1);
        const perPage = Math.min(100, Math.max(1, parseInt(limit) || 30));
        const offset = (page - 1) * perPage;

        console.log(`🔍 [usuarios-fcm] page=${page} limit=${perPage} q="${busqueda}"`);

        // URL base
        let url = `${SUPABASE_URL}/rest/v1/usuarios`;
        url += `?select=android_id,nombre,email,fcm_token,fecha_activacion,estado`;
        url += `&fcm_token=not.is.null`;
        url += `&order=${orden}`;
        url += `&limit=${perPage}`;
        url += `&offset=${offset}`;

        // Filtro búsqueda
        const q = busqueda.trim();
        if (q.length > 0) {
            const safe = q.replace(/[%_\\]/g, '\\$&');
            const pattern = encodeURIComponent(`%${safe}%`);
            url += `&or=(nombre.ilike.${pattern},email.ilike.${pattern},android_id.ilike.${pattern})`;
        }

        // Count query
        let countUrl = `${SUPABASE_URL}/rest/v1/usuarios`;
        countUrl += `?select=android_id&fcm_token=not.is.null`;
        if (q.length > 0) {
            const safe = q.replace(/[%_\\]/g, '\\$&');
            const pattern = encodeURIComponent(`%${safe}%`);
            countUrl += `&or=(nombre.ilike.${pattern},email.ilike.${pattern},android_id.ilike.${pattern})`;
        }

        const [dataRes, countRes] = await Promise.all([
            fetch(url, { headers: getHeaders() }),
            fetch(countUrl, {
                headers: {
                    ...getHeaders(),
                    'Prefer': 'count=exact',
                    'Range-Unit': 'items',
                    'Range': '0-0',
                },
            }),
        ]);

        if (!dataRes.ok) {
            const errorText = await dataRes.text();
            console.error('❌ [usuarios-fcm] Error Supabase:', errorText);
            return res.status(500).json({
                success: false,
                error: 'Error consultando usuarios',
                details: errorText.substring(0, 500),
            });
        }

        const usuarios = await dataRes.json();

        // Total desde Content-Range
        let total = usuarios.length;
        const contentRange = countRes.headers.get('content-range');
        if (contentRange) {
            const m = contentRange.match(/\/(\d+)$/);
            if (m) total = parseInt(m[1]);
        }

        const hay_mas = offset + usuarios.length < total;

        console.log(`✅ [usuarios-fcm] ${usuarios.length}/${total} (hay_mas=${hay_mas})`);

        res.json({
            success: true,
            data: usuarios || [],
            total,
            pagina: page,
            limit: perPage,
            hay_mas,
        });

    } catch (error) {
        console.error('❌ [usuarios-fcm] Error crítico:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Error interno',
        });
    }
});
// 8. PROGRAMAR NOTIFICACIÓN - SIN data_extra
// ==========================================
router.post('/programar', async (req, res) => {
    try {
        const { 
            titulo, 
            mensaje, 
            imagen_url, 
            tipo, 
            enviar_a, 
            android_ids, 
            fecha_programada,
            data // ✅ Datos personalizados
        } = req.body;
        
        if (!titulo || !mensaje || !fecha_programada) {
            return res.status(400).json({ error: 'Título, mensaje y fecha requeridos' });
        }
        
        console.log(`📅 Programando notificación: "${titulo}" para ${fecha_programada}`);
        console.log('📊 Data extra:', data || 'Sin data extra');
        
        const response = await fetch(`${SUPABASE_URL}/rest/v1/notificaciones_programadas`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
                titulo,
                mensaje,
                imagen_url: imagen_url || null,
                tipo: tipo || 'info',
                enviar_a: enviar_a || 'todos',
                android_ids: android_ids || [],
                fecha_programada,
                enviada: false,
                fecha_creacion: new Date().toISOString()
                // ❌ ELIMINAMOS data_extra para evitar el error
            })
        });
        
        if (response.status === 201) {
            console.log(`✅ Notificación programada: ${titulo}`);
            res.json({ success: true, message: 'Notificación programada correctamente' });
        } else {
            const error = await response.text();
            console.error('❌ Error:', error);
            res.status(500).json({ error: 'Error al programar' });
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 9. OBTENER NOTIFICACIONES PROGRAMADAS
// ==========================================
router.get('/programadas', async (req, res) => {
    try {
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/notificaciones_programadas?order=fecha_programada.asc&enviada=eq.false`,
            { headers: getHeaders() }
        );
        
        const programadas = await response.json();
        
        res.json({ success: true, data: programadas });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 10. ELIMINAR NOTIFICACIÓN PROGRAMADA
// ==========================================
router.delete('/programada/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        await fetch(`${SUPABASE_URL}/rest/v1/notificaciones_programadas?id=eq.${id}`, {
            method: 'DELETE',
            headers: getHeaders()
        });
        
        res.json({ success: true, message: 'Eliminada' });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;