import express from "express";
import bodyParser from "body-parser";
import * as baileys from "@whiskeysockets/baileys";
import axios from "axios";
import qrcode from "qrcode";
import dotenv from "dotenv";

dotenv.config();

const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = baileys;

const app = express();
app.use(bodyParser.json());

let sock;
let qrImageBase64 = null; // guardaremos aquí el QR como imagen

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    browser: ["Vibras Store", "Chrome", "121.0.0.0"]
  });

  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      // Generar imagen en Base64 para mostrar en navegador
      qrImageBase64 = await qrcode.toDataURL(qr);
      console.log(`📲 QR generado. Visita http://localhost:${process.env.PORT || 3000}/qr para escanear.`);
    }

    if (connection === "open") {
      console.log("✅ Conectado a WhatsApp");
      qrImageBase64 = null; // limpiar QR después de conectar
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log("⚠️ Conexión cerrada, intentando reconectar...");
        start();
      } else {
        console.log("❌ Sesión cerrada, escanea nuevamente.");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

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
}

// 📤 Endpoint para enviar mensajes desde n8n
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

// Endpoint para ver el QR
app.get("/qr", (req, res) => {
  if (!qrImageBase64) {
    return res.send("QR no generado aún o ya estás conectado.");
  }
  res.send(`<img src="${qrImageBase64}" />`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor HTTP escuchando en http://localhost:${PORT}`);
});

start();
