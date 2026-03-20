import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import { handleTestMessage, setIO } from "./bot.js";
import { getSession, updateSession, listHandovers } from "./memory.js";
import { Redis } from "@upstash/redis";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Inyectamos io en bot.js para eventos en tiempo real
setIO(io);

app.use(cookieParser());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const MY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

/* =========================================
   DESCARGADOR DE MEDIA (igual que tu código)
========================================= */
async function downloadMedia(mediaId) {
  try {
    const { data: mediaInfo } = await axios.get(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const { data: mediaBuffer } = await axios.get(mediaInfo.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: "arraybuffer"
    });
    return {
      base64: Buffer.from(mediaBuffer).toString("base64"),
      mimeType: mediaInfo.mime_type
    };
  } catch (error) {
    console.error("❌ Error descargando media:", error.message);
    return null;
  }
}

/* =========================================
   AUTH MIDDLEWARE (cookie simple)
========================================= */
const COOKIE = "pucarito_admin";

async function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: "No autorizado" });
  const valid = await redis.get(`admin:token:${token}`);
  if (!valid) return res.status(401).json({ error: "Sesión expirada" });
  req.adminToken = token;
  next();
}

/* =========================================
   RUTAS ADMIN — LOGIN / LOGOUT
========================================= */
app.post("/api/login", async (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  await redis.set(`admin:token:${token}`, "1", { ex: 60 * 60 * 8 }); // 8hs
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: 8 * 60 * 60 * 1000
  });
  res.json({ ok: true });
});

app.post("/api/logout", authMiddleware, async (req, res) => {
  await redis.del(`admin:token:${req.adminToken}`);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

/* =========================================
   RUTAS ADMIN — PANEL
========================================= */

// Listar conversaciones en HANDOVER
app.get("/api/conversaciones", authMiddleware, async (req, res) => {
  const lista = await listHandovers();
  res.json(lista);
});

// Responder al padre desde el panel
app.post("/api/responder", authMiddleware, async (req, res) => {
  const { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) return res.status(400).json({ error: "Faltan datos" });

  await sendMessage(telefono, mensaje);

  // Guardar respuesta del admin en el historial
  const session = await getSession(telefono);
  session.history = [...(session.history || []), {
    role: "model",
    parts: [{ text: `[Admin]: ${mensaje}` }]
  }];
  await updateSession(telefono, session);

  io.emit("mensaje_enviado", { telefono, mensaje, ts: Date.now() });
  res.json({ ok: true });
});

// Reactivar el bot
app.post("/api/reactivar", authMiddleware, async (req, res) => {
  const { telefono } = req.body;
  if (!telefono) return res.status(400).json({ error: "Falta teléfono" });

  const session = await getSession(telefono);
  session.status = "ACTIVE";
  session.greeted = true;
  session.isReturningUser = true;
  await updateSession(telefono, session);

  await sendMessage(telefono, "¡Hola de nuevo! 👋 Ya podés seguir escribiéndome. Soy Pucarito 🏫");
  io.emit("bot_reactivado", { telefono });
  res.json({ ok: true });
});

/* =========================================
   SIMULADOR LOCAL
========================================= */
app.post("/chat-local", async (req, res) => {
  try {
    const { message } = req.body;
    const respuesta = await handleTestMessage({
      from: "usuario_local_browser",
      type: "text",
      text: { body: message }
    });
    if (respuesta === null) {
      return res.json({ reply: "🤫 El bot está en silencio (Modo Humano activado)." });
    }
    res.json({ reply: respuesta });
  } catch (error) {
    console.error("\n🔥 ERROR GRAVE:", error);
    res.status(500).json({ reply: "❌ Error en el servidor. Revisá la terminal." });
  }
});

/* =========================================
   WEBHOOK DE WHATSAPP (Meta) — igual que tu código
========================================= */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === MY_TOKEN) {
    console.log("✅ Webhook verificado!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (!body.object) return res.sendStatus(404);

  const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return res.sendStatus(200);

  const from = message.from;
  const type = message.type;

  console.log(`📩 Mensaje de ${from} — tipo: ${type}`);

  let messageObj = { from, type };

  if (type === "text") {
    messageObj.text = message.text;

  } else if (type === "image") {
    const mediaId = message.image.id;
    const caption = message.image.caption || "";
    console.log(`🖼️ Imagen recibida (id: ${mediaId})`);
    messageObj.mediaData = await downloadMedia(mediaId);
    messageObj.text = { body: caption || "" };

  } else if (type === "audio") {
    const mediaId = message.audio.id;
    console.log(`🎙️ Audio recibido (id: ${mediaId})`);
    messageObj.mediaData = await downloadMedia(mediaId);
    messageObj.text = { body: "" };

  } else {
    console.log(`⚠️ Tipo no soportado: ${type}`);
    await sendMessage(from, "Por el momento solo puedo leer textos, imágenes y audios de voz. 😊");
    return res.sendStatus(200);
  }

  const respuestaBot = await handleTestMessage(messageObj);

  if (respuestaBot) {
    let numeroDestino = from;
    if (from === "5493816559383") numeroDestino = "54381156559383";
    await sendMessage(numeroDestino, respuestaBot);
  }

  res.sendStatus(200);
});

/* =========================================
   ENVÍO DE MENSAJES A WHATSAPP (igual que tu código)
========================================= */
async function sendMessage(to, text) {
  try {
    await axios({
      method: "POST",
      url: `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      data: {
        messaging_product: "whatsapp",
        to,
        text: { body: text },
      },
    });
    console.log(`🤖 Respuesta enviada: ${text.substring(0, 40)}...`);
  } catch (error) {
    console.error("❌ Error enviando a WhatsApp:", error.response?.data || error.message);
  }
}

/* =========================================
   MANEJO DE ERRORES NO CAPTURADOS
========================================= */
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Servidor listo en puerto ${PORT}`);
  console.log(`🔐 Panel admin → http://localhost:${PORT}/admin.html`);
  console.log(`👉 Simulador  → http://localhost:${PORT}/chat.html`);
});

export default app;