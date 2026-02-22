import { Redis } from '@upstash/redis';
import dotenv from 'dotenv';

dotenv.config();

// Conexión a la base de datos de Vercel (Upstash)
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// En Redis el tiempo se maneja en segundos, no en milisegundos.
// 4 horas = 14400 segundos
const SESSION_TIMEOUT_SEC = 14400; 

/* ================================
   FACTORY (Tu Estructura Base intacta)
================================ */
function createNewSession(timestamp) {
  return {
    status: "ACTIVE", // ACTIVE, HANDOVER
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
    const now = Date.now();

    // 1. Usuario recurrente (La sesión existe en Redis)
    if (session) {
      // Parseamos por si la librería lo devuelve como string
      let parsedSession = typeof session === 'string' ? JSON.parse(session) : session;
      return parsedSession;
    }
  } catch (error) {
    console.error("❌ Error leyendo de Upstash Redis:", error);
  }

  // 2. Usuario Nuevo (o sesión que fue borrada por el recolector automático)
  return createNewSession(Date.now());
}

export async function updateSession(user, data) {
  try {
    // Primero traemos la sesión actual para no pisar datos viejos
    const currentSession = await getSession(user);

    // Tu misma lógica de actualización eficiente
    const updatedSession = {
      ...currentSession,
      ...data,
      lastSeen: Date.now(),
      turns: currentSession.turns + 1
    };

    // ¡ACÁ OCURRE LA MAGIA! 🪄
    // Al pasarle "{ ex: SESSION_TIMEOUT_SEC }", le decimos a Redis:
    // "Si este usuario no me habla por 4 horas, borrá esta sesión para siempre".
    // Esto reemplaza tu setInterval y tu Garbage Collector al 100%.
    await redis.set(user, JSON.stringify(updatedSession), { ex: SESSION_TIMEOUT_SEC });
    
  } catch (error) {
    console.error("❌ Error guardando en Upstash Redis:", error);
  }
}