import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';

dotenv.config();

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// 4 horas en segundos (tiempo máximo de inactividad para sesiones ACTIVAS)
const SESSION_TIMEOUT_SEC = 14400;

// 4 horas en milisegundos (para comparar con Date.now())
const SESSION_TIMEOUT_MS = SESSION_TIMEOUT_SEC * 1000;

/* ================================
   FACTORY
================================ */
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

/* ================================
   SESIONES (Nube)
================================ */
export async function getSession(user) {
  try {
    const session = await redis.get(user);

    if (session) {
      let parsedSession = typeof session === 'string' ? JSON.parse(session) : session;

      // ✅ FIX CLAVE: Si el último mensaje fue hace más de 4 horas, sesión nueva
      // Esto resuelve el bug de que la sesión vivía eternamente con uso frecuente
      const minutosInactivo = (Date.now() - parsedSession.lastSeen) / 1000 / 60;
      
      if (minutosInactivo > SESSION_TIMEOUT_SEC / 60) {
        console.log(`🔄 Sesión expirada para ${user} (${Math.round(minutosInactivo)} minutos inactivo). Creando nueva.`);
        return createNewSession(Date.now());
      }

      return parsedSession;
    }
  } catch (error) {
    console.error("❌ Error leyendo de Upstash Redis:", error);
  }

  // Usuario nuevo o sesión borrada
  return createNewSession(Date.now());
}

export async function updateSession(user, data) {
  try {
    const updatedSession = {
      ...data,
      lastSeen: Date.now(),
      turns: (data.turns || 0) + 1
    };

    // El TTL de Redis se usa como red de seguridad adicional
    // La lógica de expiración real está en getSession() arriba
    await redis.set(user, JSON.stringify(updatedSession), { ex: SESSION_TIMEOUT_SEC });

  } catch (error) {
    console.error("❌ Error guardando en Upstash Redis:", error);
  }
}