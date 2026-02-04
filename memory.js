import fs from "fs";
import path from "path";

const DB_FILE = path.join(process.cwd(), "sessions_db.json");
const SESSION_TIMEOUT_MS = 1000 * 60 * 60 * 4; // 4 horas
const ONE_DAY_MS = 1000 * 60 * 60 * 24;

let sessions = {};

/* ================================
   CARGA INICIAL SEGURA
================================ */
try {
  if (fs.existsSync(DB_FILE)) {
    const rawData = fs.readFileSync(DB_FILE, "utf-8");
    // Verificamos que no esté vacío para evitar errores de parseo
    if (rawData.trim()) {
        sessions = JSON.parse(rawData);
    }
  }
} catch (err) {
  console.error("⚠️ Error crítico cargando sesiones (iniciando vacío):", err);
  sessions = {};
}

/* ================================
   PERSISTENCIA ATÓMICA (ANTI-CORRUPCIÓN)
================================ */
let saveTimeout = null;

function persistDebounced() {
  // Si ya había un guardado pendiente, lo cancelamos para posponerlo
  // Esto asegura que solo guardamos cuando el sistema se "calma" un poco
  if (saveTimeout) clearTimeout(saveTimeout);

  saveTimeout = setTimeout(() => {
    try {
      const tempFile = `${DB_FILE}.tmp`;
      
      // 1. Escribir en archivo temporal
      fs.writeFileSync(tempFile, JSON.stringify(sessions, null, 2));
      
      // 2. Renombrar atómicamente (Reemplazo instantáneo)
      // Si falla la escritura arriba, el archivo original NO se toca.
      fs.renameSync(tempFile, DB_FILE);
      
    } catch (err) {
      console.error("❌ Error guardando sesiones en disco:", err);
    }
  }, 1000); // Guardamos 1 segundo después del último cambio
}

/* ================================
   SESIONES
================================ */
export function getSession(user) {
  const now = Date.now();

  // 1. Usuario Nuevo
  if (!sessions[user]) {
    sessions[user] = createNewSession(now);
    persistDebounced();
    return sessions[user];
  }

  // 2. Usuario que vuelve tras inactividad (Reset)
  if (now - sessions[user].lastSeen > SESSION_TIMEOUT_MS) {
    // Guardamos si era un usuario recurrente antes de resetear
    const wasReturning = true; 
    
    sessions[user] = createNewSession(now);
    sessions[user].isReturningUser = wasReturning;
    
    persistDebounced();
    return sessions[user];
  }

  return sessions[user];
}

export function updateSession(user, data) {
  if (!sessions[user]) return;

  // Actualización eficiente
  sessions[user] = {
      ...sessions[user],
      ...data,
      lastSeen: Date.now(),
      turns: sessions[user].turns + 1
  };

  persistDebounced();
}

/* ================================
   FACTORY (Estructura Base)
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
   GARBAGE COLLECTOR (Limpieza)
================================ */
// Se ejecuta cada 1 hora para borrar sesiones de más de 24hs
setInterval(() => {
  const now = Date.now();
  let changed = false;
  const userKeys = Object.keys(sessions);

  for (const user of userKeys) {
    if (now - sessions[user].lastSeen > ONE_DAY_MS) {
      delete sessions[user];
      changed = true;
    }
  }

  if (changed) {
      console.log("🧹 Limpieza de memoria realizada.");
      persistDebounced();
  }
}, 1000 * 60 * 60);