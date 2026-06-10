import { Redis } from "@upstash/redis";
import crypto from "crypto";

const PREFIX = process.env.MEMORY_PREFIX || "botred";
const hasRedis = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

let redis = null;

if (hasRedis) {
  redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
}

const local = new Map();

function namespaced(k) {
  return `${PREFIX}:${k}`;
}

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

async function getRaw(k) {
  const key = namespaced(k);

  if (redis) {
    try {
      return await redis.get(key);
    } catch (error) {
      console.error("❌ Error leyendo Redis. Uso fallback local:", error?.message || error);
      return local.get(key) ?? null;
    }
  }

  return local.get(key) ?? null;
}

async function setRaw(k, value, exSeconds = null) {
  const key = namespaced(k);

  if (redis) {
    try {
      if (exSeconds) {
        await redis.set(key, value, { ex: exSeconds });
      } else {
        await redis.set(key, value);
      }
      return true;
    } catch (error) {
      console.error("❌ Error guardando Redis. Uso fallback local:", error?.message || error);
      local.set(key, value);
      return true;
    }
  }

  local.set(key, value);
  return true;
}

async function delRaw(k) {
  const key = namespaced(k);

  if (redis) {
    try {
      await redis.del(key);
    } catch (error) {
      console.error("❌ Error borrando Redis. Borro fallback local:", error?.message || error);
    }
  }

  local.delete(key);
  return true;
}

async function listKeys(prefix) {
  const fullPrefix = namespaced(prefix);

  if (redis) {
    try {
      let cursor = 0;
      const out = [];

      do {
        const result = await redis.scan(cursor, {
          match: `${fullPrefix}*`,
          count: 100,
        });

        cursor = Number(result?.[0] || 0);
        const keys = result?.[1] || [];

        out.push(
          ...keys.map((k) =>
            String(k).startsWith(`${PREFIX}:`)
              ? String(k).slice(PREFIX.length + 1)
              : String(k)
          )
        );
      } while (cursor !== 0);

      return out;
    } catch (error) {
      console.error("❌ Error listando Redis. Uso fallback local:", error?.message || error);
    }
  }

  return [...local.keys()]
    .filter((k) => k.startsWith(fullPrefix))
    .map((k) => k.slice(PREFIX.length + 1));
}

function cleanPhone(value) {
  return String(value || "")
    .replace(/[^0-9A-Za-z_+.-]/g, "")
    .slice(0, 80);
}

function cleanText(value, max = 4000) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, max);
}

function cleanContact(data = {}) {
  const hijos = Array.isArray(data.hijos)
    ? data.hijos.map((h) => cleanText(h, 120)).filter(Boolean).slice(0, 12)
    : [];

  return {
    nombre: cleanText(data.nombre, 160),
    dni: String(data.dni || "").replace(/\D/g, "").slice(0, 12),
    colegio: cleanText(data.colegio, 160),
    curso: cleanText(data.curso, 160),
    hijos,
  };
}

export function emptySession(telefono) {
  const phone = cleanPhone(telefono);

  return {
    telefono: phone,
    from: phone,
    status: "ACTIVE",
    greeted: false,
    lastIntent: null,
    history: [],
    tempData: {},
    turns: 0,
    lastSeen: Date.now(),
    isReturningUser: false,
    ultimoMensaje: "",
    contacto: {},
    assignedTo: null,
  };
}

export async function getSession(telefono) {
  const phone = cleanPhone(telefono);
  if (!phone) return emptySession("");

  const data = parseMaybeJson(await getRaw(`session:${phone}`));

  if (!data) return emptySession(phone);

  return {
    ...emptySession(phone),
    ...data,
    telefono: phone,
    from: data.from || phone,
    history: Array.isArray(data.history) ? data.history : [],
    lastSeen: Number(data.lastSeen || Date.now()),
  };
}

