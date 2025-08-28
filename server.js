import express from "express";
import bodyParser from "body-parser";
import * as baileys from "@whiskeysockets/baileys";
import axios from "axios";
import qrcode from "qrcode-terminal";
import dotenv from "dotenv";

dotenv.config(); // Cargar variables de entorno

const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = baileys;

const app = express();
app.use(bodyParser.json());

let sock; // guardamos el socket aquí para usarlo en el endpoint

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    browser: ["Vibras Store", "Chrome", "121.0.0.0"]
  });

  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      console.log("📲 Escanea este QR:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ Conectado a WhatsApp");
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

// 🚀 Iniciar servidor Express y Baileys
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor HTTP escuchando en http://localhost:${PORT}`);
});

start();
