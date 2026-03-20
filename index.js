import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { handleTestMessage } from "./bot.js";
import { getSession, updateSession, listHandovers } from "./memory.js";
import { Redis } from "@upstash/redis";

dotenv.config();

const app = express();

// Necesario para Railway/Render/Vercel (proxy delante del servidor)
app.set("trust proxy", 1);

// ── Seguridad: headers HTTP ──────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
  );
  next();
});

// ── Rate limiting ────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Demasiados intentos. Esperá 15 minutos." },
  validate: { xForwardedForHeader: false },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  validate: { xForwardedForHeader: false },
});

app.use(cookieParser());
app.use(express.json());

// 🔥 ESTA LÍNEA HACE LA MAGIA AHORA 🔥
// Le dice a tu servidor que muestre directamente lo que hay en la carpeta "public"
app.use(express.static("public")); 

const MY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

/* =========================================
   DESCARGADOR DE MEDIA
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
   AUTH
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
   RUTAS ADMIN — AUTH
========================================= */
app.post("/api/login", loginLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  await redis.set(`admin:token:${token}`, "1", { ex: 60 * 60 * 8 });
  const isProd = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,  // true en Vercel (HTTPS), false en localhost (HTTP)
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
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
   (polling cada 3s desde el admin.html)
========================================= */
app.get("/api/conversaciones", authMiddleware, apiLimiter, async (req, res) => {
  const lista = await listHandovers();
  res.json(lista);
});

app.post("/api/responder", authMiddleware, apiLimiter, async (req, res) => {
  const { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) return res.status(400).json({ error: "Faltan datos" });

  const enviado = await sendMessage(telefono, mensaje);
  if (!enviado) {
    return res.status(500).json({ error: "No se pudo enviar el mensaje a WhatsApp. Verificá el token." });
  }

  const session = await getSession(telefono);
  session.history = [...(session.history || []), {
    role: "model",
    parts: [{ text: `[Admin]: ${mensaje}` }]
  }];
  await updateSession(telefono, session);
  res.json({ ok: true });
});

app.post("/api/reactivar", authMiddleware, apiLimiter, async (req, res) => {
  const { telefono } = req.body;
  if (!telefono) return res.status(400).json({ error: "Falta teléfono" });

  const session = await getSession(telefono);
  session.status = "ACTIVE";
  session.greeted = true;
  session.isReturningUser = true;
  await updateSession(telefono, session);

  await sendMessage(telefono, "¡Hola de nuevo! 👋 Ya podés seguir escribiéndome. Soy Pucarito 🏫");
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
    res.json({ reply: respuesta ?? "🤫 El bot está en silencio (Modo Humano)." });
  } catch (error) {
    console.error("🔥 ERROR:", error);
    res.status(500).json({ reply: "❌ Error en el servidor." });
  }
});

/* =========================================
   WEBHOOK WHATSAPP
========================================= */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === MY_TOKEN) {
    console.log("✅ Webhook verificado!");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
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
    messageObj.mediaData = await downloadMedia(message.image.id);
    messageObj.text = { body: message.image.caption || "" };
  } else if (type === "audio") {
    messageObj.mediaData = await downloadMedia(message.audio.id);
    messageObj.text = { body: "" };
  } else {
    await sendMessage(from, "Por el momento solo puedo leer textos, imágenes y audios de voz. 😊");
    return res.sendStatus(200);
  }

  const respuestaBot = await handleTestMessage(messageObj);
  if (respuestaBot) {
    const destino = from === "5493816559383" ? "54381156559383" : from;
    await sendMessage(destino, respuestaBot);
  }

  res.sendStatus(200);
});

/* =========================================
   ENVÍO A WHATSAPP
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
      data: { messaging_product: "whatsapp", to, text: { body: text } },
    });
    console.log(`🤖 Enviado a ${to}: ${text.substring(0, 40)}...`);
    return true;
  } catch (error) {
    console.error("❌ Error enviando a WhatsApp:", error.response?.data || error.message);
    return false;
  }
}

process.on("unhandledRejection", (reason) => console.error("❌ Unhandled:", reason));
process.on("uncaughtException", (err) => console.error("❌ Uncaught:", err));

// Para Vercel: exportamos el app SIN llamar a listen()
// Para local: si no estamos en Vercel, iniciamos el servidor normal
if (process.env.VERCEL !== "1") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
    console.log(`🔐 Panel admin → http://localhost:${PORT}/admin.html`);
  });
}

export default app;