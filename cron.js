// cron.js - VERSIÓN DEFINITIVA
const fetch = require('node-fetch');
const { enviarPush } = require('./services/firebase');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const getHeaders = () => ({
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
});

// ==========================================
// TAREA 1: NOTIFICACIONES PROGRAMADAS (cada 10s)
// ==========================================
async function procesarNotificacionesProgramadas() {
    const now = new Date();
    console.log('========================================');
    console.log(`⏰ CRON - ${now.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}`);
    console.log('========================================');
    
    try {
        // ✅ Obtener notificaciones pendientes usando la función RPC
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/rpc/obtener_notificaciones_pendientes`,
            {
                method: 'POST',
                headers: getHeaders()
            }
        );
        
        if (!response.ok) {
            console.error('❌ Error en RPC:', await response.text());
            return;
        }
        
        const programadas = await response.json();
        
        if (!programadas || programadas.length === 0) {
            console.log('✅ No hay notificaciones programadas pendientes');
            return;
        }
        
        console.log(`📬 Encontradas ${programadas.length} notificaciones pendientes`);
        
        for (const notif of programadas) {
            console.log(`📤 Enviando: "${notif.titulo}"`);
            console.log(`   Programada: ${notif.fecha_programada}`);
            
            // Obtener tokens FCM
            let fcmTokens = [];
            
            if (notif.enviar_a === 'todos') {
                const r = await fetch(
                    `${SUPABASE_URL}/rest/v1/usuarios?select=fcm_token&fcm_token=not.is.null`,
                    { headers: getHeaders() }
                );
                const usuarios = await r.json();
                fcmTokens = usuarios.map(u => u.fcm_token).filter(Boolean);
                console.log(`   Tokens: ${fcmTokens.length}`);
                
            } else if (notif.android_ids && notif.android_ids.length > 0) {
                const ids = notif.android_ids.map(id => `"${id}"`).join(',');
                const r = await fetch(
                    `${SUPABASE_URL}/rest/v1/usuarios?android_id=in.(${ids})&select=fcm_token&fcm_token=not.is.null`,
                    { headers: getHeaders() }
                );
                const usuarios = await r.json();
                fcmTokens = usuarios.map(u => u.fcm_token).filter(Boolean);
                console.log(`   Tokens: ${fcmTokens.length}`);
            }
            
            // Enviar push
            if (fcmTokens.length > 0) {
                const datosFirebase = {
                    tipo: notif.tipo || 'info',
                    screen: 'notificaciones',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK',
                    id_notificacion: notif.id,
                };
                
                const resultado = await enviarPush(
                    fcmTokens,
                    notif.titulo,
                    notif.mensaje,
                    notif.imagen_url || null,
                    datosFirebase
                );
                console.log(`   ✅ Push: ${resultado.successCount} éxito, ${resultado.failureCount} fallos`);
            }
            
            // ✅ Marcar como enviada
            const markResponse = await fetch(
                `${SUPABASE_URL}/rest/v1/rpc/marcar_notificacion_enviada`,
                {
                    method: 'POST',
                    headers: getHeaders(),
                    body: JSON.stringify({ p_id: notif.id })
                }
            );
            
            if (markResponse.ok) {
                const result = await markResponse.json();
                if (result.success) {
                    console.log(`✅ Enviada: ${notif.titulo}`);
                }
            }
        }
        
    } catch (error) {
        console.error('❌ Error en cron:', error);
        console.error('   Stack:', error.stack);
    }
}

// ==========================================
// TAREA 2: EXPIRAR CÓDIGOS CADUCADOS (cada 1h)
// ==========================================
async function expirarCodigosCaducados() {
    try {
        const ahora = new Date().toISOString();
        
        console.log('----------------------------------------');
        console.log(`🕐 CRON EXPIRACIÓN - ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}`);
        
        // ✅ Buscar códigos usados cuya fecha_expiracion ya pasó
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/codigos_activacion?estado=eq.usado&fecha_expiracion=lt.${ahora}&select=id,codigo,vendedor_id,android_id_activado,fecha_expiracion`,
            { headers: getHeaders() }
        );
        
        if (!res.ok) {
            console.error('❌ Error consultando códigos:', await res.text());
            return;
        }
        
        const codigosCaducados = await res.json();
        
        if (!codigosCaducados || codigosCaducados.length === 0) {
            console.log('✅ No hay códigos caducados para expirar');
            return;
        }
        
        console.log(`🗑️ Encontrados ${codigosCaducados.length} códigos caducados`);
        
        // ✅ Marcar cada uno como 'expirado'
        let expirados = 0;
        for (const codigo of codigosCaducados) {
            const patchRes = await fetch(
                `${SUPABASE_URL}/rest/v1/codigos_activacion?id=eq.${codigo.id}`,
                {
                    method: 'PATCH',
                    headers: {
                        ...getHeaders(),
                        'Prefer': 'return=minimal'
                    },
                    body: JSON.stringify({ estado: 'expirado' })
                }
            );
            
            if (patchRes.ok) {
                expirados++;
                console.log(`   ✅ Expirado: ${codigo.codigo} (venció ${codigo.fecha_expiracion})`);
            } else {
                console.error(`   ❌ Error expirando: ${codigo.codigo}`);
            }
        }
        
        console.log(`✅ Total expirados: ${expirados}/${codigosCaducados.length}`);
        console.log('----------------------------------------');
        
    } catch (error) {
        console.error('❌ Error en cron de expiración:', error.message);
    }
}

// ==========================================
// 🚀 ARRANCAR CRONS
// ==========================================

// ✅ Tarea 1: Notificaciones cada 10 segundos
setInterval(procesarNotificacionesProgramadas, 10000);
procesarNotificacionesProgramadas(); // Ejecutar inmediatamente al arrancar

// ✅ Tarea 2: Expiración de códigos cada 1 hora (3600000 ms)
setInterval(expirarCodigosCaducados, 60 * 60 * 1000);
expirarCodigosCaducados(); // Ejecutar inmediatamente al arrancar

module.exports = {
    procesarNotificacionesProgramadas,
    expirarCodigosCaducados
};