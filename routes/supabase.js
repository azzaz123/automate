const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const bcrypt = require('bcrypt');
const Stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Configuración de Supabase desde variables de entorno
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SALT_ROUNDS = 12;
const DURACION_DIAS = parseInt(process.env.DURACION_DIAS || '90');

// Headers para Supabase
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

// ✅ Precios de ampliaciones
function getAmpliacionPrecios() {
  return {
    1: parseFloat(process.env.AMPLIACION_1_PRECIO || '5.00'),
    2: parseFloat(process.env.AMPLIACION_2_PRECIO || '8.00'),
    5: parseFloat(process.env.AMPLIACION_5_PRECIO || '15.00'),
  };
}

// ==========================================
// FUNCIONES DE SEGURIDAD CON BCRYPT
// ==========================================

async function hashPassword(password) {
  if (!password) return null;
  try {
    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    const hash = await bcrypt.hash(password, salt);
    console.log('✅ Password hasheado con bcrypt');
    return hash;
  } catch (error) {
    console.error('❌ Error hasheando password:', error.message);
    return null;
  }
}

async function verifyPassword(password, hash) {
  if (!password || !hash) return false;
  try {
    const match = await bcrypt.compare(password, hash);
    console.log(`🔐 Verificación: ${match ? 'EXITOSA' : 'FALLIDA'}`);
    return match;
  } catch (error) {
    console.error('❌ Error verificando password:', error.message);
    return false;
  }
}

// ==========================================
// FUNCIÓN: Establecer contexto del usuario
// ==========================================
async function setUserContext(android_id, email, telefono) {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/app_set_context`, {
      method: 'POST',
      headers: getSupabaseHeaders(),
      body: JSON.stringify({
        p_android_id: android_id || '',
        p_email: email || '',
        p_telefono: telefono || ''
      })
    });
    
    if (!response.ok) {
      console.error('⚠️ Error al establecer contexto:', await response.text());
    }
    return response.ok;
  } catch (error) {
    console.error('❌ Error en setUserContext:', error);
    return false;
  }
}

// ==========================================
// FUNCIÓN: Validar código de activación
// ==========================================
async function validarCodigoActivacion(codigo, android_id) {
  try {
    console.log(`🔑 Validando código: ${codigo} para android_id: ${android_id}`);
    
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verificar_codigo_activacion`, {
      method: 'POST',
      headers: getSupabaseHeaders(),
      body: JSON.stringify({
        p_codigo: codigo,
        p_android_id: android_id
      })
    });
    
    if (!response.ok) {
      console.error('⚠️ Error al validar código:', await response.text());
      return { valido: false, mensaje: 'Error al validar el código' };
    }
    
    const resultado = await response.json();
    console.log(`   Resultado:`, resultado);
    
    return resultado;
  } catch (error) {
    console.error('❌ Error en validarCodigoActivacion:', error);
    return { valido: false, mensaje: 'Error interno al validar código' };
  }
}

