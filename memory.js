import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';
dotenv.config();

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SESSION_TIMEOUT_SEC = 14400; // 4 horas

function createNewSession(timestamp) {
  return {
    status: "ACTIVE",
    greeted: false,
    lastIntent: null,
    history: [],
    tempData: {},
    turns: 0,
    lastSeen: timestamp,
    isReturningUser: false
  };
}

export async function getSession(user) {
  try {
    const session = await redis.get(user);
    if (session) {
      const parsed = typeof session === 'string' ? JSON.parse(session) : session;
      const minutosInactivo = (Date.now() - parsed.lastSeen) / 1000 / 60;
      if (minutosInactivo > SESSION_TIMEOUT_SEC / 60) {
        return createNewSession(Date.now());
      }
      return parsed;
    }
  } catch (error) {
    console.error("❌ Error leyendo sesión:", error);
  }
  return createNewSession(Date.now());
}

export async function updateSession(user, data) {
  try {
    const updatedSession = { ...data, lastSeen: Date.now(), turns: (data.turns || 0) + 1 };
    await redis.set(user, JSON.stringify(updatedSession), { ex: SESSION_TIMEOUT_SEC });

    // SET de handovers
    if (data.status === "HANDOVER") {
      await redis.sadd("handovers_activos", user);
      await redis.srem("sesiones_activas", user);
    } else {
      await redis.srem("handovers_activos", user);
      // Solo trackeamos si greeted (ya pasó el saludo inicial)
      if (data.greeted) {
        await redis.sadd("sesiones_activas", user);
        // TTL de 4hs en el SET entry también
        await redis.expire("sesiones_activas", SESSION_TIMEOUT_SEC);
      }
    }
  } catch (error) {
    console.error("❌ Error guardando sesión:", error);
  }
}

/* ─────────────────────────────────────────────
   LISTAR CONVERSACIONES EN HANDOVER
   Usado por el panel admin para mostrar la lista
───────────────────────────────────────────── */
export async function listHandovers() {
  try {
    const telefonos = await redis.smembers("handovers_activos");
    if (!telefonos || telefonos.length === 0) return [];

    const conversaciones = await Promise.all(
      telefonos.map(async (tel) => {
        const session = await redis.get(tel);
        if (!session) {
          await redis.srem("handovers_activos", tel); // limpiar huérfanos
          return null;
        }
        const parsed = typeof session === 'string' ? JSON.parse(session) : session;
        if (parsed.status !== "HANDOVER") {
          await redis.srem("handovers_activos", tel); // limpiar inactivos
          return null;
        }
        // Último mensaje del padre
        const ultimoMensaje = parsed.history
          ?.filter(m => m.role === "user")
          ?.slice(-1)[0]?.parts?.[0]?.text || "(sin mensajes)";

        return {
          telefono: tel,
          lastSeen: parsed.lastSeen,
          turns: parsed.turns || 0,
          history: parsed.history || [],
          ultimoMensaje: ultimoMensaje.substring(0, 80),
        };
      })
    );

    return conversaciones
      .filter(Boolean)
      .sort((a, b) => b.lastSeen - a.lastSeen);

  } catch (error) {
    console.error("❌ Error listando handovers:", error);
    return [];
  }
}

/* ─────────────────────────────────────────────
   LISTAR CONVERSACIONES ACTIVAS (con el bot)
───────────────────────────────────────────── */
export async function listActivas() {
  try {
    const telefonos = await redis.smembers("sesiones_activas");
    if (!telefonos || telefonos.length === 0) return [];

    const conversaciones = await Promise.all(
      telefonos.map(async (tel) => {
        const session = await redis.get(tel);
        if (!session) {
          await redis.srem("sesiones_activas", tel);
          return null;
        }
        const parsed = typeof session === 'string' ? JSON.parse(session) : session;

        // Si expiró o pasó a HANDOVER, la sacamos del SET
        const minutosInactivo = (Date.now() - parsed.lastSeen) / 1000 / 60;
        if (minutosInactivo > SESSION_TIMEOUT_SEC / 60 || parsed.status === "HANDOVER") {
          await redis.srem("sesiones_activas", tel);
          return null;
        }

        const ultimoMensaje = parsed.history
          ?.slice(-1)[0]?.parts?.[0]?.text || "(sin mensajes)";

        return {
          telefono: tel,
          lastSeen: parsed.lastSeen,
          turns: parsed.turns || 0,
          history: parsed.history || [],
          ultimoMensaje: ultimoMensaje.substring(0, 80),
        };
      })
    );

    return conversaciones
      .filter(Boolean)
      .sort((a, b) => b.lastSeen - a.lastSeen);

  } catch (error) {
    console.error("❌ Error listando activas:", error);
    return [];
  }
}

/* ─────────────────────────────────────────────
   CONTACTOS — Perfil permanente por número
   Nunca expira. Sobrevive resets de sesión.
───────────────────────────────────────────── */

// Obtener contacto (crea uno vacío si no existe)
export async function getContacto(telefono) {
  try {
    const data = await redis.get(`contacto:${telefono}`);
    if (data) return typeof data === 'string' ? JSON.parse(data) : data;
  } catch {}
  return { nombre: null, hijos: [], lastSeen: null };
}

// Guardar/actualizar contacto
export async function updateContacto(telefono, datos) {
  try {
    const actual = await getContacto(telefono);
    const nuevo = {
      ...actual,
      ...datos,
      // Merge de hijos: no duplicar nombres
      hijos: datos.hijos
        ? [...new Set([...(actual.hijos || []), ...datos.hijos])]
        : actual.hijos || [],
      lastSeen: Date.now(),
    };
    // Sin TTL — permanente
    await redis.set(`contacto:${telefono}`, JSON.stringify(nuevo));
    return nuevo;
  } catch (error) {
    console.error("❌ Error guardando contacto:", error);
    return null;
  }
}

// Listar todos los contactos conocidos
export async function listContactos() {
  try {
    const keys = await redis.keys("contacto:*");
    if (!keys || keys.length === 0) return [];

    const contactos = await Promise.all(
      keys.map(async (key) => {
        const data = await redis.get(key);
        if (!data) return null;
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        const telefono = key.replace("contacto:", "");
        return { telefono, ...parsed };
      })
    );

    return contactos
      .filter(Boolean)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  } catch (error) {
    console.error("❌ Error listando contactos:", error);
    return [];
  }
}

/* ─────────────────────────────────────────────
   MEDIA — Guardado temporal de imágenes/audios
   TTL de 48hs — suficiente para que el admin lo vea
───────────────────────────────────────────── */
export async function saveMedia(telefono, mimeType, base64) {
  try {
    const key = `media:${telefono}:${Date.now()}`;
    await redis.set(key, JSON.stringify({ mimeType, base64 }), { ex: 60 * 60 * 48 });
    return key;
  } catch (error) {
    console.error("❌ Error guardando media:", error);
    return null;
  }
}

export async function getMedia(key) {
  try {
    const data = await redis.get(key);
    if (!data) return null;
    return typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return null;
  }
}