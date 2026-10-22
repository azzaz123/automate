// backend/routes/captcha.js
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY;
const CAPTCHA_TIMEOUT = 120000; // 2 minutos

// ==========================================
// RESOLVER CAPTCHA
// ==========================================
router.post('/resolver', async (req, res) => {
  try {
    const { imagenBase64 } = req.body;

    // Validar que hay imagen
    if (!imagenBase64) {
      return res.status(400).json({ 
        success: false, 
        error: 'Imagen base64 requerida' 
      });
    }

    // Validar API Key configurada
    if (!CAPTCHA_API_KEY || CAPTCHA_API_KEY === 'tu_api_key_de_2captcha') {
      return res.status(500).json({ 
        success: false, 
        error: 'API Key de 2Captcha no configurada en el servidor' 
      });
    }

    console.log('🤖 2CAPTCHA: Enviando captcha para resolver...');

    // Limpiar base64 si tiene prefijo
    let base64Data = imagenBase64;
    if (base64Data.includes(',')) {
      base64Data = base64Data.split(',').pop();
    }

    // 1. Crear tarea en 2Captcha
    const createResponse = await fetch('https://api.2captcha.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: CAPTCHA_API_KEY,
        task: {
          type: 'ImageToTextTask',
          body: base64Data,
          phrase: false,
          case: false,
          numeric: 0,
          math: false,
          minLength: 1,
          maxLength: 10,
        },
      }),
    });

    const createResult = await createResponse.json();

    if (createResult.errorId !== 0 || !createResult.taskId) {
      console.error('❌ 2CAPTCHA Error:', createResult.errorDescription || 'Desconocido');
      return res.status(500).json({ 
        success: false, 
        error: createResult.errorDescription || 'Error al crear tarea' 
      });
    }

    const taskId = createResult.taskId.toString();
    console.log(`✅ 2CAPTCHA Task ID: ${taskId}`);

    // 2. Esperar resultado (polling)
    const startTime = Date.now();
    let intentos = 0;

    while (Date.now() - startTime < CAPTCHA_TIMEOUT) {
      intentos++;
      
      // Esperar 5 segundos entre intentos
      await new Promise(resolve => setTimeout(resolve, 5000));

      const getResponse = await fetch('https://api.2captcha.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: CAPTCHA_API_KEY,
          taskId: taskId,
        }),
      });

      const getResult = await getResponse.json();

      if (getResult.errorId !== 0) {
        console.error('❌ 2CAPTCHA Error:', getResult.errorDescription);
        return res.status(500).json({ 
          success: false, 
          error: getResult.errorDescription 
        });
      }

      if (getResult.status === 'ready') {
        const solucion = getResult.solution.text;
        console.log(`🎉 2CAPTCHA Resuelto: "${solucion}" (${intentos} intentos)`);
        return res.json({ 
          success: true, 
          solucion: solucion,
          intentos: intentos,
          tiempo: Date.now() - startTime
        });
      }

      console.log(`⏳ 2CAPTCHA Intento ${intentos} - Esperando...`);
    }

    // Timeout
    console.error('❌ 2CAPTCHA Timeout');
    return res.status(408).json({ 
      success: false, 
      error: 'Timeout al resolver captcha' 
    });

  } catch (error) {
    console.error('❌ Error en servicio captcha:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ==========================================
// VERIFICAR SALDO DE 2CAPTCHA (Opcional)
// ==========================================
router.get('/saldo', async (req, res) => {
  try {
    if (!CAPTCHA_API_KEY) {
      return res.status(500).json({ 
        success: false, 
        error: 'API Key no configurada' 
      });
    }

    const response = await fetch(
      `https://api.2captcha.com/getBalance?key=${CAPTCHA_API_KEY}`
    );
    const result = await response.json();

    if (result.errorId === 0) {
      return res.json({ 
        success: true, 
        saldo: result.balance 
      });
    } else {
      return res.status(500).json({ 
        success: false, 
        error: result.errorDescription 
      });
    }
  } catch (error) {
    return res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }  
});   
 
module.exports = router;  