import express from "express";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import chatHandler from "./api/chat.js";

import {
  setupSecurity,
  loginLimiter,
  apiLimiter,
  requireAuth,
  createSession,
  clearSession,
  isPasswordValid,
  publicSafeConversation,
  sanitizePhone,
  sanitizeMessage,
  sanitizeText,
} from "./security.js";

import {
  listSessions,
  getSession,
  updateSession,
  deleteSession,
  appendAdminMessage,
  getMedia,
  getConfig,
  updateConfig,
} from "./memory.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);

setupSecurity(app);

app.use(express.json({ limit: "8mb" }));
app.use(cookieParser());

app.use(
  express.static(path.join(__dirname, "public"), {
    extensions: ["html"],
  })
);

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
  });
});

app.post("/api/login", loginLimiter, (req, res) => {
  const { password } = req.body || {};

  if (!isPasswordValid(password)) {
    return res.status(401).json({
      error: "Contraseña incorrecta",
    });
  }

  const csrf = createSession(res);

  return res.json({
    ok: true,
    csrf,
  });
});

app.post("/api/logout", requireAuth, (req, res) => {
  clearSession(req, res);

  return res.json({
    ok: true,
  });
});

app.get("/api/me", requireAuth, (req, res) => {
  return res.json({
    ok: true,
    csrf: req.cookies?.csrf_token || null,
  });
});

app.post("/api/chat", apiLimiter, chatHandler);

app.get("/api/conversaciones", requireAuth, async (req, res) => {
  const sesiones = await listSessions();

  const espera = sesiones
    .filter((s) => s.status === "HANDOVER")
    .map(publicSafeConversation);

  const activas = sesiones
    .filter((s) => s.status !== "HANDOVER")
    .map(publicSafeConversation);

  return res.json({
    ok: true,
    espera,
    activas,
  });
});

app.get("/api/activas", requireAuth, async (req, res) => {
  const sesiones = await listSessions();

  const activas = sesiones
    .filter((s) => s.status !== "HANDOVER")
    .map(publicSafeConversation);

  return res.json(activas);
});

app.get("/api/espera", requireAuth, async (req, res) => {
  const sesiones = await listSessions();

  const espera = sesiones
    .filter((s) => s.status === "HANDOVER")
    .map(publicSafeConversation);

  return res.json(espera);
});

app.get("/api/conversaciones/:telefono", requireAuth, async (req, res) => {
  const telefono = sanitizePhone(req.params.telefono);
  const session = await getSession(telefono);

  return res.json({
    ok: true,
    conversacion: publicSafeConversation(session),
  });
});

app.post("/api/responder", requireAuth, apiLimiter, async (req, res) => {
  const telefono = sanitizePhone(req.body?.telefono);
  const mensaje = sanitizeMessage(req.body?.mensaje, 4000);

  if (!telefono || !mensaje) {
    return res.status(400).json({
      error: "Falta teléfono o mensaje",
    });
  }

  const session = await getSession(telefono);

  if (!session || !session.telefono) {
    return res.status(404).json({
      error: "Conversación no encontrada",
    });
  }

  await appendAdminMessage(telefono, mensaje);

  return res.json({
    ok: true,
    enviado: false,
    nota: "Mensaje guardado en el panel. Conectar acá el envío real a WhatsApp.",
  });
});

app.post("/api/reactivar", requireAuth, async (req, res) => {
  const telefono = sanitizePhone(req.body?.telefono);

  if (!telefono) {
    return res.status(400).json({
      error: "Falta teléfono",
    });
  }

  const session = await getSession(telefono);

  if (!session || !session.telefono) {
    return res.status(404).json({
      error: "Conversación no encontrada",
    });
  }

  session.status = "ACTIVE";
  session.greeted = false;
  session.assignedTo = null;
  session.lastSeen = Date.now();

  await updateSession(telefono, session);

  return res.json({
    ok: true,
  });
});

app.post("/api/asignar", requireAuth, async (req, res) => {
  const telefono = sanitizePhone(req.body?.telefono);
  const assignedTo = sanitizeText(req.body?.assignedTo || "Admin", 60);

  if (!telefono) {
    return res.status(400).json({
      error: "Falta teléfono",
    });
  }

  const session = await getSession(telefono);

  if (!session || !session.telefono) {
    return res.status(404).json({
      error: "Conversación no encontrada",
    });
  }

  session.assignedTo = assignedTo;
  session.lastSeen = Date.now();

  await updateSession(telefono, session);

  return res.json({
    ok: true,
  });
});

app.post("/api/borrar", requireAuth, async (req, res) => {
  const telefono = sanitizePhone(req.body?.telefono);

  if (!telefono) {
    return res.status(400).json({
      error: "Falta teléfono",
    });
  }

  await deleteSession(telefono);

  return res.json({
    ok: true,
  });
});

app.get("/api/media", requireAuth, async (req, res) => {
  const key = String(req.query.key || "")
    .replace(/[^a-f0-9]/g, "")
    .slice(0, 64);

  if (!key) {
    return res.status(400).send("Falta key");
  }

  const media = await getMedia(key);

  if (!media) {
    return res.status(404).send("No encontrado");
  }

  const buffer = Buffer.from(media.base64, "base64");

  res.setHeader("Content-Type", media.mimeType || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=300");

  return res.send(buffer);
});

app.get("/api/config", requireAuth, async (req, res) => {
  const config = await getConfig();

  return res.json({
    ok: true,
    config,
  });
});

app.put("/api/config", requireAuth, apiLimiter, async (req, res) => {
  const body = req.body || {};

  const updated = await updateConfig({
    botName: sanitizeText(body.botName, 120),

    colegios: Array.isArray(body.colegios)
      ? body.colegios.map((c) => sanitizeText(c, 80)).filter(Boolean)
      : String(body.colegios || "")
          .split(",")
          .map((c) => sanitizeText(c, 80))
          .filter(Boolean),

    tono: sanitizeText(body.tono, 300),
    usarEmojis: Boolean(body.usarEmojis),
    pedirColegioSiFalta: Boolean(body.pedirColegioSiFalta),
    derivarUrgenciasSiempre: Boolean(body.derivarUrgenciasSiempre),

    handoverResetMinutes: clampNumber(body.handoverResetMinutes, 5, 1440, 120),
    maxHistoryForAI: clampNumber(body.maxHistoryForAI, 2, 30, 14),

    model: sanitizeText(body.model, 80) || "gemini-2.5-flash",
    temperature: clampNumber(body.temperature, 0, 2, 0.2),
    maxOutputTokens: clampNumber(body.maxOutputTokens, 256, 8192, 4096),

    menuInicial: sanitizeText(body.menuInicial, 2000),
    mensajeDerivacion: sanitizeText(body.mensajeDerivacion, 500),
    baseConocimiento: sanitizeText(body.baseConocimiento, 60000),
  });

  return res.json({
    ok: true,
    config: updated,
  });
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: "Ruta no encontrada",
    });
  }

  return res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.use((err, req, res, next) => {
  console.error("❌ Error global:", err);

  return res.status(err.status || 500).json({
    error: err.publicMessage || "Error interno",
  });
});

app.listen(PORT, () => {
  console.log(`✅ Bot y panel listos en http://localhost:${PORT}`);
});

function clampNumber(value, min, max, fallback) {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;

  return n;
}
