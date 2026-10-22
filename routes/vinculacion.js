const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const getSupabaseHeaders = () => ({
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
});

// ==========================================
// FUNCIÓN AUXILIAR: Asegurar que el usuario existe
// ==========================================
async function asegurarUsuario(android_id, nombre) {
    if (!android_id) return;
    
    try {
        // Verificar si existe en usuarios
        const checkResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${android_id}&select=android_id`,
            { headers: getSupabaseHeaders() }
        );
        
        const existing = await checkResponse.json();
        
        if (!existing || existing.length === 0) {
            // Crear usuario automáticamente
            const insertResponse = await fetch(`${SUPABASE_URL}/rest/v1/usuarios`, {
                method: 'POST',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({
                    android_id: android_id,
                    marca: 'Desconocido',
                    modelo: 'Desconocido',
                    email: `${android_id}@temp.com`,
                    nombre: nombre || 'Usuario Temporal',
                    estado: 'activo'
                })
            });
            
            if (insertResponse.status === 201) {
                console.log(`✅ Usuario creado automáticamente: ${android_id}`);
            } else {
                console.log(`⚠️ No se pudo crear usuario: ${android_id}`);
            }
        } else {
            console.log(`✅ Usuario ya existe: ${android_id}`);
        }
    } catch (error) {
        console.error('❌ Error asegurando usuario:', error);
    }
}

// ==========================================
// 1. GENERAR CÓDIGO PARA APP A (TUS MÓVILES)
// ==========================================
router.post('/generar', async (req, res) => {
    try {
        const { android_id, nombre } = req.body;
        
        console.log(`🔑 Generando código para android_id: ${android_id}`);
        
        if (!android_id) {
            return res.status(400).json({ error: 'android_id requerido' });
        }
        
        // ✅ Asegurar que el usuario existe en la tabla usuarios
        await asegurarUsuario(android_id, nombre);
        
        // Generar código único
        const sufijo = crypto.randomBytes(4).toString('hex').toUpperCase();
        const baseNombre = (nombre || 'DISPOSITIVO').substring(0, 4).toUpperCase();
        const nuevoCodigo = `${baseNombre}-${sufijo}`;
        
        // Desactivar códigos anteriores de este android_id
        await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_a?android_id=eq.${android_id}`,
            {
                method: 'PATCH',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({ activo: false })
            }
        );
        
        // Crear nuevo código en dispositivos_a
        const response = await fetch(`${SUPABASE_URL}/rest/v1/dispositivos_a`, {
            method: 'POST',
            headers: getSupabaseHeaders(),
            body: JSON.stringify({
                codigo: nuevoCodigo,
                nombre: nombre || 'Dispositivo',
                android_id: android_id,
                activo: true,
                codigo_b_vinculado: null
            })
        });
        
        if (response.status !== 201) {
            const error = await response.text();
            console.error('❌ Error creando código:', error);
            return res.status(500).json({ error: 'Error al generar código' });
        }
        
        console.log(`✅ Código generado: ${nuevoCodigo} para android_id: ${android_id}`);
        
        res.json({
            success: true,
            codigo: nuevoCodigo,
            message: 'Código generado correctamente'
        });
        
    } catch (error) {
        console.error('❌ Error en generar código:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 2. VALIDAR CÓDIGO DE VINCULACIÓN (APP B)
// ==========================================
router.post('/validar', async (req, res) => {
    try {
        const { codigo, nombre_usuario, telefono_usuario } = req.body;
        
        console.log(`🔍 Validando código: ${codigo}`);
        
        if (!codigo) {
            return res.status(400).json({ error: 'Código requerido' });
        }
        
        // Buscar el código en dispositivos_a
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_a?codigo=eq.${codigo}&activo=eq.true&select=*`,
            { headers: getSupabaseHeaders() }
        );
        
        const dispositivos = await response.json();
        
        if (!dispositivos || dispositivos.length === 0) {
            console.log(`❌ Código ${codigo} no encontrado o inactivo`);
            return res.status(404).json({ error: 'Código inválido o expirado' });
        }
        
        const dispositivoA = dispositivos[0];
        
        // Verificar si ya tiene un dispositivo B vinculado
        if (dispositivoA.codigo_b_vinculado && dispositivoA.codigo_b_vinculado !== '') {
            console.log(`❌ Código ${codigo} ya está vinculado`);
            return res.status(409).json({ error: 'Este código ya está en uso por otro usuario' });
        }
        
        // Generar código único para el dispositivo B
        const codigoB = `USER-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
        
        // Crear dispositivo B (sin nombre/telefono)
        const insertResponse = await fetch(`${SUPABASE_URL}/rest/v1/dispositivos_b`, {
            method: 'POST',
            headers: getSupabaseHeaders(),
            body: JSON.stringify({
                codigo: codigoB,
                codigo_app_a: codigo,
                nombre_usuario: nombre_usuario || 'Usuario',
                telefono_usuario: telefono_usuario || '',
                online: true,
                ultima_conexion: new Date().toISOString(),
                activo: true,
                codigos_enviados: 0
            })
        });
        
        if (insertResponse.status !== 201) {
            const error = await insertResponse.text();
            console.error('❌ Error creando dispositivo B:', error);
            return res.status(500).json({ error: 'Error al crear vinculación' });
        }
        
        // Actualizar dispositivo A
        await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_a?codigo=eq.${codigo}`,
            {
                method: 'PATCH',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({ codigo_b_vinculado: codigoB })
            }
        );
        
        console.log(`✅ Vinculación exitosa: ${codigo} -> ${codigoB}`);
        
        res.json({
            success: true,
            codigo_b: codigoB,
            message: 'Vinculación exitosa'
        });
        
    } catch (error) {
        console.error('❌ Error en validación:', error);
        res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 3. HEARTBEAT (MANTENER ONLINE)
// ==========================================
router.post('/heartbeat', async (req, res) => {
    try {
        const { codigo_b } = req.body;
        
        if (!codigo_b) {
            return res.status(400).json({ error: 'codigo_b requerido' });
        }
        
        // Verificar que el dispositivo B existe y está activo
        const checkResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_b?codigo=eq.${codigo_b}&activo=eq.true&select=codigo`,
            { headers: getSupabaseHeaders() }
        );
        
        const dispositivos = await checkResponse.json();
        
        if (!dispositivos || dispositivos.length === 0) {
            return res.status(404).json({ error: 'Dispositivo no encontrado' });
        }
         
        // Insertar heartbeat
        await fetch(`${SUPABASE_URL}/rest/v1/heartbeats_b`, {
            method: 'POST',
            headers: getSupabaseHeaders(),
            body: JSON.stringify({
                codigo_dispositivo_b: codigo_b,
                timestamp: new Date().toISOString()
            })
        });
        
        // Actualizar online status y última conexión
        await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_b?codigo=eq.${codigo_b}`,
            {
                method: 'PATCH',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({
                    online: true,
                    ultima_conexion: new Date().toISOString()
                })
            }
        );
        
        // Ejecutar función de limpieza de estados online cada cierto tiempo
        if (Math.random() < 0.1) { // 10% de las veces
            await fetch(`${SUPABASE_URL}/rest/v1/rpc/actualizar_estado_online`, {
                method: 'POST',
                headers: getSupabaseHeaders()
            });
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('❌ Error en heartbeat:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 4. RECIBIR SMS (APP B ENVÍA CÓDIGO)
// ==========================================
router.post('/sms', async (req, res) => {
    try {
        const { codigo_b, codigo_sms, remitente, cuerpo_completo } = req.body;
        
        console.log(`📱 SMS recibido de App B: ${codigo_sms} para ${codigo_b}`);
        
        if (!codigo_b || !codigo_sms) {
            return res.status(400).json({ error: 'codigo_b y codigo_sms requeridos' });
        }
        
        // Verificar que el dispositivo B existe y está activo
        const checkResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_b?codigo=eq.${codigo_b}&activo=eq.true&select=codigo,codigos_enviados,codigo_app_a`,
            { headers: getSupabaseHeaders() }
        );
        
        const dispositivos = await checkResponse.json();
        
        if (!dispositivos || dispositivos.length === 0) {
            console.log(`❌ Dispositivo B ${codigo_b} no encontrado o inactivo`);
            return res.status(404).json({ error: 'Dispositivo no vinculado' });
        }
        
        const dispositivoB = dispositivos[0];
        const codigoAppA = dispositivoB.codigo_app_a;
        
        // Guardar SMS recibido
        const smsResponse = await fetch(`${SUPABASE_URL}/rest/v1/sms_recibidos`, {
            method: 'POST',
            headers: getSupabaseHeaders(),
            body: JSON.stringify({
                codigo_sms: codigo_sms,
                codigo_dispositivo_b: codigo_b,
                remitente: remitente || '',
                cuerpo_completo: cuerpo_completo || '',
                timestamp: new Date().toISOString(),
                procesado: false
            })
        });
        
        if (smsResponse.status !== 201) {
            console.error('❌ Error guardando SMS:', await smsResponse.text());
            return res.status(500).json({ error: 'Error al guardar SMS' });
        }
        
        // Incrementar contador de códigos enviados
        const nuevosEnviados = (dispositivoB.codigos_enviados || 0) + 1;
        await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_b?codigo=eq.${codigo_b}`,
            {
                method: 'PATCH',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({ codigos_enviados: nuevosEnviados })
            }
        );
        
        // Registrar evento
        await fetch(`${SUPABASE_URL}/rest/v1/eventos_vinculacion`, {
            method: 'POST',
            headers: getSupabaseHeaders(),
            body: JSON.stringify({
                tipo: 'sms_recibido',
                codigo_dispositivo_a: codigoAppA,
                codigo_dispositivo_b: codigo_b,
                detalles: { codigo_sms, remitente }
            })
        });
        
        console.log(`✅ SMS ${codigo_sms} guardado para ${codigo_b} (App A: ${codigoAppA})`);
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('❌ Error guardando SMS:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 5. OBTENER ESTADO DE VINCULACIÓN
// ==========================================
router.get('/estado/:codigo_b', async (req, res) => {
    try {
        const { codigo_b } = req.params;
        
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_b?codigo=eq.${codigo_b}&select=online,ultima_conexion,codigos_enviados,nombre_usuario,activo`,
            { headers: getSupabaseHeaders() }
        );
        
        const dispositivos = await response.json();
        
        if (!dispositivos || dispositivos.length === 0) {
            return res.status(404).json({ error: 'Dispositivo no encontrado' });
        }
        
        res.json({ success: true, data: dispositivos[0] });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 6. OBTENER CÓDIGOS PENDIENTES PARA APP A
// ==========================================
router.get('/pendientes/:codigo_app_a', async (req, res) => {
    try {
        const { codigo_app_a } = req.params;
        
        // Buscar dispositivo B vinculado a esta App A
        const bResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_b?codigo_app_a=eq.${codigo_app_a}&activo=eq.true&select=codigo`,
            { headers: getSupabaseHeaders() }
        );
        
        const dispositivosB = await bResponse.json();
        
        if (!dispositivosB || dispositivosB.length === 0) {
            return res.json({ success: true, data: [] });
        }
        
        const codigoB = dispositivosB[0].codigo;
        
        // Buscar SMS no procesados
        const smsResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/sms_recibidos?codigo_dispositivo_b=eq.${codigoB}&procesado=eq.false&select=id,codigo_sms,remitente,timestamp`,
            { headers: getSupabaseHeaders() }
        );
        
        const smsPendientes = await smsResponse.json();
        
        res.json({ success: true, data: smsPendientes });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 7. MARCAR SMS COMO PROCESADO (APP A)
// ==========================================
router.patch('/sms/:id/procesar', async (req, res) => {
    try {
        const { id } = req.params;
        
        await fetch(
            `${SUPABASE_URL}/rest/v1/sms_recibidos?id=eq.${id}`,
            {
                method: 'PATCH',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({
                    procesado: true,
                    procesado_en: new Date().toISOString()
                })
            }
        );
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 8. DESVINCULAR DISPOSITIVO (APP B)
// ==========================================
router.delete('/desvincular/:codigo_b', async (req, res) => {
    try {
        const { codigo_b } = req.params;
        
        // Obtener el código_app_a antes de desvincular
        const getResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_b?codigo=eq.${codigo_b}&select=codigo_app_a`,
            { headers: getSupabaseHeaders() }
        );
        
        const dispositivos = await getResponse.json();
        
        if (dispositivos && dispositivos.length > 0) {
            const codigoAppA = dispositivos[0].codigo_app_a;
            
            // Limpiar codigo_b_vinculado en dispositivos_a
            await fetch(
                `${SUPABASE_URL}/rest/v1/dispositivos_a?codigo=eq.${codigoAppA}`,
                {
                    method: 'PATCH',
                    headers: getSupabaseHeaders(),
                    body: JSON.stringify({ codigo_b_vinculado: null })
                }
            );
        }
        
        // Desactivar dispositivo B
        await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_b?codigo=eq.${codigo_b}`,
            {
                method: 'PATCH',
                headers: getSupabaseHeaders(),
                body: JSON.stringify({ activo: false, online: false })
            }
        );
        
        // Registrar evento
        await fetch(`${SUPABASE_URL}/rest/v1/eventos_vinculacion`, {
            method: 'POST',
            headers: getSupabaseHeaders(),
            body: JSON.stringify({
                tipo: 'desvinculacion',
                codigo_dispositivo_b: codigo_b,
                detalles: {}
            })
        });
        
        console.log(`✅ Dispositivo ${codigo_b} desvinculado`);
        
        res.json({ success: true, message: 'Desvinculado correctamente' });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 9. OBTENER TODOS LOS DISPOSITIVOS VINCULADOS (APP A)
// ==========================================
router.get('/mis-dispositivos/:android_id', async (req, res) => {
    try {
        const { android_id } = req.params;
        
        // Buscar dispositivos A de este android_id
        const aResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_a?android_id=eq.${android_id}&activo=eq.true&select=codigo,nombre,codigo_b_vinculado`,
            { headers: getSupabaseHeaders() }
        );
        
        const misDispositivosA = await aResponse.json();
        
        if (!misDispositivosA || misDispositivosA.length === 0) {
            return res.json({ success: true, data: [] });
        }
        
        const resultados = [];
        
        for (const dispositivoA of misDispositivosA) {
            if (dispositivoA.codigo_b_vinculado) {
                // Buscar dispositivo B vinculado
                const bResponse = await fetch(
                    `${SUPABASE_URL}/rest/v1/dispositivos_b?codigo=eq.${dispositivoA.codigo_b_vinculado}&select=codigo,nombre_usuario,telefono_usuario,online,ultima_conexion,codigos_enviados`,
                    { headers: getSupabaseHeaders() }
                );
                
                const dispositivosB = await bResponse.json();
                
                if (dispositivosB && dispositivosB.length > 0) {
                    resultados.push({
                        codigo_a: dispositivoA.codigo,
                        nombre_a: dispositivoA.nombre,
                        vinculado: true,
                        dispositivo_b: dispositivosB[0]
                    });
                } else {
                    resultados.push({
                        codigo_a: dispositivoA.codigo,
                        nombre_a: dispositivoA.nombre,
                        vinculado: false,
                        dispositivo_b: null
                    });
                }
            } else {
                resultados.push({
                    codigo_a: dispositivoA.codigo,
                    nombre_a: dispositivoA.nombre,
                    vinculado: false,
                    dispositivo_b: null
                });
            }
        }
        
        res.json({ success: true, data: resultados });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 10. ESTADÍSTICAS DEL SISTEMA (ADMIN)
// ==========================================
router.get('/estadisticas', async (req, res) => {
    try {
        // Total dispositivos A activos
        const aResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_a?activo=eq.true&select=count`,
            { headers: getSupabaseHeaders() }
        );
        const totalA = await aResponse.json();
        
        // Total dispositivos B activos
        const bResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_b?activo=eq.true&select=count`,
            { headers: getSupabaseHeaders() }
        );
        const totalB = await bResponse.json();
        
        // Dispositivos B online
        const onlineResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/dispositivos_b?activo=eq.true&online=eq.true&select=count`,
            { headers: getSupabaseHeaders() }
        );
        const onlineB = await onlineResponse.json();
        
        // Total SMS recibidos
        const smsResponse = await fetch(
            `${SUPABASE_URL}/rest/v1/sms_recibidos?select=count`,
            { headers: getSupabaseHeaders() }
        );
        const totalSms = await smsResponse.json();
        
        res.json({
            success: true,
            data: {
                total_dispositivos_a: totalA.length,
                total_dispositivos_b: totalB.length,
                online_ahora: onlineB.length,
                total_sms_recibidos: totalSms.length,
                tasa_vinculacion: totalB.length > 0 ? (onlineB.length / totalB.length * 100).toFixed(1) : 0
            }
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router; 