export async function updateSession(telefono, session = {}) {
  const phone = cleanPhone(telefono || session.telefono || session.from);

  if (!phone) {
    throw new Error("updateSession necesita teléfono");
  }

  const cleaned = {
    ...emptySession(phone),
    ...session,
    telefono: phone,
    from: session.from || phone,
    history: Array.isArray(session.history) ? session.history.slice(-40) : [],
    turns: Number(session.turns || 0),
    lastSeen: Number(session.lastSeen || Date.now()),
    ultimoMensaje:
      cleanText(
        session.ultimoMensaje ||
          getLastText(Array.isArray(session.history) ? session.history : []),
        800
      ),
  };

  await setRaw(`session:${phone}`, JSON.stringify(cleaned), 60 * 60 * 24 * 90);
  await setRaw(`index:${phone}`, String(cleaned.lastSeen), 60 * 60 * 24 * 90);

  if (cleaned.status === "HANDOVER") {
    await setRaw(`handover:${phone}`, String(cleaned.lastSeen), 60 * 60 * 24 * 90);
    await delRaw(`active:${phone}`);
  } else {
    await setRaw(`active:${phone}`, String(cleaned.lastSeen), 60 * 60 * 24 * 90);
    await delRaw(`handover:${phone}`);
  }

  return cleaned;
}

export async function deleteSession(telefono) {
  const phone = cleanPhone(telefono);

  if (!phone) return true;

  await delRaw(`session:${phone}`);
  await delRaw(`index:${phone}`);
  await delRaw(`active:${phone}`);
  await delRaw(`handover:${phone}`);

  return true;
}

export async function listSessions() {
  const keys = await listKeys("index:");
  const phones = keys.map((k) => k.replace(/^index:/, "")).filter(Boolean);

  const sessions = [];

  for (const phone of phones) {
    const session = await getSession(phone);
    if (session?.telefono) sessions.push(session);
  }

  return sessions.sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0));
}

export async function listHandovers() {
  const sessions = await listSessions();

  return sessions
    .filter((s) => s.status === "HANDOVER")
    .map(toPublicConversation);
}

export async function listActivas() {
  const sessions = await listSessions();

  return sessions
    .filter((s) => s.status !== "HANDOVER")
    .map(toPublicConversation);
}

export async function getContacto(telefono) {
  const phone = cleanPhone(telefono);
  if (!phone) return {};

  const data = parseMaybeJson(await getRaw(`contact:${phone}`));

  if (!data) return {};

  return cleanContact(data);
}

export async function updateContacto(telefono, datos = {}) {
  const phone = cleanPhone(telefono);

  if (!phone) return {};

  const actual = await getContacto(phone);
  const limpio = cleanContact({
    ...actual,
    ...datos,
  });

  await setRaw(`contact:${phone}`, JSON.stringify(limpio), 60 * 60 * 24 * 365);
  await setRaw(`contactIndex:${phone}`, String(Date.now()), 60 * 60 * 24 * 365);

  const session = await getSession(phone);
  session.contacto = limpio;
  session.nombre = limpio.nombre || session.nombre;
  session.dni = limpio.dni || session.dni;
  session.colegio = limpio.colegio || session.colegio;
  session.curso = limpio.curso || session.curso;
  session.hijos = limpio.hijos?.length ? limpio.hijos : session.hijos;

  await updateSession(phone, session);

  return limpio;
}

export async function listContactos() {
  const keys = await listKeys("contactIndex:");
  const phones = keys.map((k) => k.replace(/^contactIndex:/, "")).filter(Boolean);

  const contactos = [];

  for (const phone of phones) {
    const contacto = await getContacto(phone);
    contactos.push({
      telefono: phone,
      ...contacto,
    });
  }

  return contactos.sort((a, b) => String(a.nombre || "").localeCompare(String(b.nombre || "")));
}

export async function saveMedia(telefono, mimeType, base64) {
  const phone = cleanPhone(telefono);
  const ts = Date.now();
  const safeMime = String(mimeType || "application/octet-stream")
    .split(";")[0]
    .trim()
    .slice(0, 100);

  // Compatible con tu index.js actual:
  // /api/media exige: media:[0-9]+:[0-9]+
  const numericPhone = String(phone || "0").replace(/\D/g, "") || "0";
  const key = `media:${numericPhone}:${ts}`;

  await setRaw(
    key,
    JSON.stringify({
      telefono: phone,
      mimeType: safeMime,
      base64: String(base64 || ""),
      createdAt: ts,
    }),
    60 * 60 * 24 * 30
  );

  return key;
}

