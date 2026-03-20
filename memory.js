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

    // Mantenemos el SET de handovers sincronizado
    if (data.status === "HANDOVER") {
      await redis.sadd("handovers_activos", user);
    } else {
      await redis.srem("handovers_activos", user);
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