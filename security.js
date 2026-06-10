import crypto from "crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const SESSION_COOKIE = "sid";
const CSRF_COOKIE = "csrf_token";

const isProd = process.env.NODE_ENV === "production";
const memoryAuthSessions = new Map();
const memoryRateLimit = new Map();

export function setupSecurity(app) {
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'", "'unsafe-inline'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:", "blob:"],
          "media-src": ["'self'", "blob:", "data:"],
          "connect-src": ["'self'"],
          "font-src": ["'self'", "data:"],
          "object-src": ["'none'"],
          "base-uri": ["'self'"],
          "frame-ancestors": ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
  });
}

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Demasiados intentos de login. Probá de nuevo más tarde.",
  },
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Demasiadas solicitudes. Probá de nuevo en unos segundos.",
  },
});

export function sanitizeText(value, maxLength = 3000) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[\r\n]{4,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

export function sanitizePhone(value) {
  return String(value || "")
    .replace(/[^0-9A-Za-z_+.-]/g, "")
    .slice(0, 80);
}

export function sanitizeMessage(value, maxLength = 4000) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function createCsrfToken() {
  return crypto.randomBytes(24).toString("hex");
}

export function safeCompare(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));

  if (aa.length !== bb.length) return false;

  return crypto.timingSafeEqual(aa, bb);
}

export function isPasswordValid(password) {
  const configuredPassword = process.env.ADMIN_PASSWORD;

  if (!configuredPassword && isProd) {
    console.error("❌ Falta ADMIN_PASSWORD en producción.");
    return false;
  }

  const expected = configuredPassword || "admin123";
  return safeCompare(String(password || ""), String(expected));
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

export async function rateLimitKey(req, key = "default", max = 30, windowMs = 60_000) {
  const ip = getClientIp(req);
  const finalKey = `${key}:${ip}`;
  const now = Date.now();

  const current = memoryRateLimit.get(finalKey) || {
    count: 0,
    resetAt: now + windowMs,
  };

  if (now > current.resetAt) {
    current.count = 0;
    current.resetAt = now + windowMs;
  }

  current.count += 1;
  memoryRateLimit.set(finalKey, current);

  if (current.count > max) {
    const error = new Error("Demasiados intentos.");
    error.status = 429;
    error.publicMessage = "Demasiados intentos. Probá de nuevo en unos segundos.";
    throw error;
  }

  return true;
}

export function createSession(res, extraData = {}) {
  const sid = createSessionToken();
  const csrf = createCsrfToken();

  const session = {
    id: sid,
    role: "admin",
    csrf,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    ...extraData,
  };

  memoryAuthSessions.set(sid, session);

  res.cookie(SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 12,
    path: "/",
  });

  res.cookie(CSRF_COOKIE, csrf, {
    httpOnly: false,
    secure: isProd,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 12,
    path: "/",
  });

  return csrf;
}

function getAuthSession(req) {
  const sid = req.cookies?.[SESSION_COOKIE];

  if (!sid) return null;

  const session = memoryAuthSessions.get(sid);

  if (!session) return null;

  const maxAge = 1000 * 60 * 60 * 12;

  if (Date.now() - session.createdAt > maxAge) {
    memoryAuthSessions.delete(sid);
    return null;
  }

  session.lastSeen = Date.now();
  memoryAuthSessions.set(sid, session);

  return session;
}

export function requireAuth(req, res, next) {
  const session = getAuthSession(req);

  if (!session) {
    return res.status(401).json({
      error: "No autorizado",
    });
  }

  req.auth = session;
  return next();
}

export function requireCsrf(req) {
  const method = String(req.method || "GET").toUpperCase();

  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }

  const headerToken = req.headers["x-csrf-token"];
  const cookieToken = req.cookies?.[CSRF_COOKIE];

  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    const error = new Error("CSRF inválido.");
    error.status = 403;
    error.publicMessage = "Sesión inválida. Recargá la página e intentá de nuevo.";
    throw error;
  }

  return true;
}

export function clearSession(req, res) {
  const sid = req?.cookies?.[SESSION_COOKIE];

  if (sid) {
    memoryAuthSessions.delete(sid);
  }

  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.clearCookie(CSRF_COOKIE, { path: "/" });

  return true;
}

export function publicSafeConversation(session) {
  if (!session) {
    return {
      telefono: "",
      status: "ACTIVE",
      history: [],
      ultimoMensaje: "",
      turns: 0,
      lastSeen: 0,
    };
  }

  const history = Array.isArray(session.history) ? session.history : [];
  const contacto = session.contacto || {};

  const safeHistory = history.map((msg) => {
    const parts = Array.isArray(msg.parts) ? msg.parts : [];

    return {
      role: msg.role === "model" || msg.role === "admin" ? msg.role : "user",
      parts: parts.map((part) => ({
        text: sanitizeText(part.text || "", 6000),
        mediaKey: part.mediaKey || null,
        mimeType: part.mimeType || null,
        ts: Number(part.ts || Date.now()),
      })),
    };
  });

  const lastMsg = [...safeHistory]
    .reverse()
    .find((msg) => msg.parts?.[0]?.text);

  const ultimoMensaje = lastMsg?.parts?.[0]?.text || "";

  return {
    telefono: sanitizePhone(session.telefono || session.from || session.id || session.userId || ""),
    status: session.status || "ACTIVE",
    greeted: Boolean(session.greeted),
    assignedTo: sanitizeText(session.assignedTo || "", 80),
    lastIntent: sanitizeText(session.lastIntent || "", 120),
    lastSeen: Number(session.lastSeen || 0),
    turns: Number(session.turns || safeHistory.length || 0),

    nombre: sanitizeText(session.nombre || contacto.nombre || "", 120),
    dni: sanitizeText(session.dni || contacto.dni || "", 40),
    colegio: sanitizeText(session.colegio || contacto.colegio || "", 120),
    curso: sanitizeText(session.curso || contacto.curso || "", 120),
    hijos: Array.isArray(session.hijos)
      ? session.hijos.map((h) => sanitizeText(h, 120)).filter(Boolean)
      : Array.isArray(contacto.hijos)
        ? contacto.hijos.map((h) => sanitizeText(h, 120)).filter(Boolean)
        : [],

    ultimoMensaje: sanitizeText(ultimoMensaje, 500),
    history: safeHistory,
  };
}

export function errorHandler(error, req, res, next) {
  console.error("❌ Error:", error);

  return res.status(error.status || 500).json({
    error: error.publicMessage || "Error interno del servidor.",
  });
}