export async function getMedia(mediaKey) {
  const rawKey = String(mediaKey || "").trim();

  if (!rawKey) return null;

  const candidates = rawKey.startsWith("media:")
    ? [rawKey]
    : [`media:${rawKey}`, rawKey];

  for (const k of candidates) {
    const data = parseMaybeJson(await getRaw(k));
    if (data) return data;
  }

  return null;
}

export async function appendAdminMessage(telefono, mensaje) {
  const phone = cleanPhone(telefono);
  const session = await getSession(phone);
  const text = cleanText(mensaje, 4000);

  session.history = [
    ...(session.history || []),
    {
      role: "model",
      parts: [
        {
          text: `[Admin]: ${text}`,
          ts: Date.now(),
        },
      ],
    },
  ].slice(-40);

  session.ultimoMensaje = text;
  session.lastSeen = Date.now();

  await updateSession(phone, session);

  return session;
}

const defaultConfig = {
  botName: "Asistente virtual Red APDES Tucumán",
  colegios: ["Pucará", "Los Cerros", "Los Cerritos"],
  tono: "cálido, cercano, claro y humano",
  usarEmojis: true,
  pedirColegioSiFalta: true,
  derivarUrgenciasSiempre: true,
  handoverResetMinutes: 120,
  maxHistoryForAI: 14,
  model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  temperature: 0.1,
  maxOutputTokens: 4096,
  menuInicial:
    "¡Hola! 👋 Soy el asistente virtual de la Red APDES Tucumán 🏫\n\n¿En qué te puedo ayudar hoy? Consultas frecuentes:\n\n💰 Cuotas y pagos\n⏰ Horarios y entradas\n👕 Uniforme reglamentario\n📜 Trámites\n💻 Problemas técnicos\n\nEscribí tu consulta 👇",
  mensajeDerivacion:
    "📞 ¡Listo! Tus datos fueron enviados al equipo de soporte. En breve alguien se contactará por acá. 😊",
  baseConocimiento: "",
};

export async function getConfig() {
  const data = parseMaybeJson(await getRaw("config"));

  if (!data) return defaultConfig;

  return {
    ...defaultConfig,
    ...data,
  };
}

export async function updateConfig(partial = {}) {
  const actual = await getConfig();

  const nuevo = {
    ...actual,
    ...partial,
    colegios: Array.isArray(partial.colegios)
      ? partial.colegios.map((c) => cleanText(c, 80)).filter(Boolean).slice(0, 20)
      : actual.colegios,
    temperature: clamp(Number(partial.temperature ?? actual.temperature), 0, 2, actual.temperature),
    maxOutputTokens: clamp(
      Number(partial.maxOutputTokens ?? actual.maxOutputTokens),
      256,
      8192,
      actual.maxOutputTokens
    ),
    maxHistoryForAI: clamp(
      Number(partial.maxHistoryForAI ?? actual.maxHistoryForAI),
      2,
      30,
      actual.maxHistoryForAI
    ),
    handoverResetMinutes: clamp(
      Number(partial.handoverResetMinutes ?? actual.handoverResetMinutes),
      5,
      1440,
      actual.handoverResetMinutes
    ),
  };

  await setRaw("config", JSON.stringify(nuevo));

  return nuevo;
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function getLastText(history = []) {
  const last = [...history]
    .reverse()
    .flatMap((m) => (Array.isArray(m.parts) ? m.parts : []))
    .find((p) => p?.text);

  return last?.text || "";
}

function toPublicConversation(session) {
  const contacto = session.contacto || {};
  const history = Array.isArray(session.history) ? session.history : [];

  return {
    telefono: cleanPhone(session.telefono || session.from),
    nombre: cleanText(session.nombre || contacto.nombre, 160),
    dni: cleanText(session.dni || contacto.dni, 40),
    colegio: cleanText(session.colegio || contacto.colegio, 160),
    curso: cleanText(session.curso || contacto.curso, 160),
    hijos: Array.isArray(session.hijos)
      ? session.hijos
      : Array.isArray(contacto.hijos)
        ? contacto.hijos
        : [],
    status: session.status || "ACTIVE",
    greeted: Boolean(session.greeted),
    assignedTo: cleanText(session.assignedTo || "", 80),
    ultimoMensaje: cleanText(session.ultimoMensaje || getLastText(history), 800),
    lastSeen: Number(session.lastSeen || 0),
    turns: Number(session.turns || history.length || 0),
    history,
  };
}
