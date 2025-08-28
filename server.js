import express from "express";
import bodyParser from "body-parser";
import * as baileys from "@whiskeysockets/baileys";
import axios from "axios";
import qrcode from "qrcode";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const { makeWASocket, fetchLatestBaileysVersion, DisconnectReason, initAuthCreds, BufferJSON } = baileys;

const app = express();
app.use(bodyParser.json());

let sock;
let qrImageBase64 = null;

// 📦 Asegurar tabla y guardar credenciales
async function saveCreds(creds, keys) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      id INT PRIMARY KEY,
      creds JSONB NOT NULL,
      keys JSONB NOT NULL
    )
  `);

  await pool.query(
    `INSERT INTO whatsapp_auth (id, creds, keys) 
     VALUES (1, $1, $2) 
     ON CONFLICT (id) DO UPDATE 
     SET creds = $1, keys = $2`,
    [JSON.stringify(creds, BufferJSON.replacer), JSON.stringify(keys, BufferJSON.replacer)]
  );
}

// 📦 Cargar credenciales desde la base de datos
async function loadCreds() {
  const res = await pool.query(`SELECT creds, keys FROM whatsapp_auth WHERE id = 1`);
  if (res.rows.length) {
    return {
      creds: JSON.parse(res.rows[0].creds, BufferJSON.reviver),
      keys: JSON.parse(res.rows[0].keys, BufferJSON.reviver)
    };
  }
  return { creds: initAuthCreds(), keys: {} };
}

async function start() {
  const { version } = await fetchLatestBaileysVersion();
  const { creds, keys } = await loadCreds();

  const state = {
    creds,
    keys: {
      get: (type, ids) => (ids ? ids.map(id => keys[type]?.[id] || null) : []),
      set: (data) => {
        for (const type in data) {
          keys[type] = keys[type] || {};
          Object.assign(keys[type], data[type]);
        }
        saveCreds(state.creds, keys);
      }
    }
  };

  sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    browser: ["Vibras Store", "Chrome", "121.0.0.0"]
  });

  sock.ev.on("creds.update", async () => {
    await saveCreds(state.creds, keys);
  });

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;
    if (qr) {
      qrImageBase64 = await qrcode.toDataURL(qr);
      console.log(`📲 Escanea el QR en: http://localhost:${process.env.PORT || 3000}/qr`);
    }
    if (connection === "open") {
      console.log("✅ Conectado a WhatsApp");
      qrImageBase64 = null;
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log("⚠️ Reconectando...");
        start();
      } else {
        console.log("❌ Sesión cerrada. Escanea nuevamente.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;
    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
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
}

// Enviar mensajes desde n8n
app.post("/sendMessage", async (req, res) => {
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

// Ver QR en navegador
app.get("/qr", (req, res) => {
  if (!qrImageBase64) {
    return res.send("QR no generado o ya conectado.");
  }
  res.send(`<img src="${qrImageBase64}" />`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor HTTP escuchando en http://localhost:${PORT}`);
});

start();