// ==========================================
// FUNCIÓN: Registrar log de auditoría
// ==========================================
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
// 1. REGISTRAR O ACTUALIZAR USUARIO (CON BCRYPT)
// ==========================================
router.post('/usuarios', async (req, res) => {
  try {
    const datos = req.body;

    console.log('📊 Registrando/actualizando usuario en Supabase...');
    console.log(`   Android ID: ${datos.android_id}`);
    console.log('📦 Campos recibidos:', Object.keys(datos).join(', '));

    // ✅ CONSTRUIR EXPLÍCITAMENTE el objeto de datos completos
    const datosCompletosObj = {
      android_id: datos.android_id || 'N/A',
      marca: datos.marca || 'N/A',
      modelo: datos.modelo || 'N/A',
      version_android: datos.version_android || 'N/A',
      version_sdk: datos.version_sdk?.toString() || 'N/A',
      dispositivo: datos.dispositivo || '',
      producto: datos.producto || '',
      hardware: datos.hardware || '',
      es_fisico: datos.es_fisico !== false,
      fingerprint: datos.fingerprint || '',
      email: datos.email || '',
      password_hash: datos.password ? await hashPassword(datos.password) : null,
      nombre: datos.nombre || '',
      telefono: datos.telefono || '',
      // ✅ NUEVOS CAMPOS: asociación con NIE
      nie: datos.nie || '',
      nacionalidad: datos.nacionalidad || '',
      provincia: datos.provincia || '',
      telefono_cliente: datos.telefonoCliente || datos.telefono_cliente || '',
      estado: datos.estado || 'activo',
      fecha_activacion: datos.fecha_activacion || new Date().toISOString()
    };

    // ✅ VERIFICAR SI EL USUARIO YA EXISTE
    const checkResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${datos.android_id}&select=android_id,estado,password_hash`,
      { headers: getSupabaseHeaders() }
    );

    const existingUsers = await checkResponse.json();
    const existe = existingUsers && existingUsers.length > 0;

    // ==========================================
    // ✅ VALIDAR CÓDIGO Y PASSWORD
    // ==========================================
    const codigo = datos.codigo_activacion || datos.codigoActivacion || datos.codigo;

    // Si es NUEVO y no trae código → RECHAZAR
    if (!existe && !codigo) {
      console.log('❌ Nuevo usuario sin código de activación');

      await registrarLog(
        'registro_fallido',
        datos.android_id,
        'usuario',
        'Intento de registro sin código de activación',
        'rechazado',
        { motivo: 'Código no proporcionado' }
      );

      return res.status(400).json({
        success: false,
        error: 'Se requiere un código de activación válido para registrarse',
        codigo_requerido: true
      });
    }

    // Si es NUEVO y no trae password → RECHAZAR
    if (!existe && !datos.password) {
      console.log('❌ Nuevo usuario sin contraseña');
      return res.status(400).json({
        success: false,
        error: 'Se requiere una contraseña para crear la cuenta',
        password_requerida: true
      });
    }

    // Si es NUEVO y password muy corto → RECHAZAR
    if (!existe && datos.password && datos.password.length < 6) {
      console.log('❌ Contraseña muy corta');
      return res.status(400).json({
        success: false,
        error: 'La contraseña debe tener al menos 6 caracteres',
        password_invalida: true
      });
    }

    // Si viene un código → VALIDARLO
    if (codigo) {
      console.log(`🔑 Validando código de activación: ${codigo}`);

      const validacion = await validarCodigoActivacion(codigo, datos.android_id);

      if (!validacion.valido) {
        console.log(`❌ Código inválido: ${validacion.mensaje}`);

        await registrarLog(
          'activacion_fallida',
          datos.android_id,
          'usuario',
          `Código ${codigo}: ${validacion.mensaje}`,
          'rechazado',
          { codigo, motivo: validacion.mensaje }
        );

        return res.status(400).json({
          success: false,
          error: validacion.mensaje || 'Código de activación inválido',
          codigo_invalido: true
        });
      }

      console.log(`✅ Código válido y activado para: ${datos.android_id}`);

      // ✅ NUEVO: Setear fecha_uso y fecha_expiracion AL ACTIVAR
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
            nies_usados: [],          // ✅ Inicializar array
            max_nies: 2,              // ✅ Inicializar max_nies
            ampliaciones_compradas: 0 // ✅ Inicializar contador
          })
        }
      );

      console.log(`📅 Código ${codigo} activado. Expira en ${DURACION_DIAS} días: ${fechaExpiracion}`);

      await registrarLog(
        'activacion_exitosa',
        datos.android_id,
        'usuario',
        `Código ${codigo} activado correctamente`,
        'exito',
        {
          codigo,
          android_id: datos.android_id,
          valido_hasta: fechaExpiracion,
          duracion_dias: DURACION_DIAS
        }
      );
    }

    // Verificar si está bloqueado
    if (existe && existingUsers[0].estado === 'bloqueado') {
      return res.status(403).json({
        success: false,
        error: 'Usuario bloqueado. Contacta con soporte.'
      });
    }

    // Construir el body para Supabase
    const body = {
      android_id: datosCompletosObj.android_id,
      marca: datosCompletosObj.marca,
      modelo: datosCompletosObj.modelo,
      version_android: datosCompletosObj.version_android,
      version_sdk: datosCompletosObj.version_sdk,
      email: datosCompletosObj.email,
      password_hash: datosCompletosObj.password_hash,
      nombre: datosCompletosObj.nombre,
      telefono: datosCompletosObj.telefono,
      // ✅ NUEVOS CAMPOS
      nie: datosCompletosObj.nie,
      nacionalidad: datosCompletosObj.nacionalidad,
      provincia: datosCompletosObj.provincia,
      telefono_cliente: datosCompletosObj.telefono_cliente,
      // Fin nuevos campos
      dispositivo: datosCompletosObj.dispositivo,
      producto: datosCompletosObj.producto,
      hardware: datosCompletosObj.hardware,
      es_fisico: datosCompletosObj.es_fisico,
      fingerprint: datosCompletosObj.fingerprint,
      estado: datosCompletosObj.estado,
      ultima_conexion: new Date().toISOString(),
      datos_completos: datosCompletosObj
    };

    let response;
    if (existe) {
      console.log('📝 Usuario existe, actualizando...');

      const updateBody = {
        email: body.email,
        nombre: body.nombre,
        telefono: body.telefono,
        // ✅ NUEVOS CAMPOS
        nie: body.nie,
        nacionalidad: body.nacionalidad,
        provincia: body.provincia,
        telefono_cliente: body.telefono_cliente,
        // Fin nuevos campos
        ultima_conexion: body.ultima_conexion,
        datos_completos: body.datos_completos,
        marca: body.marca,
        modelo: body.modelo,
        version_android: body.version_android,
        version_sdk: body.version_sdk,
        dispositivo: body.dispositivo,
        producto: body.producto,
        hardware: body.hardware,
        es_fisico: body.es_fisico,
        fingerprint: body.fingerprint
      };

      if (datos.password && datosCompletosObj.password_hash) {
        updateBody.password_hash = datosCompletosObj.password_hash;
        console.log('🔐 Actualizando contraseña con bcrypt');
      }

      response = await fetch(
        `${SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${datos.android_id}`,
        {
          method: 'PATCH',
          headers: getSupabaseHeaders(),
          body: JSON.stringify(updateBody)
        }
      );
    } else {
      console.log('🆕 Nuevo usuario, creando con bcrypt...');

      body.fecha_activacion = datosCompletosObj.fecha_activacion;

      response = await fetch(`${SUPABASE_URL}/rest/v1/usuarios`, {
        method: 'POST',
        headers: getSupabaseHeaders(),
        body: JSON.stringify(body)
      });
    }

    if (response.status === 201 || response.status === 200 || response.status === 204) {
      await setUserContext(datos.android_id, datos.email, '');

      // ✅ Log para confirmar que el NIE quedó asociado
      console.log('✅ Usuario registrado/actualizado en Supabase');
      console.log(`   🆔 NIE asociado: ${datosCompletosObj.nie || '(vacío)'}`);
      console.log(`   🏛️ Nacionalidad: ${datosCompletosObj.nacionalidad || '(vacía)'}`);
      console.log(`   📍 Provincia: ${datosCompletosObj.provincia || '(vacía)'}`);
      console.log(`   📱 Tel. cliente: ${datosCompletosObj.telefono_cliente || '(vacío)'}`);

      const { password_hash, ...datosSeguros } = datosCompletosObj;

      res.json({
        success: true,
        message: existe ? 'Usuario actualizado' : 'Cuenta creada y activada correctamente',
        activado_con_codigo: !!codigo,
        campos_guardados: Object.keys(datosCompletosObj).length,
        nie_asociado: datosCompletosObj.nie || null
      });
    } else {
      const error = await response.text();
      console.error('❌ Error Supabase:', response.status, error);
      res.status(response.status).json({
        success: false,
        error: 'Error al guardar en Supabase',
        details: error
      });
    }
  } catch (error) {
    console.error('❌ Error guardando datos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// NUEVO: LOGIN CON EMAIL Y PASSWORD (BCRYPT)
// ==========================================
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    console.log(`🔐 Intento de login: ${email}`);
    
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Email y contraseña requeridos'
      });
    }
    
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?email=eq.${email}&select=*`,
      { headers: getSupabaseHeaders() }
    );
    
    const usuarios = await response.json();
    const usuario = usuarios[0];
    
    if (!usuario) {
      console.log('❌ Usuario no encontrado');
      
      await registrarLog(
        'login_fallido',
        email,
        'usuario',
        'Intento de login: usuario no encontrado',
        'rechazado',
        { email }
      );
      
      return res.status(404).json({
        success: false,
        error: 'Email o contraseña incorrectos'
      });
    }
    
    const passwordValido = await verifyPassword(password, usuario.password_hash);
    
    if (!passwordValido) {
      console.log('❌ Contraseña incorrecta');
      
      await registrarLog(
        'login_fallido',
        usuario.android_id,
        'usuario',
        'Intento de login: contraseña incorrecta',
        'rechazado',
        { email }
      );
      
      return res.status(401).json({
        success: false,
        error: 'Email o contraseña incorrectos'
      });
    }
    
    if (usuario.estado === 'bloqueado') {
      console.log('❌ Usuario bloqueado');
      return res.status(403).json({
        success: false,
        error: 'Usuario bloqueado. Contacta con soporte.'
      });
    }
    
    await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${usuario.android_id}`,
      {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({
          ultima_conexion: new Date().toISOString()
        })
      }
    );
    
    console.log(`✅ Login exitoso: ${email}`);
    
    await registrarLog(
      'login_exitoso',
      usuario.android_id,
      'usuario',
      'Inicio de sesión exitoso',
      'exito',
      { email }
    );
    
    const { password_hash, ...datosSeguros } = usuario;
    
    res.json({
      success: true,
      message: 'Login exitoso',
      usuario: datosSeguros
    });
    
  } catch (error) {
    console.error('❌ Error en login:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// NUEVO: CAMBIAR CONTRASEÑA
// ==========================================
router.post('/auth/cambiar-password', async (req, res) => {
  try {
    const { email, password_actual, password_nueva } = req.body;
    
    console.log(`🔑 Cambio de contraseña para: ${email}`);
    
    if (!email || !password_actual || !password_nueva) {
      return res.status(400).json({
        success: false,
        error: 'Todos los campos son requeridos'
      });
    }
    
    if (password_nueva.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'La nueva contraseña debe tener al menos 6 caracteres'
      });
    }
    
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?email=eq.${email}&select=*`,
      { headers: getSupabaseHeaders() }
    );
    
    const usuarios = await response.json();
    const usuario = usuarios[0];
    
    if (!usuario) {
      return res.status(404).json({
        success: false,
        error: 'Usuario no encontrado'
      });
    }
    
    const passwordValido = await verifyPassword(password_actual, usuario.password_hash);
    
    if (!passwordValido) {
      return res.status(401).json({
        success: false,
        error: 'Contraseña actual incorrecta'
      });
    }
    
    const nuevoHash = await hashPassword(password_nueva);
    
    await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${usuario.android_id}`,
      {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({ password_hash: nuevoHash })
      }
    );
    
    console.log(`✅ Contraseña actualizada para: ${email}`);
    
    await registrarLog(
      'password_cambiada',
      usuario.android_id,
      'usuario',
      'Contraseña actualizada exitosamente',
      'exito',
      { email }
    );
    
    res.json({
      success: true,
      message: 'Contraseña actualizada correctamente'
    });
    
  } catch (error) {
    console.error('❌ Error cambiando contraseña:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// VERIFICAR CÓDIGO SIN REGISTRAR USUARIO
// ==========================================
router.post('/usuarios/verificar-codigo', async (req, res) => {
  try {
    const { codigo, android_id } = req.body;
    
    if (!codigo) {
      return res.status(400).json({
        success: false,
        error: 'Código requerido'
      });
    }
    
    console.log(`🔍 Verificando código: ${codigo}`);
    
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}&select=estado,fecha_expiracion,android_id_activado`,
      { headers: getSupabaseHeaders() }
    );
    
    const codigos = await response.json();
    
    if (!codigos || codigos.length === 0) {
      return res.json({
        success: true,
        valido: false,
        mensaje: 'Código no encontrado'
      });
    }
    
    const codigoData = codigos[0];
    
    if (codigoData.estado === 'usado') {
      if (codigoData.android_id_activado === android_id) {
        return res.json({
          success: true,
          valido: false,
          mensaje: 'Ya has activado este código anteriormente'
        });
      } else {
        return res.json({
          success: true,
          valido: false,
          mensaje: 'Código ya utilizado en otro dispositivo'
        });
      }
    }
    
    if (codigoData.estado === 'expirado') {
      return res.json({
        success: true,
        valido: false,
        mensaje: 'Código expirado'
      });
    }
    
    if (codigoData.fecha_expiracion && new Date(codigoData.fecha_expiracion) < new Date()) {
      return res.json({
        success: true,
        valido: false,
        mensaje: 'Código expirado'
      });
    }
    
    if (codigoData.estado === 'disponible') {
      return res.json({
        success: true,
        valido: true,
        mensaje: '✅ Código válido - Crea tu cuenta',
        expira: codigoData.fecha_expiracion,
        duracion_dias: DURACION_DIAS
      });
    }
    
    return res.json({
      success: true,
      valido: false,
      mensaje: 'Código no disponible'
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// ✅ NUEVO: Obtener info del código activo del usuario
// ==========================================
// routes/supabase.js — modificar el GET /mi-codigo/:androidId
// routes/supabase.js — reemplaza el GET /mi-codigo/:androidId
router.get('/mi-codigo/:androidId', async (req, res) => {
  try {
    const { androidId } = req.params;
    if (!androidId) {
      return res.status(400).json({ success: false, error: 'android_id requerido' });
    }

    console.log(`🔍 Buscando código de: ${androidId}`);

    // 1. Último código del usuario SIN filtrar por fecha
    const todosRes = await fetch(
      `${SUPABASE_URL}/rest/v1/codigos_activacion?android_id_activado=eq.${androidId}&estado=eq.usado&select=codigo,fecha_uso,fecha_expiracion,estado,nies_usados,max_nies,ampliaciones_compradas&order=fecha_uso.desc&limit=1`,
      { headers: getSupabaseHeaders() }
    );
    const todos = await todosRes.json();
    const codigoData = todos?.[0];

    if (!codigoData) {
      return res.json({ success: true, data: null, tiene_codigo: false, motivo: 'sin_codigo' });
    }

    // 2. ¿Caducado?
    const ahoraMs = Date.now();
    const expiraMs = codigoData.fecha_expiracion
      ? new Date(codigoData.fecha_expiracion).getTime()
      : 0;
    const caducado = expiraMs > 0 && expiraMs < ahoraMs;

    // 3. Construir info de NIE (con o sin citas)
    const nies = codigoData.nies_usados || [];
    const niesConCitas = await Promise.all(
      nies.map(async (nie) => {
        const citasResponse = await fetch(
          `${SUPABASE_URL}/rest/v1/citas_notificadas?android_id=eq.${androidId}&nie=eq.${nie}&select=id,fecha_cita,fecha_notificacion&order=fecha_notificacion.desc`,
          { headers: getSupabaseHeaders() }
        );
        const citas = await citasResponse.json();
        return {
          nie: nie,
          total_citas: citas.length,
          ultima_cita: citas[0]?.fecha_notificacion || null,
        };
      })
    );

    const dataCompleta = {
      codigo: codigoData.codigo,
      fecha_uso: codigoData.fecha_uso,
      fecha_expiracion: codigoData.fecha_expiracion,
      nies_usados: niesConCitas,
      total_nies: nies.length,
      max_nies: codigoData.max_nies || 2,
      ampliaciones_compradas: codigoData.ampliaciones_compradas || 0,
      puede_ampliar: (codigoData.ampliaciones_compradas || 0) < 5,
      bloqueado: nies.length >= (codigoData.max_nies || 2),
      caducado: caducado,
    };

    if (caducado) {
      // ✅ Devolvemos la info para que la app muestre aviso de caducado
      return res.json({
        success: true,
        data: dataCompleta,
        tiene_codigo: false,
        motivo: 'caducado',
        caducado: true,
      });
    }

    return res.json({
      success: true,
      data: dataCompleta,
      tiene_codigo: true,
      motivo: 'vigente',
      caducado: false,
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// ==========================================
// ✅ NUEVO: Precios de ampliaciones (PÚBLICO)
// ==========================================
router.get('/precios-ampliaciones', async (req, res) => {
  try {
    const AMPLIACION_PRECIOS = getAmpliacionPrecios();
    const MAX_AMPLIACIONES_POR_CODIGO = parseInt(process.env.MAX_AMPLIACIONES_POR_CODIGO || '5');
    
    res.json({
      success: true,
      precios: [
        { cantidad: 1, precio: AMPLIACION_PRECIOS[1], moneda: 'EUR' },
        { cantidad: 2, precio: AMPLIACION_PRECIOS[2], moneda: 'EUR' },
        { cantidad: 5, precio: AMPLIACION_PRECIOS[5], moneda: 'EUR' },
      ],
      max_ampliaciones: MAX_AMPLIACIONES_POR_CODIGO,
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ✅ NUEVO: Crear PaymentIntent para ampliación (APP CLIENTE)
// ==========================================
router.post('/crear-payment-intent-ampliacion', async (req, res) => {
  try {
    const { cantidad, codigo } = req.body;
    const AMPLIACION_PRECIOS = getAmpliacionPrecios();
    
    if (!AMPLIACION_PRECIOS[cantidad]) {
      return res.status(400).json({ error: 'Cantidad inválida. Debe ser 1, 2 o 5' });
    }
    
    if (!codigo) {
      return res.status(400).json({ error: 'Código requerido' });
    }
    
    // Verificar que el código existe y está usado
    const checkResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}&estado=eq.usado&select=*`,
      { headers: getSupabaseHeaders() }
    );
    const codigos = await checkResponse.json();
    const codigoData = codigos?.[0];
    
    if (!codigoData) {
      return res.status(404).json({ error: 'Código no encontrado o no está activo' });
    }
    
    const MAX_AMPLIACIONES_POR_CODIGO = parseInt(process.env.MAX_AMPLIACIONES_POR_CODIGO || '5');
    const ampliacionesActuales = codigoData.ampliaciones_compradas || 0;
    
    if (ampliacionesActuales >= MAX_AMPLIACIONES_POR_CODIGO) {
      return res.status(400).json({ 
        error: `Este código ya ha alcanzado el máximo de ${MAX_AMPLIACIONES_POR_CODIGO} ampliaciones` 
      });
    }
    
    const precio = AMPLIACION_PRECIOS[cantidad];
    
    console.log(`💳 Creando PaymentIntent AMPLIACIÓN (app cliente): ${cantidad} NIE - ${precio}€ - Código: ${codigo}`);
    
    const paymentIntent = await Stripe.paymentIntents.create({
      amount: Math.round(precio * 100),
      currency: 'eur',
      metadata: {
        tipo: 'ampliacion',
        codigo: codigo,
        cantidad: cantidad.toString(),
        precio: precio.toString(),
      }
    });
    
    res.json({
      success: true,
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      cantidad: cantidad,
      precio: precio,
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ✅ NUEVO: Confirmar pago de ampliación (APP CLIENTE)
// ==========================================
router.post('/confirmar-pago-ampliacion', async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    
    console.log(`✅ Confirmando pago AMPLIACIÓN (app cliente): ${payment_intent_id}`);
    
    const paymentIntent = await Stripe.paymentIntents.retrieve(payment_intent_id);
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'El pago no se ha completado' });
    }
    
    const codigo = paymentIntent.metadata.codigo;
    const cantidad = parseInt(paymentIntent.metadata.cantidad);
    const precio = parseFloat(paymentIntent.metadata.precio);
    
    // Obtener el código actual
    const checkResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}&select=*`,
      { headers: getSupabaseHeaders() }
    );
    const codigos = await checkResponse.json();
    const codigoData = codigos?.[0];
    
    if (!codigoData) {
      return res.status(404).json({ error: 'Código no encontrado' });
    }
    
    const nuevoMaxNies = (codigoData.max_nies || 2) + cantidad;
    const nuevasAmpliaciones = (codigoData.ampliaciones_compradas || 0) + 1;
    
    // Actualizar el código
    await fetch(
      `${SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${codigo}`,
      {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({
          max_nies: nuevoMaxNies,
          ampliaciones_compradas: nuevasAmpliaciones,
        })
      }
    );
    
    // Guardar histórico
    await fetch(`${SUPABASE_URL}/rest/v1/ampliaciones_codigo`, {
      method: 'POST',
      headers: getSupabaseHeaders(),
      body: JSON.stringify({
        codigo: codigo,
        cantidad: cantidad,
        precio: precio,
        stripe_payment_intent: payment_intent_id,
        vendedor_id: codigoData.vendedor_id,
      })
    });
    
    await registrarLog('ampliacion_comprada', codigoData.vendedor_id || 'usuario', 'usuario',
      `Ampliación +${cantidad} NIE para código ${codigo} - ${precio}€`, 'exito',
      { codigo, cantidad, precio, nuevo_max: nuevoMaxNies });
    
    console.log(`✅ Ampliación OK: +${cantidad} NIE → max ahora ${nuevoMaxNies}`);
    
    res.json({
      success: true,
      message: `Ampliación de +${cantidad} NIE completada`,
      codigo: codigo,
      cantidad: cantidad,
      precio: precio,
      nuevo_max_nies: nuevoMaxNies,
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 2. GUARDAR CITA
// ==========================================
router.post('/citas', async (req, res) => {
  try {
    const datos = req.body;
    
    console.log('📊 Guardando cita en Supabase...');
    console.log('📱 Datos del dispositivo incluidos:', {
      android_id: datos.android_id,
      marca: datos.marca_dispositivo,
      modelo: datos.modelo_dispositivo
    });
    
    if (!datos.android_id) {
      return res.status(400).json({
        success: false,
        error: 'android_id es requerido para guardar la cita'
      });
    }
    
    await setUserContext(datos.android_id, datos.email, datos.telefonoCliente);
    
    const body = {
      justificante: datos.justificante || 'N/A',
      titular: datos.titular || 'N/A',
      nie: datos.nie || 'N/A',
      oficina: datos.oficina || 'N/A',
      provincia: datos.provincia || 'No especificada',
      fecha_cita: parseDate(datos.fecha),
      hora_cita: datos.hora || '00:00',
      mesa: datos.mesa?.toString(),
      telefono: datos.telefono || 'N/A',
      telefono_cliente: datos.telefonoCliente || datos.telefono_cliente || '',
      email: datos.email || '',
      nombre_cliente: datos.nombre_cliente || datos.nombreCliente || '',
      android_id: datos.android_id,
      marca_dispositivo: datos.marca_dispositivo || '',
      modelo_dispositivo: datos.modelo_dispositivo || '',
      version_android: datos.version_android || '',
      version_sdk: datos.version_sdk?.toString() || '',
      es_fisico: datos.es_fisico?.toString() || 'true',
      estado: 'pendiente',
      caducidad: calculateExpiry(datos.fecha)
    };

    const response = await fetch(`${SUPABASE_URL}/rest/v1/citas`, {
      method: 'POST',
      headers: getSupabaseHeaders(),
      body: JSON.stringify(body)
    });

    if (response.status === 201) {
      console.log('✅ Cita guardada en Supabase');
      
      await registrarLog(
        'cita_guardada',
        datos.android_id,
        'usuario',
        `Cita guardada: ${datos.justificante || 'N/A'}`,
        'exito'
      );
      
      res.json({ success: true, message: 'Cita guardada correctamente' });
    } else {
      const error = await response.text();
      console.error('❌ Error Supabase:', response.status, error);
      res.status(response.status).json({
        success: false,
        error: 'Error al guardar cita',
        details: error
      });
    }
  } catch (error) {
    console.error('❌ Error guardando cita:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 3. OBTENER DATOS DEL USUARIO (SIN PASSWORD)
// ==========================================
router.get('/usuarios/:androidId', async (req, res) => {
  try {
    const { androidId } = req.params;
    
    if (!androidId) {
      return res.status(400).json({ success: false, error: 'android_id requerido' });
    }
    
    console.log(`🔍 Buscando usuario: ${androidId}`);
    
    await setUserContext(androidId, '', '');
    
    // ✅ AÑADIDO: telefono y otros campos al select
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${androidId}&select=android_id,email,nombre,telefono,estado,marca,modelo,version_android,version_sdk,dispositivo,producto,hardware,es_fisico,fingerprint,fecha_activacion,ultima_conexion`,
      { headers: getSupabaseHeaders() }
    );

    if (response.status === 200) {
      const data = await response.json();
      const usuario = data[0] || null;
      
      if (usuario) {
        console.log(`✅ Usuario: ${usuario.android_id}, estado: ${usuario.estado}`);
        return res.json({
          success: true,
          data: usuario
        });
      } else {
        return res.json({ success: true, data: null });
      }
    } else {
      return res.status(response.status).json({ success: false, error: 'Error al consultar' });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 4. BLOQUEAR USUARIO (SOLO ADMIN)
// ==========================================
router.post('/usuarios/bloquear', async (req, res) => {
  try {
    const { android_id, motivo } = req.body;
    
    console.log('🔒 [ADMIN] BLOQUEANDO USUARIO');
    console.log('   android_id:', android_id);
    console.log('   motivo:', motivo);
    
    if (!android_id) {
      return res.status(400).json({ success: false, error: 'android_id requerido' });
    }
    
    const checkResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${android_id}&select=android_id,estado`,
      { headers: getSupabaseHeaders() }
    );
    
    const existingUsers = await checkResponse.json();
    
    if (!existingUsers || existingUsers.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Usuario con android_id ${android_id} no encontrado`
      });
    }
    
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${android_id}`,
      {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({
          estado: 'bloqueado',
          notas_admin: motivo || 'Bloqueado por administrador'
        })
      }
    );
    
    if (response.status === 200 || response.status === 204) {
      console.log(`✅ Usuario ${android_id} BLOQUEADO correctamente`);
      
      await registrarLog(
        'usuario_bloqueado',
        android_id,
        'admin',
        `Usuario bloqueado: ${motivo || 'Sin motivo'}`,
        'exito'
      );
      
      res.json({ success: true, message: 'Usuario bloqueado correctamente' });
    } else {
      const error = await response.text();
      res.status(response.status).json({
        success: false,
        error: 'Error al bloquear usuario',
        details: error
      });
    }
  } catch (error) {
    console.error('❌ Error en bloqueo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 5. DESBLOQUEAR USUARIO (SOLO ADMIN)
// ==========================================
router.post('/usuarios/desbloquear', async (req, res) => {
  try {
    const { android_id } = req.body;
    
    console.log('🔓 [ADMIN] DESBLOQUEANDO USUARIO:', android_id);
    
    if (!android_id) {
      return res.status(400).json({ success: false, error: 'android_id requerido' });
    }
    
    const checkResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${android_id}&select=android_id,estado`,
      { headers: getSupabaseHeaders() }
    );
    
    const existingUsers = await checkResponse.json();
    
    if (!existingUsers || existingUsers.length === 0) {
      return res.status(404).json({
        success: false,
        error: `Usuario no encontrado`
      });
    }
    
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${android_id}`,
      {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({ estado: 'activo' })
      }
    );
    
    if (response.status === 200 || response.status === 204) {
      console.log(`✅ Usuario ${android_id} DESBLOQUEADO`);
      
      await registrarLog(
        'usuario_desbloqueado',
        android_id,
        'admin',
        'Usuario desbloqueado',
        'exito'
      );
      
      res.json({ success: true, message: 'Usuario desbloqueado correctamente' });
    } else {
      const error = await response.text();
      res.status(response.status).json({ success: false, error: 'Error', details: error });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 6. OBTENER CITAS DEL USUARIO
// ==========================================
router.get('/citas/usuario/:androidId', async (req, res) => {
  try {
    const { androidId } = req.params;
    
    if (!androidId) {
      return res.status(400).json({ success: false, error: 'android_id requerido' });
    }
    
    await setUserContext(androidId, '', '');
    
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/citas?android_id=eq.${androidId}&select=*&order=fecha_cita.desc`,
      { headers: getSupabaseHeaders() }
    );

    if (response.status === 200) {
      const data = await response.json();
      console.log(`📋 ${data.length} citas para usuario ${androidId}`);
      res.json({ success: true, data });
    } else {
      res.status(response.status).json({ success: false, error: 'Error al obtener citas' });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 7. OBTENER ESTADÍSTICAS DEL USUARIO
// ==========================================
router.get('/estadisticas/:androidId', async (req, res) => {
  try {
    const { androidId } = req.params;
    
    await setUserContext(androidId, '', '');
    
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/get_mis_estadisticas`,
      {
        method: 'POST',
        headers: getSupabaseHeaders()
      }
    );

    if (response.status === 200) {
      const data = await response.json();
      res.json({ success: true, data: data[0] || {} });
    } else {
      res.status(response.status).json({ success: false, error: 'Error al obtener estadísticas' });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 8-17. RESTO DE ENDPOINTS
// ==========================================

router.put('/citas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { estado, android_id } = req.body;
    
    if (!android_id) {
      return res.status(400).json({ success: false, error: 'android_id requerido' });
    }
    
    await setUserContext(android_id, '', '');
    
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/citas?id=eq.${id}&android_id=eq.${android_id}`,
      {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({ estado, notas_admin: req.body.notas_admin })
      }
    );

    if (response.status === 200 || response.status === 204) {
      res.json({ success: true, message: 'Cita actualizada' });
    } else {
      res.status(response.status).json({ success: false, error: 'Error al actualizar' });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/citas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { android_id } = req.body;
    
    if (!android_id) {
      return res.status(400).json({ success: false, error: 'android_id requerido' });
    }
    
    await setUserContext(android_id, '', '');
    
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/citas?id=eq.${id}&android_id=eq.${android_id}`,
      {
        method: 'DELETE',
        headers: getSupabaseHeaders()
      }
    );

    if (response.status === 200 || response.status === 204) {
      res.json({ success: true, message: 'Cita eliminada' });
    } else {
      res.status(response.status).json({ success: false, error: 'Error al eliminar' });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/citas/admin/todas', async (req, res) => {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/citas?select=*&order=fecha_creacion.desc`,
      { headers: getSupabaseHeaders() }
    );

    if (response.status === 200) {
      const data = await response.json();
      console.log(`📊 Admin: ${data.length} citas totales`);
      res.json({ success: true, data });
    } else {
      res.status(response.status).json({ success: false, error: 'Error al obtener citas' });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// ✅ PARCHE APLICADO: AÑADIDO telefono Y OTROS CAMPOS
// ==========================================
router.get('/usuarios/admin/todos', async (req, res) => {
  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?select=android_id,email,nombre,telefono,estado,marca,modelo,version_android,version_sdk,dispositivo,producto,hardware,es_fisico,fingerprint,fecha_activacion,ultima_conexion&order=fecha_activacion.desc`,
      { headers: getSupabaseHeaders() }
    );

    if (response.status === 200) {
      const data = await response.json();
      console.log(`📊 Admin: ${data.length} usuarios totales`);
      res.json({ success: true, data });
    } else {
      res.status(response.status).json({ success: false, error: 'Error al obtener usuarios' });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/citas/:id/notas', async (req, res) => {
  try {
    const { id } = req.params;
    const { notas_admin } = req.body;
    
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/citas?id=eq.${id}`,
      {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({ notas_admin })
      }
    );

    if (response.status === 200 || response.status === 204) {
      console.log(`✅ Notas actualizadas para cita: ${id}`);
      res.json({ success: true, message: 'Notas actualizadas' });
    } else {
      res.status(response.status).json({ success: false, error: 'Error al actualizar notas' });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/citas/:id/estado', async (req, res) => {
  try {
    const { id } = req.params;
    const { estado } = req.body;
    
    if (!estado || !['pendiente', 'completada'].includes(estado)) {
      return res.status(400).json({ success: false, error: 'Estado inválido' });
    }
    
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/citas?id=eq.${id}`,
      {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({ estado })
      }
    );

    if (response.status === 200 || response.status === 204) {
      console.log(`✅ Estado actualizado: ${id} -> ${estado}`);
      res.json({ success: true, message: 'Estado actualizado' });
    } else {
      res.status(response.status).json({ success: false, error: 'Error al actualizar estado' });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/citas/admin/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/citas?id=eq.${id}`,
      {
        method: 'DELETE',
        headers: getSupabaseHeaders()
      }
    );

    if (response.status === 200 || response.status === 204) {
      console.log(`✅ Cita eliminada: ${id}`);
      res.json({ success: true, message: 'Cita eliminada' });
    } else {
      res.status(response.status).json({ success: false, error: 'Error al eliminar cita' });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/admin/stats', async (req, res) => {
  try {
    const citasRes = await fetch(`${SUPABASE_URL}/rest/v1/citas?select=id,estado,fecha_cita`, { headers: getSupabaseHeaders() });
    const citas = await citasRes.json();
    
    const usuariosRes = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?select=id,estado,marca,modelo,version_android`, { headers: getSupabaseHeaders() });
    const usuarios = await usuariosRes.json();
    
    const hoy = new Date().toISOString().split('T')[0];
    
    const stats = {
      total_citas: citas.length,
      citas_pendientes: citas.filter(c => c.estado === 'pendiente' || c.fecha_cita >= hoy).length,
      citas_completadas: citas.filter(c => c.estado === 'completada' || c.fecha_cita < hoy).length,
      total_usuarios: usuarios.length,
      usuarios_activos: usuarios.filter(u => u.estado === 'activo').length,
      usuarios_bloqueados: usuarios.filter(u => u.estado === 'bloqueado').length,
      dispositivos_por_marca: {},
      versiones_android: {}
    };
    
    usuarios.forEach(u => {
      if (u.marca) stats.dispositivos_por_marca[u.marca] = (stats.dispositivos_por_marca[u.marca] || 0) + 1;
      if (u.version_android) stats.versiones_android[u.version_android] = (stats.versiones_android[u.version_android] || 0) + 1;
    });
    
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/citas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const response = await fetch(`${SUPABASE_URL}/rest/v1/citas?id=eq.${id}`, { headers: getSupabaseHeaders() });
    const data = await response.json();
    res.json({ success: true, data: data[0] || null });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/admin/usuarios/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userRes = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?id=eq.${id}`, { headers: getSupabaseHeaders() });
    const usuario = (await userRes.json())[0] || null;
    
    let citas = [];
    if (usuario) {
      const citasRes = await fetch(`${SUPABASE_URL}/rest/v1/citas?android_id=eq.${usuario.android_id}`, { headers: getSupabaseHeaders() });
      citas = await citasRes.json();
    }
    
    if (usuario) delete usuario.password_hash;
    
    res.json({ success: true, data: usuario, citas });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/usuarios/:androidId/codigos', async (req, res) => {
  try {
    const { androidId } = req.params;
    
    console.log(`🔍 Verificando códigos de: ${androidId}`);
    
    const ahora = new Date().toISOString();
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/codigos_activacion?android_id_activado=eq.${androidId}&estado=eq.usado&fecha_expiracion=gte.${ahora}&select=codigo,fecha_uso,fecha_expiracion`,
      { headers: getSupabaseHeaders() }
    );
    
    if (response.ok) {
      const codigos = await response.json();
      console.log(`   Códigos válidos: ${codigos.length}`);
      
      res.json({
        success: true,
        data: codigos,
        tiene_codigo: codigos.length > 0
      });
    } else {
      res.json({ success: true, data: [], tiene_codigo: false });
    }
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// FUNCIONES AUXILIARES
// ==========================================
function parseDate(dateString) {
  if (!dateString || dateString === 'N/A') return null;
  try {
    const parts = dateString.split('/');
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const month = parts[1].padStart(2, '0');
      const year = parts[2];
      return `${year}-${month}-${day}`;
    }
    return dateString;
  } catch (e) {
    console.error('Error parseando fecha:', e);
    return null;
  }
}

function calculateExpiry(dateString) {
  if (!dateString || dateString === 'N/A') return null;
  try {
    const parts = dateString.split('/');
    if (parts.length === 3) {
      const fecha = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
      fecha.setDate(fecha.getDate() + 30);
      return fecha.toISOString().split('T')[0];
    }
  } catch (e) {
    console.error('Error calculando caducidad:', e);
  }
  return null;
}

// ==========================================
// ✅ NUEVO: Precio de compra directa (PÚBLICO)
// ==========================================
router.get('/precio-directo', async (req, res) => {
  try {
    const PRECIO_DIRECTO = parseFloat(process.env.COMPRA_DIRECTA_PRECIO || '20.00');
    const DURACION_DIAS = parseInt(process.env.DURACION_DIAS || '90');
    const APP_DIRECTA_ID = process.env.APP_DIRECTA_VENDEDOR_ID;
    
    if (!APP_DIRECTA_ID) {
      console.error('❌ APP_DIRECTA_VENDEDOR_ID no configurado');
      return res.status(500).json({ error: 'Compra directa no disponible' });
    }
    
    res.json({
      success: true,
      precio: PRECIO_DIRECTO,
      moneda: 'EUR',
      duracion_dias: DURACION_DIAS,
      duracion_meses: Math.round(DURACION_DIAS / 30),
      max_nies: 2,
      disponible: true,
    });
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ✅ NUEVO: Crear PaymentIntent para compra directa
// ==========================================
router.post('/comprar-codigo-directo', async (req, res) => {
  try {
    const PRECIO_DIRECTO = parseFloat(process.env.COMPRA_DIRECTA_PRECIO || '20.00');
    const APP_DIRECTA_ID = process.env.APP_DIRECTA_VENDEDOR_ID;
    
    if (!APP_DIRECTA_ID) {
      return res.status(500).json({ error: 'Compra directa no configurada' });
    }
    
    console.log(`💳 Creando PaymentIntent COMPRA DIRECTA - ${PRECIO_DIRECTO}€ - Vendedor: ${APP_DIRECTA_ID}`);
    
    const paymentIntent = await Stripe.paymentIntents.create({
      amount: Math.round(PRECIO_DIRECTO * 100),
      currency: 'eur',
      metadata: {
        tipo: 'compra_directa',
        precio: PRECIO_DIRECTO.toString(),
        vendedor_id: APP_DIRECTA_ID,
      }
    });
    
    res.json({
      success: true,
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      precio: PRECIO_DIRECTO,
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ✅ NUEVO: Confirmar pago directo
// ==========================================
router.post('/confirmar-compra-directa', async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    const APP_DIRECTA_ID = process.env.APP_DIRECTA_VENDEDOR_ID;
    
    if (!payment_intent_id) {
      return res.status(400).json({ error: 'payment_intent_id requerido' });
    }
    
    if (!APP_DIRECTA_ID) {
      return res.status(500).json({ error: 'Compra directa no configurada' });
    }
    
    console.log(`✅ Confirmando COMPRA DIRECTA: ${payment_intent_id}`);
    
    // 1. Verificar el pago
    const paymentIntent = await Stripe.paymentIntents.retrieve(payment_intent_id);
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'El pago no se ha completado' });
    }
    
    const precio = parseFloat(paymentIntent.metadata.precio || '20.00');
    
    // 2. Crear el código
    const codigo = `${Math.floor(1000000000 + Math.random() * 9000000000)}`;
    
    const insertResponse = await fetch(`${SUPABASE_URL}/rest/v1/codigos_activacion`, {
      method: 'POST',
      headers: { ...getSupabaseHeaders(), 'Prefer': 'return=representation' },
      body: JSON.stringify({
        codigo: codigo,
        vendedor_id: APP_DIRECTA_ID,
        estado: 'disponible',
        precio_compra: precio,
        fecha_compra: new Date().toISOString(),
        fecha_expiracion: null,
        max_nies: 2,
        ampliaciones_compradas: 0,
        nies_usados: [],
        stripe_session_id: payment_intent_id,
        stripe_payment_status: 'completed',
      })
    });
    
    if (insertResponse.status !== 201) {
      const error = await insertResponse.text();
      console.error('❌ Error creando código:', error);
      return res.status(500).json({ error: 'Error al crear código' });
    }
    
    const codigoData = await insertResponse.json();
    
    await registrarLog('compra_directa_exitosa', 'app_directa', 'usuario',
      `Compra directa: código ${codigo} por ${precio}€`, 'exito',
      { codigo, precio, vendedor_id: APP_DIRECTA_ID, stripe_payment_intent: payment_intent_id });
    
    console.log(`✅ Código directo creado: ${codigo}`);
    
    res.json({
      success: true,
      codigo: codigo,
      precio: precio,
      message: 'Código comprado correctamente',
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: error.message });
  }
});
// ==========================================
// ✅ NUEVO: Renovar código de activación
// ==========================================
router.post('/renovar-codigo', async (req, res) => {
  try {
    const { android_id, nuevo_codigo } = req.body;

    if (!android_id || !nuevo_codigo) {
      return res.status(400).json({
        success: false,
        error: 'android_id y nuevo_codigo son requeridos'
      });
    }

    if (nuevo_codigo.length !== 10) {
      return res.status(400).json({
        success: false,
        error: 'El código debe tener 10 dígitos'
      });
    }

    console.log(`🔄 Renovando código para ${android_id} con ${nuevo_codigo}`);

    // 1. Verificar que el usuario existe
    const userRes = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?android_id=eq.${android_id}&select=android_id,estado`,
      { headers: getSupabaseHeaders() }
    );
    const usuarios = await userRes.json();
    const usuario = usuarios?.[0];

    if (!usuario) {
      return res.status(404).json({
        success: false,
        error: 'Usuario no encontrado'
      });
    }

    if (usuario.estado === 'bloqueado') {
      return res.status(403).json({
        success: false,
        error: 'Usuario bloqueado. Contacta con soporte.'
      });
    }

    // 2. Verificar que el nuevo código existe y está disponible
    const codRes = await fetch(
      `${SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${nuevo_codigo}&select=codigo,estado,android_id_activado,fecha_expiracion`,
      { headers: getSupabaseHeaders() }
    );
    const codigos = await codRes.json();
    const codigoData = codigos?.[0];

    if (!codigoData) {
      return res.json({
        success: false,
        error: 'El código no existe'
      });
    }

    if (codigoData.estado === 'usado' && codigoData.android_id_activado !== android_id) {
      return res.json({
        success: false,
        error: 'Este código ya fue usado en otro dispositivo'
      });
    }

    if (codigoData.estado === 'expirado') {
      return res.json({
        success: false,
        error: 'Este código está expirado'
      });
    }

    if (codigoData.fecha_expiracion && new Date(codigoData.fecha_expiracion) < new Date()) {
      return res.json({
        success: false,
        error: 'Este código ha expirado'
      });
    }

    // 3. Marcar el código ANTIGUO como expirado (si existe)
    const ahora = new Date().toISOString();
    const antiguaRes = await fetch(
      `${SUPABASE_URL}/rest/v1/codigos_activacion?android_id_activado=eq.${android_id}&estado=eq.usado&fecha_expiracion=gte.${ahora}&select=codigo`,
      { headers: getSupabaseHeaders() }
    );
    const codigosAntiguos = await antiguaRes.json();

    if (codigosAntiguos && codigosAntiguos.length > 0) {
      for (const c of codigosAntiguos) {
        // Solo marcar expirado si NO es el mismo que estamos renovando
        if (c.codigo !== nuevo_codigo) {
          await fetch(
            `${SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${c.codigo}`,
            {
              method: 'PATCH',
              headers: getSupabaseHeaders(),
              body: JSON.stringify({
                estado: 'expirado',
                fecha_expiracion: ahora
              })
            }
          );
          console.log(`   Código antiguo ${c.codigo} marcado como expirado`);
        }
      }
    }

    // 4. Activar el nuevo código (o renovar el mismo)
    const fechaExpiracion = calcularFechaExpiracion(new Date());

    await fetch(
      `${SUPABASE_URL}/rest/v1/codigos_activacion?codigo=eq.${nuevo_codigo}`,
      {
        method: 'PATCH',
        headers: getSupabaseHeaders(),
        body: JSON.stringify({
          estado: 'usado',
          android_id_activado: android_id,
          fecha_uso: ahora,
          fecha_expiracion: fechaExpiracion,
          nies_usados: [],
          max_nies: 2,
          ampliaciones_compradas: 0
        })
      }
    );

    console.log(`✅ Código renovado: ${nuevo_codigo} para ${android_id}`);

    // 5. Log
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/registrar_log`, {
      method: 'POST',
      headers: getSupabaseHeaders(),
      body: JSON.stringify({
        p_tipo: 'codigo_renovado',
        p_usuario_id: android_id,
        p_usuario_tipo: 'usuario',
        p_descripcion: `Código renovado a ${nuevo_codigo}`,
        p_resultado: 'exito',
        p_detalles: { nuevo_codigo, fecha_expiracion: fechaExpiracion }
      })
    });

    res.json({
      success: true,
      message: 'Código renovado correctamente',
      data: {
        codigo: nuevo_codigo,
        fecha_uso: ahora,
        fecha_expiracion: fechaExpiracion,
        max_nies: 2,
        nies_usados: [],
      }
    });

  } catch (error) {
    console.error('❌ Error renovando código:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;