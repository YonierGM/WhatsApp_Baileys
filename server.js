import express from "express";
import bodyParser from "body-parser";
import * as baileys from "@whiskeysockets/baileys";
import axios from "axios";
import qrcode from "qrcode";
import dotenv from "dotenv";
import { Pool } from 'pg';

dotenv.config();

const { makeWASocket, fetchLatestBaileysVersion, DisconnectReason, initAuthCreds } = baileys;

const app = express();
app.use(bodyParser.json());

// Configuración de PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_nKmEVaLOJp50@ep-super-cake-ad7sisiw-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require',
  ssl: {
    rejectUnauthorized: false
  }
});

// Variables globales para el estado
let sock = null;
let qrCode = null;
let isConnected = false;

// Crear tabla si no existe
(async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_auth (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Tabla de autenticación verificada/creada');
  } catch (error) {
    console.error('❌ Error al inicializar la base de datos:', error);
  }
})();

// Funciones para serializar/deserializar con soporte para Buffer
function serialize(data) {
  return JSON.stringify(data, (key, value) => {
    if (value instanceof Buffer) {
      return {
        __type: 'Buffer',
        data: Array.from(value)
      };
    }
    // Manejar otros tipos especiales si es necesario
    return value;
  });
}

function deserialize(str) {
  return JSON.parse(str, (key, value) => {
    if (value && typeof value === 'object' && value.__type === 'Buffer' && Array.isArray(value.data)) {
      return Buffer.from(value.data);
    }
    return value;
  });
}

// Función para simular useMultiFileAuthState pero con PostgreSQL
async function usePostgresAuthState() {
  // Inicializar credenciales vacías
  let creds = initAuthCreds();
  let keys = {};

  try {
    // Leer todas las credenciales existentes
    const result = await pool.query('SELECT key, value FROM whatsapp_auth');
    
    for (const row of result.rows) {
      try {
        const data = deserialize(row.value);
        
        if (row.key === 'creds') {
          creds = data;
        } else {
          keys[row.key] = data;
        }
      } catch (parseError) {
        console.error(`Error parsing data for key ${row.key}:`, parseError);
        // Si falla la deserialización, eliminar la clave corrupta
        await pool.query('DELETE FROM whatsapp_auth WHERE key = $1', [row.key]);
      }
    }
  } catch (error) {
    console.error('Error reading auth data from DB:', error);
  }

  const saveCreds = async () => {
    try {
      const credsValue = serialize(creds);
      await pool.query(
        `INSERT INTO whatsapp_auth (key, value, updated_at) VALUES ('creds', $1, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
        [credsValue]
      );
    } catch (error) {
      console.error('Error saving creds to DB:', error);
    }
  };

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const key = `${type}-${ids.join(',')}`;
          const value = keys[key];
          
          // Para sesiones, asegurarse de que tengan la estructura correcta
          if (type === 'session' && value && typeof value === 'object') {
            // Si la sesión no tiene la estructura esperada, intentar repararla
            if (!value.session && value.registrationId !== undefined) {
              console.log(`Reparando estructura de sesión para key ${key}`);
              return {
                session: value
              };
            }
          }
          
          return value || undefined;
        },
        set: (data) => {
          const promises = [];
          
          for (const [key, value] of Object.entries(data)) {
            keys[key] = value;
            
            // Guardar en base de datos
            const valueStr = serialize(value);
            const queryPromise = pool.query(
              `INSERT INTO whatsapp_auth (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
               ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
              [key, valueStr]
            ).catch(err => console.error(`Error saving key ${key} to DB:`, err));
              
            promises.push(queryPromise);
          }
          
          // Esperar a que todas las operaciones de base de datos se completen
          return Promise.all(promises);
        }
      }
    },
    saveCreds
  };
}

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await usePostgresAuthState();
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      browser: ["Vibras Store", "Chrome", "121.0.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      transactionOpts: {
        maxCommitRetries: 1,
        delayBetweenTriesMs: 1000
      }
    });

    sock.ev.on("connection.update", async (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        console.log("QR recibido, mostrando en interfaz web");
        qrCode = await qrcode.toDataURL(qr);
        isConnected = false;
      }

      if (connection === "open") {
        isConnected = true;
        qrCode = null;
        console.log("✅ Conectado a WhatsApp");
        
        // Forzar guardado de credenciales tras conexión exitosa
        await saveCreds();
      }

      if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode;
        if (reason === DisconnectReason.loggedOut) {
          console.log("❌ Sesión cerrada, escanea nuevamente.");
          isConnected = false;
          // Limpiar base de datos al cerrar sesión
          try {
            await pool.query('DELETE FROM whatsapp_auth');
            console.log('✅ Datos de autenticación eliminados tras cierre de sesión');
          } catch (error) {
            console.error('Error limpiando datos de autenticación:', error);
          }
        } else {
          console.log("⚠️ Conexión cerrada, intentando reconectar...");
          isConnected = false;
          // Reconectar después de un breve retraso
          setTimeout(connectToWhatsApp, 5000);
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);

    // 📩 Recibir mensajes y enviarlos a n8n
    sock.ev.on("messages.upsert", async ({ messages }) => {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";

      console.log(`📩 Mensaje de ${from}: ${text}`);

      try {
        const resp = await axios.post(process.env.WEBHOOK_URL, { from, text });

        const reply = resp.data?.reply;
        if (reply) {
          await sock.sendMessage(from, { text: reply });
          console.log(`✅ Respuesta enviada: ${reply}`);
        }
      } catch (err) {
        console.error("❌ Error al enviar a n8n:", err.message);
      }
    });
  } catch (error) {
    console.error('Error en la función connectToWhatsApp:', error);
    setTimeout(connectToWhatsApp, 5000);
  }
}

