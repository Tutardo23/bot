import { Redis } from "@upstash/redis";
import crypto from "crypto";

const hasRedis = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const redis = hasRedis ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN }) : null;
const local = new Map();

function key(k) { return `botred:${k}`; }
async function getRaw(k) {
  if (redis) return await redis.get(key(k));
  return local.get(key(k)) ?? null;
}
async function setRaw(k, v, exSeconds = null) {
  if (redis) {
    if (exSeconds) return await redis.set(key(k), v, { ex: exSeconds });
    return await redis.set(key(k), v);
  }
  local.set(key(k), v);
  return true;
}
async function delRaw(k) {
  if (redis) return await redis.del(key(k));
  return local.delete(key(k));
}
async function listKeys(prefix) {
  if (!redis) {
    return [...local.keys()].filter(k => k.startsWith(key(prefix))).map(k => k.replace(/^botred:/, ""));
  }
  let cursor = 0;
  const out = [];
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: key(`${prefix}*`), count: 100 });
    cursor = Number(nextCursor);
    out.push(...keys.map(k => String(k).replace(/^botred:/, "")));
  } while (cursor !== 0);
  return out;
}

export function emptySession(telefono) {
  return {
    telefono,
    status: "ACTIVE",
    greeted: false,
    history: [],
    turns: 0,
    lastSeen: Date.now(),
    ultimoMensaje: "",
    contacto: {},
    assignedTo: null
  };
}

export async function getSession(telefono) {
  const data = await getRaw(`session:${telefono}`);
  if (!data) return emptySession(telefono);
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function updateSession(telefono, session) {
  const cleaned = {
    ...session,
    telefono,
    lastSeen: session.lastSeen || Date.now(),
    history: (session.history || []).slice(-30)
  };
  await setRaw(`session:${telefono}`, JSON.stringify(cleaned), 60 * 60 * 24 * 90);
  await setRaw(`index:${telefono}`, String(Date.now()), 60 * 60 * 24 * 90);
  return cleaned;
}

export async function deleteSession(telefono) {
  await delRaw(`session:${telefono}`);
  await delRaw(`contact:${telefono}`);
  await delRaw(`index:${telefono}`);
}

export async function listSessions() {
  const keys = await listKeys("index:");
  const phones = keys.map(k => k.replace("index:", ""));
  const sessions = [];
  for (const telefono of phones) {
    const s = await getSession(telefono);
    if (s?.telefono) sessions.push(s);
  }
  return sessions.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

export async function getContacto(telefono) {
  const data = await getRaw(`contact:${telefono}`);
  if (!data) return {};
  return typeof data === "string" ? JSON.parse(data) : data;
}

export async function updateContacto(telefono, datos) {
  const actual = await getContacto(telefono);
  const limpio = sanitizeContact({ ...actual, ...datos });
  await setRaw(`contact:${telefono}`, JSON.stringify(limpio), 60 * 60 * 24 * 365);
  const session = await getSession(telefono);
  session.contacto = limpio;
  await updateSession(telefono, session);
  return limpio;
}

function sanitizeContact(c) {
  const cleanText = v => String(v || "").replace(/[<>]/g, "").slice(0, 120).trim();
  const dni = String(c.dni || "").replace(/\D/g, "").slice(0, 12);
  return {
    nombre: cleanText(c.nombre),
    dni,
    colegio: cleanText(c.colegio),
    curso: cleanText(c.curso),
    hijos: Array.isArray(c.hijos) ? c.hijos.map(cleanText).filter(Boolean).slice(0, 8) : []
  };
}

export async function saveMedia(telefono, mimeType, base64) {
  const id = crypto.randomBytes(16).toString("hex");
  const safeMime = String(mimeType || "application/octet-stream").split(";")[0].slice(0, 80);
  await setRaw(`media:${id}`, JSON.stringify({ telefono, mimeType: safeMime, base64, createdAt: Date.now() }), 60 * 60 * 24 * 30);
  return id;
}

export async function getMedia(mediaKey) {
  const data = await getRaw(`media:${mediaKey}`);
  if (!data) return null;
  return typeof data === "string" ? JSON.parse(data) : data;
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
  model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  temperature: 0.1,
  maxOutputTokens: 2048,
  menuInicial: "¡Hola! 👋 Soy el asistente virtual de la Red APDES Tucumán 🏫\n\n¿En qué te puedo ayudar hoy? Consultas frecuentes:\n\n💰 Cuotas y pagos\n⏰ Horarios y entradas\n👕 Uniforme reglamentario\n📜 Trámites\n💻 Problemas técnicos\n\nEscribí tu consulta 👇",
  mensajeDerivacion: "📞 ¡Listo! Tus datos fueron enviados al equipo de soporte. En breve alguien se contactará por acá. 😊",
  baseConocimiento: ""
};

export async function getConfig() {
  const data = await getRaw("config");
  if (!data) return defaultConfig;
  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  return { ...defaultConfig, ...parsed };
}

export async function updateConfig(partial) {
  const actual = await getConfig();
  const nuevo = {
    ...actual,
    ...partial,
    colegios: Array.isArray(partial.colegios) ? partial.colegios.map(String).map(s => s.trim()).filter(Boolean).slice(0, 20) : actual.colegios,
    temperature: Math.max(0, Math.min(1, Number(partial.temperature ?? actual.temperature))),
    maxOutputTokens: Math.max(256, Math.min(4096, Number(partial.maxOutputTokens ?? actual.maxOutputTokens))),
    maxHistoryForAI: Math.max(4, Math.min(30, Number(partial.maxHistoryForAI ?? actual.maxHistoryForAI))),
    handoverResetMinutes: Math.max(10, Math.min(1440, Number(partial.handoverResetMinutes ?? actual.handoverResetMinutes)))
  };
  await setRaw("config", JSON.stringify(nuevo));
  return nuevo;
}

export async function appendAdminMessage(telefono, mensaje) {
  const session = await getSession(telefono);
  session.history = [...(session.history || []), { role: "model", parts: [{ text: `[Admin]: ${mensaje}`, ts: Date.now() }] }].slice(-30);
  session.ultimoMensaje = mensaje;
  session.lastSeen = Date.now();
  await updateSession(telefono, session);
}
