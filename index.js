import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import fs from "fs";
import { Redis } from "@upstash/redis";
import { handleTestMessage } from "./bot.js";
import {
  getSession,
  updateSession,
  listHandovers,
  listActivas,
  getContacto,
  listContactos,
  getMedia,
  getConfig,
  updateConfig,
} from "./memory.js";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

const IS_PROD = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
const COOKIE = "apdes_admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "";
const HAS_REDIS = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

const redis = HAS_REDIS
  ? new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    })
  : null;

const localAuth = new Map();

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use((req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
  next();
});

app.use(cookieParser());
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(process.cwd(), "public"), { extensions: ["html"] }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos. Esperá 15 minutos." },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas solicitudes. Probá de nuevo en un momento." },
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

function cleanPhone(value) {
  return String(value || "").replace(/[^0-9+]/g, "").slice(0, 30);
}

function cleanText(value, max = 3900) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, max);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function authGet(key) {
  if (redis) return redis.get(key);
  const item = localAuth.get(key);
  if (!item) return null;
  if (item.expiresAt && item.expiresAt < Date.now()) {
    localAuth.delete(key);
    return null;
  }
  return item.value;
}

async function authSet(key, value, exSeconds = 60 * 60 * 8) {
  if (redis) return redis.set(key, value, { ex: exSeconds });
  localAuth.set(key, { value, expiresAt: Date.now() + exSeconds * 1000 });
}

async function authDel(key) {
  if (redis) return redis.del(key);
  localAuth.delete(key);
}

async function authMiddleware(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      return res.status(401).json({ error: "No autorizado" });
    }

    const raw = await authGet(`admin:token:${token}`);
    if (!raw) return res.status(401).json({ error: "Sesión expirada" });

    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    req.adminToken = token;
    req.csrfToken = data.csrf;

    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      const header = req.get("x-csrf-token");
      if (!header || !safeEqual(header, data.csrf)) {
        return res.status(403).json({ error: "CSRF inválido" });
      }
    }

    next();
  } catch (error) {
    console.error("❌ Error auth:", error);
    return res.status(401).json({ error: "No autorizado" });
  }
}

app.get("/", (_req, res) => res.redirect("/admin.html"));

app.get("/admin.html", (_req, res) => {
  const candidates = [
    path.join(process.cwd(), "public", "admin.html"),
    path.join(process.cwd(), "admin.html"),
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) return res.type("html").send(fs.readFileSync(file, "utf-8"));
  }

  return res.status(404).send("No se encontró public/admin.html");
});

app.get("/health", async (_req, res) => {
  let redisOk = false;
  try {
    if (redis) {
      await redis.ping();
      redisOk = true;
    }
  } catch {
    redisOk = false;
  }

  res.json({
    ok: true,
    redis: redisOk ? "ok" : HAS_REDIS ? "error" : "no-configurado",
    whatsapp: Boolean(WHATSAPP_TOKEN && PHONE_NUMBER_ID),
    gemini: Boolean(process.env.GEMINI_API_KEY),
    time: new Date().toISOString(),
  });
});

