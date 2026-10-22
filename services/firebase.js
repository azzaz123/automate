// services/firebase.js - VERSIÓN CON SONIDO FORZADO
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN
};

if (getApps().length === 0) {
    initializeApp({ credential: cert(serviceAccount) });
    console.log('✅ Firebase Admin inicializado');
}

async function enviarPush(fcmTokens, titulo, mensaje, imagenUrl = null, datos = {}) {
    if (!fcmTokens || fcmTokens.length === 0) {
        console.log('⚠️ No hay tokens FCM');
        return { successCount: 0, failureCount: 0 };
    }

    const tokensValidos = fcmTokens.filter(t => t && t.length > 50);
    
    if (tokensValidos.length === 0) {
        console.log('⚠️ No hay tokens FCM válidos');
        return { successCount: 0, failureCount: fcmTokens.length };
    }

    console.log('📤 ENVIANDO PUSH:', titulo, '-', mensaje);
    console.log('📱 Tokens válidos:', tokensValidos.length);

    const message = {
        tokens: tokensValidos,
        
        notification: {
            title: titulo || '',
            body: mensaje || '',
            ...(imagenUrl && { image: imagenUrl }),
        },
        
        data: {
            title: titulo || '',
            body: mensaje || '',
            tipo: datos.tipo || 'info',
            screen: datos.screen || 'notificaciones',
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
            timestamp: new Date().toISOString(),
            ...(datos.tipo_notificacion && { tipo_notificacion: datos.tipo_notificacion }),
            ...(datos.id_cita && { id_cita: String(datos.id_cita) }),
            ...(datos.url && { url: datos.url }),
        },
        
        android: {
            priority: 'high',
            ttl: 86400,
            notification: {
                // ✅ SONIDO: 'default' para usar el sonido del canal
                sound: 'default',
                priority: 'high',
                channelId: 'citas_channel',
                ...(imagenUrl && { 
                    image: imagenUrl,
                    bigPicture: imagenUrl,
                }),
                color: '#f59e0b',
                title: titulo || '',
                body: mensaje || '',
                defaultSound: true,
            },
        },
        
        apns: {
            payload: {
                aps: {
                    sound: 'default',
                    contentAvailable: true,
                    ...(imagenUrl && { 'mutable-content': 1 }),
                },
            },
            ...(imagenUrl && {
                fcm_options: {
                    image: imagenUrl,
                },
            }),
        },
    };

    try {
        const response = await getMessaging().sendEachForMulticast(message);
        
        if (response.failureCount > 0) {
            console.log('⚠️ Fallos en envío:');
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    console.log(`   Token ${idx}: ${resp.error?.message || 'Error desconocido'}`);
                }
            });
        }
        
        console.log('✅ Firebase respuesta:', {
            success: response.successCount,
            failure: response.failureCount,
        });
        
        return { 
            successCount: response.successCount, 
            failureCount: response.failureCount,
            responses: response.responses
        };
        
    } catch (error) {
        console.error('❌ Error Firebase:', error.message);
        if (error.stack) console.error(error.stack);
        return { successCount: 0, failureCount: tokensValidos.length };
    }
}

module.exports = { enviarPush };