// Endpoint para obtener el estado de conexión y QR
app.get('/connection-status', async (req, res) => {
  if (isConnected) {
    res.json({ connected: true, message: "Conectado a WhatsApp" });
  } else if (qrCode) {
    res.json({ connected: false, qr: qrCode, message: "Escanea el código QR" });
  } else {
    res.json({ connected: false, message: "Conectando..." });
  }
});

// Endpoint para mostrar el QR
app.get('/qr', async (req, res) => {
  if (qrCode) {
    // Devolver el QR como imagen
    const qrImage = Buffer.from(qrCode.split(',')[1], 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': qrImage.length
    });
    res.end(qrImage);
  } else if (isConnected) {
    res.status(400).json({ error: "Ya está conectado, no hay QR disponible" });
  } else {
    res.status(400).json({ error: "QR no disponible aún" });
  }
});

// 📤 Endpoint para enviar mensajes desde n8n
app.post("/sendMessage", async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(400).json({ error: "WhatsApp no está conectado" });
  }

  try {
    const { chatId, message } = req.body;
    if (!chatId || !message) {
      return res.status(400).json({ error: "Faltan parámetros chatId o message" });
    }

    await sock.sendMessage(chatId, { text: message });
    res.json({ status: "success", sent: message });

  } catch (error) {
    console.error("Error enviando mensaje:", error);
    res.status(500).json({ error: "No se pudo enviar el mensaje" });
  }
});

// Health check endpoint para mantener la instancia activa
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connected: isConnected,
    timestamp: new Date().toISOString()
  });
});

// 🚀 Iniciar servidor Express y Baileys
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor HTTP escuchando en http://localhost:${PORT}`);
  connectToWhatsApp().catch(err => {
    console.error('Error al iniciar la aplicación:', err);
    process.exit(1);
  });
});

// Manejar cierre graceful
process.on('SIGINT', async () => {
  console.log('Recibido SIGINT. Cerrando conexiones...');
  if (sock) {
    await sock.end();
  }
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Recibido SIGTERM. Cerrando conexiones...');
  if (sock) {
    await sock.end();
  }
  await pool.end();
  process.exit(0);
});