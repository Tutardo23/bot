import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import { handleTestMessage, setIO } from "./bot.js";
import { getSession, updateSession, listHandovers } from "./memory.js";
import { Redis } from "@upstash/redis";

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: false }, // Sin CORS abierto — mismo origen
  cookie: true,
});

setIO(io);

/* ─────────────────────────────────────────────
   SEGURIDAD — HEADERS (helmet)
   Agrega ~15 headers de seguridad de una vez:
   CSP, X-Frame-Options, HSTS, etc.
───────────────────────────────────────────── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdnjs.cloudflare.com"], // socket.io CDN
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "wss:"],
      imgSrc: ["'self'", "data:"],
      frameguard: { action: "deny" }, // Anti-clickjacking
    },
  },
  hsts: {
    maxAge: 31536000, // 1 año — fuerza HTTPS en navegadores
    includeSubDomains: true,
  },
}));

app.use(cookieParser());
app.use(express.json({ limit: "50kb" })); // Límite de payload para evitar DoS
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const MY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET; // ← NUEVO: App Secret de Meta
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  console.error("❌ ADMIN_PASSWORD no definida o menor a 8 caracteres. Agregala al .env");
  process.exit(1);
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

/* ─────────────────────────────────────────────
   SEGURIDAD — RATE LIMITING
───────────────────────────────────────────── */

// Login: máx 10 intentos cada 15 minutos por IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Demasiados intentos. Esperá 15 minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

// API general del panel: 100 requests/minuto por IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: "Demasiadas requests. Esperá un momento." },
});

// Webhook de WhatsApp: sin límite estricto pero con validación de firma
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500, // Meta puede mandar muchos en ráfaga
});

/* ─────────────────────────────────────────────
   SEGURIDAD — VERIFICACIÓN DE FIRMA WHATSAPP
   Meta firma cada request con HMAC-SHA256.
   Si la firma no coincide, la request es falsa.
───────────────────────────────────────────── */
function verificarFirmaMeta(req, res, next) {
  if (!WHATSAPP_APP_SECRET) {
    // Si no configuraron el secret, pasamos (con warning)
    console.warn("⚠️ WHATSAPP_APP_SECRET no configurado. Verificación de firma desactivada.");
    return next();
  }

  const firma = req.headers["x-hub-signature-256"];
  if (!firma) {
    console.warn("⚠️ Request sin firma de Meta — rechazada");
    return res.sendStatus(403);
  }

  const body = JSON.stringify(req.body);
  const expected = "sha256=" + crypto
    .createHmac("sha256", WHATSAPP_APP_SECRET)
    .update(body)
    .digest("hex");

  // Comparación timing-safe para evitar timing attacks
  const sigBuf = Buffer.from(firma);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.warn("⚠️ Firma de Meta inválida — request rechazada");
    return res.sendStatus(403);
  }

  next();
}

/* ─────────────────────────────────────────────
   AUTH — COOKIE HttpOnly (más seguro que localStorage)
   La cookie no es accesible desde JavaScript,
   por lo que un XSS no puede robar el token.
───────────────────────────────────────────── */
const COOKIE_NAME = "pucarito_admin";
const COOKIE_OPTIONS = {
  httpOnly: true,       // JS no puede leerla
  secure: process.env.NODE_ENV === "production", // Solo HTTPS en prod
  sameSite: "strict",   // No se manda en requests cross-site (anti-CSRF)
  maxAge: 8 * 60 * 60 * 1000, // 8 horas
};

async function authMiddleware(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "No autorizado" });

  const valid = await redis.get(`admin:token:${token}`);
  if (!valid) return res.status(401).json({ error: "Sesión expirada. Volvé a ingresar." });

  req.adminToken = token;
  next();
}

