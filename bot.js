import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getSession, updateSession } from "./memory.js";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const HANDOVER_RESET_MINUTES = 120;

// Socket.io se inyecta desde index.js para emitir eventos al panel
let _io = null;
export function setIO(io) { _io = io; }
function emitir(evento, data) { if (_io) _io.emit(evento, data); }

/* ─────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────── */
function getContexto() {
  try {
    return fs.readFileSync(path.join(process.cwd(), "datos_colegio.txt"), "utf-8");
  } catch {
    return "No hay información disponible.";
  }
}

function limpiarAsteriscos(texto) {
  return texto.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1");
}

function limpiarHistorial(history) {
  return history.map(msg => ({
    ...msg,
    parts: msg.parts.map(part => ({ ...part, text: limpiarAsteriscos(part.text) }))
  }));
}

// Arma el array de partes para Gemini (texto + imagen/audio si existe)
function buildParts(text, mediaData) {
  if (!mediaData) return [{ text: text || "" }];

  const mime = mediaData.mimeType.split(";")[0].trim();
  return [
    { text: mime.startsWith("audio/") ? "El usuario envió este audio:" : "El usuario envió esta imagen:" },
    { inlineData: { mimeType: mime, data: mediaData.base64 } },
    ...(text?.trim() ? [{ text }] : [])
  ];
}

/* ─────────────────────────────────────────────
   CONTROLADOR PRINCIPAL
───────────────────────────────────────────── */
export async function handleTestMessage(message) {
  const from = message.from;
  const text = message.text?.body || "";
  const mediaData = message.mediaData || null;

  let session = await getSession(from);

  // ── HANDOVER activo ───────────────────────
  if (session.status === "HANDOVER") {
    const minutos = (Date.now() - session.lastSeen) / 1000 / 60;

    if (minutos >= HANDOVER_RESET_MINUTES) {
      // Pasó el tiempo → bot retoma solo
      console.log(`🔄 Reactivando bot para ${from} (${Math.round(minutos)} min inactivo).`);
      session = { status: "ACTIVE", greeted: false, lastIntent: null, history: [], tempData: {}, turns: 0, lastSeen: Date.now(), isReturningUser: true };
    } else {
      // Bot en silencio → guardamos el mensaje del padre y avisamos al panel
      const textoGuardado = mediaData ? `[${message.type === "audio" ? "🎙️ Audio" : "🖼️ Imagen"}] ${text}` : text;
      session.history = [...(session.history || []), { role: "user", parts: [{ text: textoGuardado }] }];
      await updateSession(from, session);

      emitir("nuevo_mensaje_handover", {
        telefono: from,
        mensaje: { text: textoGuardado, ts: Date.now() }
      });
      return null;
    }
  }

  // Historial no puede empezar con "model"
  while (session.history?.length > 0 && session.history[0].role === "model") {
    session.history.shift();
  }

  const fechaActual = new Date().toLocaleString("es-AR", {
    timeZone: "America/Argentina/Tucuman",
    weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "numeric",
  });

  const prompt = `
Sos "Pucarito", asistente virtual del Colegio Pucará. Ayudás a padres y tutores.

CONTEXTO:
- Fecha/hora: ${fechaActual}
- Primer mensaje: ${!session.greeted ? "NO — saludá, presentate y mostrá el menú" : "SÍ — ir directo al grano, sin saludar"}
- Usuario recurrente: ${session.isReturningUser ? "SÍ — bienvenida breve" : "NO"}

BASE DE CONOCIMIENTO:
${getContexto()}

REGLAS:
1. Nunca uses asteriscos (*) para negritas.
2. Párrafos cortos. Emojis moderados.
3. Temas ajenos al colegio: decí que solo sabés de la institución.
4. Si te dijeron el nombre del usuario, usalo.
5. Urgencia médica, bullying o accidente: respondé solo ACTION_HANDOVER de inmediato.
6. Audio: transcribilo y respondé como si fuera texto.
7. Imagen: analizala y respondé en contexto.

MENÚ INICIAL (solo si es el primer mensaje, copiar exacto):
¡Hola! 👋 Soy Pucarito, el asistente virtual del Colegio Pucará 🏫

¿En qué te puedo ayudar? Consultas frecuentes:

💰 Cuotas y pagos
⏰ Horarios y entradas
🍽️ Comedor del día
👕 Uniforme reglamentario
📜 Trámites (constancias, pases)
💻 Problemas con Google o Colegium

Escribí tu consulta o elegí un tema 👇

HANDOVER: Cuando corresponda, respondé SOLO la palabra ACTION_HANDOVER sin ningún texto extra.
  `.trim();

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: { role: "system", parts: [{ text: prompt }] },
      generationConfig: { temperature: 0.1, maxOutputTokens: 1000 },
    });

    const chat = model.startChat({ history: limpiarHistorial(session.history || []) });
    const result = await chat.sendMessage(buildParts(text, mediaData));
    const botResponse = result.response.text().trim();

    // ── HANDOVER detectado ─────────────────
    if (botResponse.includes("ACTION_HANDOVER")) {
      session.status = "HANDOVER";
      await updateSession(from, session);

      // Notificamos al panel con el historial completo
      emitir("nuevo_handover", {
        telefono: from,
        lastSeen: Date.now(),
        turns: session.turns,
        history: session.history || [],
        ultimoMensaje: text.substring(0, 80),
      });

      return "📞 ¡Listo! Tus datos fueron enviados al equipo. En breve alguien te responde por acá. 😊";
    }

    session.greeted = true;

    // Guardamos historial limpio (máx. 14 turnos, sin asteriscos, sin base64)
    const rawHistory = await chat.getHistory();
    session.history = rawHistory
      .map(msg => ({
        role: msg.role,
        parts: [{
          text: limpiarAsteriscos(
            msg.parts.map(p => p.text || (p.inlineData ? "[media]" : "")).filter(Boolean).join(" ")
          )
        }]
      }))
      .slice(-14);

    await updateSession(from, session);
    return botResponse;

  } catch (error) {
    console.error("❌ Error en el bot:", error);
    return "Tuve un pequeño micro-corte técnico. ¿Podrías escribirlo de nuevo? 😅";
  }
}