app.post("/api/login", loginLimiter, async (req, res) => {
  try {
    const password = String(req.body?.password || "");

    if (!ADMIN_PASSWORD || !safeEqual(password, ADMIN_PASSWORD)) {
      return res.status(401).json({ error: "Contraseña incorrecta" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const csrf = crypto.randomBytes(32).toString("hex");

    await authSet(
      `admin:token:${token}`,
      JSON.stringify({ csrf, createdAt: Date.now() }),
      60 * 60 * 8
    );

    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PROD,
      maxAge: 8 * 60 * 60 * 1000,
      path: "/",
    });

    res.json({ ok: true, csrf });
  } catch (error) {
    console.error("❌ Error login:", error);
    res.status(500).json({ error: "No se pudo iniciar sesión" });
  }
});

app.get("/api/me", authMiddleware, async (_req, res) => {
  res.json({ ok: true, csrf: _req.csrfToken });
});

app.post("/api/logout", authMiddleware, async (req, res) => {
  await authDel(`admin:token:${req.adminToken}`);
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/config", authMiddleware, apiLimiter, async (_req, res) => {
  res.json(await getConfig());
});

app.post("/api/config", authMiddleware, apiLimiter, async (req, res) => {
  const body = req.body || {};
  const config = await updateConfig({
    botName: cleanText(body.botName, 120),
    model: cleanText(body.model, 80),
    tono: cleanText(body.tono, 500),
    colegios: Array.isArray(body.colegios)
      ? body.colegios
      : String(body.colegios || "")
          .split(",")
          .map((x) => cleanText(x, 80))
          .filter(Boolean),
    temperature: Number(body.temperature),
    maxOutputTokens: Number(body.maxOutputTokens),
    maxHistoryForAI: Number(body.maxHistoryForAI),
    handoverResetMinutes: Number(body.handoverResetMinutes),
    menuInicial: cleanText(body.menuInicial, 2000),
    mensajeDerivacion: cleanText(body.mensajeDerivacion, 1000),
    baseConocimiento: cleanText(body.baseConocimiento, 30000),
  });

  res.json({ ok: true, config });
});

app.get("/api/conversaciones", authMiddleware, apiLimiter, async (_req, res) => {
  const lista = await listHandovers();
  const enriquecida = await Promise.all(
    lista.map(async (c) => {
      const contacto = await getContacto(c.telefono);
      return { ...c, ...contacto, telefono: c.telefono, status: c.status, history: c.history, lastSeen: c.lastSeen, ultimoMensaje: c.ultimoMensaje };
    })
  );
  res.json(enriquecida);
});

app.get("/api/activas", authMiddleware, apiLimiter, async (_req, res) => {
  const lista = await listActivas();
  const enriquecida = await Promise.all(
    lista.map(async (c) => {
      const contacto = await getContacto(c.telefono);
      return { ...c, ...contacto, telefono: c.telefono, status: c.status, history: c.history, lastSeen: c.lastSeen, ultimoMensaje: c.ultimoMensaje };
    })
  );
  res.json(enriquecida);
});

app.get("/api/contactos", authMiddleware, apiLimiter, async (_req, res) => {
  res.json(await listContactos());
});

app.get("/api/media", authMiddleware, apiLimiter, async (req, res) => {
  const key = String(req.query.key || "");
  if (!/^media:[0-9]+:[0-9]+$/.test(key)) {
    return res.status(400).json({ error: "Key inválida" });
  }

  const media = await getMedia(key);
  if (!media) return res.status(404).json({ error: "Media no encontrada o expirada" });

  res.setHeader("Content-Type", media.mimeType || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(Buffer.from(media.base64 || "", "base64"));
});

app.post("/api/responder", authMiddleware, apiLimiter, async (req, res) => {
  const telefono = cleanPhone(req.body?.telefono);
  const mensaje = cleanText(req.body?.mensaje, 3900);

  if (!telefono || !mensaje) return res.status(400).json({ error: "Faltan datos" });

  const enviado = await sendMessage(telefono, mensaje);
  if (!enviado) {
    return res.status(500).json({ error: "No se pudo enviar el mensaje a WhatsApp" });
  }

  const session = await getSession(telefono);
  session.history = [
    ...(session.history || []),
    { role: "model", parts: [{ text: `[Admin]: ${mensaje}`, ts: Date.now() }] },
  ].slice(-40);
  session.lastSeen = Date.now();
  session.status = "HANDOVER";
  await updateSession(telefono, session);

  res.json({ ok: true });
});

app.post("/api/borrar", authMiddleware, apiLimiter, async (req, res) => {
  const telefono = cleanPhone(req.body?.telefono);
  if (!telefono) return res.status(400).json({ error: "Falta teléfono" });

  const session = await getSession(telefono);
  session.history = [];
  session.status = "ACTIVE";
  session.greeted = false;
  session.ultimoMensaje = "";
  session.lastSeen = Date.now();
  await updateSession(telefono, session);

  res.json({ ok: true });
});

app.post("/api/reactivar", authMiddleware, apiLimiter, async (req, res) => {
  const telefono = cleanPhone(req.body?.telefono);
  if (!telefono) return res.status(400).json({ error: "Falta teléfono" });

  const config = await getConfig();
  const session = await getSession(telefono);
  session.status = "ACTIVE";
  session.greeted = true;
  session.isReturningUser = true;
  session.lastSeen = Date.now();
  await updateSession(telefono, session);

  await sendMessage(
    telefono,
    `¡Listo! 👋 El asistente quedó reactivado. Podés escribirme nuevamente cuando quieras.`
  );

  res.json({ ok: true });
});

// Solo para probar local desde public/test-chat.html.
// En producción queda protegido para no exponer el bot como endpoint público.
app.post("/api/chat", apiLimiter, async (req, res) => {
  if (IS_PROD && req.get("x-local-test") !== process.env.LOCAL_TEST_SECRET) {
    return res.status(404).json({ error: "No disponible" });
  }

  try {
    const message = cleanText(req.body?.message, 2000);
    if (!message) return res.status(400).json({ error: "Mensaje vacío" });

    const reply = await handleTestMessage({
      from: "usuario_local_browser",
      type: "text",
      text: { body: message },
    });

    res.json({ ok: true, reply: reply ?? "🤫 El bot está en modo humano." });
  } catch (error) {
    console.error("🔥 Error en /api/chat:", error);
    res.status(500).json({ ok: false, error: "Error en el servidor" });
  }
});

app.get("/webhook", webhookLimiter, (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", webhookLimiter, async (req, res) => {
  try {
    const body = req.body;
    if (!body.object) return res.sendStatus(404);

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = cleanPhone(message.from);
    const type = message.type;

    console.log(`📩 Mensaje de ${from} — tipo: ${type}`);

    const messageObj = { from, type };

    if (type === "text") {
      messageObj.text = { body: cleanText(message.text?.body, 3000) };
    } else if (type === "image") {
      const mediaData = await downloadMedia(message.image?.id);
      if (!mediaData) {
        await sendMessage(from, "No pude leer la imagen. ¿Podés reenviarla o mandarme una captura más clara? 😊");
        return res.sendStatus(200);
      }
      messageObj.mediaData = mediaData;
      messageObj.text = { body: cleanText(message.image?.caption, 1000) };
    } else if (type === "audio") {
      const mediaData = await downloadMedia(message.audio?.id);
      if (!mediaData) {
        await sendMessage(from, "No pude escuchar el audio. ¿Podés reenviarlo o escribir la consulta? 😊");
        return res.sendStatus(200);
      }
      messageObj.mediaData = mediaData;
      messageObj.text = { body: "" };
    } else {
      await sendMessage(from, "Por ahora puedo leer textos, imágenes y audios de voz. 😊");
      return res.sendStatus(200);
    }

    const respuestaBot = await handleTestMessage(messageObj);
    if (respuestaBot) await sendMessage(from, respuestaBot);

    return res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error webhook:", error);
    return res.sendStatus(200);
  }
});

async function downloadMedia(mediaId) {
  try {
    if (!mediaId) return null;

    const { data: mediaInfo } = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      timeout: 15000,
    });

    const { data: mediaBuffer } = await axios.get(mediaInfo.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: "arraybuffer",
      timeout: 25000,
    });

    return {
      base64: Buffer.from(mediaBuffer).toString("base64"),
      mimeType: mediaInfo.mime_type || "application/octet-stream",
    };
  } catch (error) {
    console.error("❌ Error descargando media:", error.response?.data || error.message);
    return null;
  }
}

async function sendMessage(to, text) {
  try {
    const telefono = cleanPhone(to);
    const body = cleanText(text, 3900);

    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
      console.error("❌ Faltan WHATSAPP_TOKEN o PHONE_NUMBER_ID");
      return false;
    }

    if (!telefono || !body) return false;

    await axios.post(
      `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: telefono,
        text: { preview_url: false, body },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );

    console.log(`🤖 Enviado a ${telefono}: ${body.substring(0, 70)}...`);
    return true;
  } catch (error) {
    console.error("❌ Error enviando a WhatsApp:", error.response?.data || error.message);
    return false;
  }
}

process.on("unhandledRejection", (reason) => console.error("❌ Unhandled:", reason));
process.on("uncaughtException", (err) => console.error("❌ Uncaught:", err));

if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
    console.log(`🔐 Panel admin → http://localhost:${PORT}/admin.html`);
    console.log(`🧪 Health check → http://localhost:${PORT}/health`);
  });
}

export default app;