/* ─────────────────────────────────────────────
   RUTAS — AUTH
───────────────────────────────────────────── */
app.post("/api/login", loginLimiter, async (req, res) => {
  const { password } = req.body;

  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "Contraseña requerida" });
  }

  // Comparación timing-safe para evitar timing attacks en la contraseña
  const inputBuf = Buffer.from(password.padEnd(64));
  const targetBuf = Buffer.from(ADMIN_PASSWORD.padEnd(64));
  const match = crypto.timingSafeEqual(inputBuf, targetBuf) && password === ADMIN_PASSWORD;

  if (!match) {
    // Delay artificial para frenar ataques de fuerza bruta
    await new Promise(r => setTimeout(r, 500));
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }

  const token = crypto.randomBytes(48).toString("hex"); // 96 chars — muy difícil de adivinar
  await redis.set(`admin:token:${token}`, "1", { ex: 60 * 60 * 8 });

  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
  res.json({ ok: true });
});

app.post("/api/logout", authMiddleware, async (req, res) => {
  await redis.del(`admin:token:${req.adminToken}`);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

/* ─────────────────────────────────────────────
   RUTAS — PANEL ADMIN
───────────────────────────────────────────── */
app.get("/api/conversaciones", authMiddleware, apiLimiter, async (req, res) => {
  const lista = await listHandovers();
  res.json(lista);
});

app.post("/api/responder", authMiddleware, apiLimiter, async (req, res) => {
  const { telefono, mensaje } = req.body;

  if (!telefono || !mensaje || typeof mensaje !== "string") {
    return res.status(400).json({ error: "Datos inválidos" });
  }

  // Sanitización básica: límite de longitud
  if (mensaje.length > 4096) {
    return res.status(400).json({ error: "Mensaje demasiado largo" });
  }

  await sendWhatsApp(telefono, mensaje);

  const session = await getSession(telefono);
  session.history = [...(session.history || []), {
    role: "model",
    parts: [{ text: `[Admin]: ${mensaje}` }]
  }];
  await updateSession(telefono, session);

  io.emit("mensaje_enviado", { telefono, mensaje, ts: Date.now() });
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

  await sendWhatsApp(telefono, "¡Hola de nuevo! 👋 Ya podés seguir escribiéndome. Soy Pucarito 🏫");
  io.emit("bot_reactivado", { telefono });
  res.json({ ok: true });
});

/* ─────────────────────────────────────────────
   SIMULADOR LOCAL (solo en desarrollo)
───────────────────────────────────────────── */
if (process.env.NODE_ENV !== "production") {
  app.post("/chat-local", async (req, res) => {
    try {
      const { message } = req.body;
      const respuesta = await handleTestMessage({ from: "usuario_local", type: "text", text: { body: message } });
      res.json({ reply: respuesta ?? "🤫 Bot en silencio (Modo Humano)." });
    } catch (e) {
      res.status(500).json({ reply: "❌ Error en el servidor." });
    }
  });
}

/* ─────────────────────────────────────────────
   WEBHOOK WHATSAPP
───────────────────────────────────────────── */
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === MY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", webhookLimiter, verificarFirmaMeta, async (req, res) => {
  res.sendStatus(200); // Respuesta rápida a Meta

  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return;

  const from = message.from;
  const type = message.type;
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
    await sendWhatsApp(from, "Por ahora solo puedo leer textos, imágenes y audios. 😊");
    return;
  }

  const respuesta = await handleTestMessage(messageObj);
  if (respuesta) {
    const destino = from === "5493816559383" ? "54381156559383" : from;
    await sendWhatsApp(destino, respuesta);
  }
});

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */
async function downloadMedia(mediaId) {
  try {
    const { data: info } = await axios.get(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const { data: buffer } = await axios.get(info.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: "arraybuffer",
    });
    return { base64: Buffer.from(buffer).toString("base64"), mimeType: info.mime_type };
  } catch (e) {
    console.error("❌ Error descargando media:", e.message);
    return null;
  }
}

async function sendWhatsApp(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, text: { body: text } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("❌ Error WhatsApp:", e.response?.data || e.message);
  }
}

/* ─────────────────────────────────────────────
   MANEJO DE ERRORES NO CAPTURADOS
   Evita que el servidor crashee por errores inesperados
───────────────────────────────────────────── */
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Servidor listo → http://localhost:${PORT}`);
  console.log(`🔐 Panel admin  → http://localhost:${PORT}/admin.html`);
  if (process.env.NODE_ENV !== "production") {
    console.log(`⚠️  Modo desarrollo — /chat-local habilitado`);
  }
});

export default app;