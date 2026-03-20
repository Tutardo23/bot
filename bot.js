import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getSession, updateSession, getContacto, updateContacto, saveMedia } from "./memory.js";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const HANDOVER_RESET_MINUTES = 120;

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
  if (!texto) return "";
  return texto.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1");
}

// Solo pasa a Gemini los campos que acepta: text e inlineData
// ts, mediaKey, mimeType, image son campos nuestros — los sacamos acá
function limpiarHistorial(history) {
  return history.map(msg => ({
    role: msg.role,
    parts: msg.parts.map(part => {
      const limpia = { text: limpiarAsteriscos(part.text || "") };
      if (part.inlineData) limpia.inlineData = part.inlineData;
      // Gemini no acepta parts completamente vacíos
      if (!limpia.text && !limpia.inlineData) limpia.text = " ";
      return limpia;
    })
  }));
}

// Arma las partes del mensaje actual para Gemini (texto + media si existe)
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

  // ── HANDOVER activo: bot en silencio ──────
  if (session.status === "HANDOVER") {
    const minutos = (Date.now() - session.lastSeen) / 1000 / 60;

    if (minutos >= HANDOVER_RESET_MINUTES) {
      console.log(`🔄 Reactivando bot para ${from} (${Math.round(minutos)} min inactivo).`);
      session = { status: "ACTIVE", greeted: false, lastIntent: null, history: [], tempData: {}, turns: 0, lastSeen: Date.now(), isReturningUser: true };
    } else {
      // Guardamos el mensaje en el historial para que el admin lo vea
      // FIX: usamos saveMedia en vez de guardar base64 crudo en Redis
      let parteGuardada;
      if (mediaData) {
        const mediaKey = await saveMedia(from, mediaData.mimeType, mediaData.base64);
        const mime = mediaData.mimeType.split(";")[0].trim();
        parteGuardada = {
          text: text || "",
          mediaKey,
          mimeType: mime,
          ts: Date.now()
        };
      } else {
        parteGuardada = { text, ts: Date.now() };
      }

      session.history = [...(session.history || []), { role: "user", parts: [parteGuardada] }];
      await updateSession(from, session);
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

  const contacto = await getContacto(from);
  const nombrePadre = contacto.nombre || null;
  const hijos = contacto.hijos?.length > 0 ? contacto.hijos.join(", ") : null;

  const prompt = `
Sos "Pucarito", asistente virtual del Colegio Pucará. Ayudás a padres y tutores.

CONTEXTO:
- Fecha/hora: ${fechaActual}
- Primer mensaje: ${!session.greeted ? "NO — saludá, presentate y mostrá el menú" : "SÍ — ir directo al grano, sin saludar"}
- Usuario recurrente: ${session.isReturningUser ? "SÍ — bienvenida breve" : "NO"}
- Nombre del padre/tutor: ${nombrePadre ? nombrePadre : "desconocido — si lo menciona, guardalo mentalmente y usalo"}
- Hijos conocidos: ${hijos ? hijos : "ninguno registrado aún"}

BASE DE CONOCIMIENTO:
${getContexto()}

REGLAS DE COMPORTAMIENTO:
1. Nunca uses asteriscos (*) para negritas.
2. Párrafos cortos. Emojis moderados.
3. Temas ajenos al colegio: decí que solo sabés de la institución.
4. Si el padre te dice su nombre, usalo en la conversación.
5. DETECCIÓN DE NOMBRES — Si en algún mensaje el padre menciona su nombre o el de su hijo/a, extraelo y respondé con este JSON al FINAL de tu respuesta (invisible para el usuario, después de tu mensaje normal):
   |||CONTACTO:{"nombre":"Juan Pérez","hijos":["Sofía","Lucas"]}|||
   Solo incluí los campos que mencionó. Si solo dijo su nombre: |||CONTACTO:{"nombre":"Juan Pérez"}|||
   Si solo mencionó un hijo: |||CONTACTO:{"hijos":["Sofía"]}|||
   Si no hay datos nuevos de contacto en este mensaje: no incluyas el bloque |||CONTACTO|||
6. Audio: transcribilo y respondé como si fuera texto.
7. Imagen: analizala y respondé en contexto.

REGLA CRÍTICA — CUÁNDO DERIVAR A HUMANO (ACTION_HANDOVER):
Derivás ÚNICAMENTE en estos casos, y SOLO cuando se cumplen TODAS las condiciones:

CASO A — Problema técnico (contraseña/acceso):
  → Primero AGOTASTE todos los pasos de diagnóstico de la base de conocimiento
  → El padre confirmó que probó todo y sigue sin poder entrar
  → El padre YA TE DIO su nombre completo y el nombre del alumno
  Solo entonces respondés: ACTION_HANDOVER

CASO B — Cuenta nueva:
  → El padre pidió CREAR una cuenta (no recuperarla)
  → El padre YA TE DIO su nombre completo y su DNI
  Solo entonces respondés: ACTION_HANDOVER

CASO C — Pide hablar con humano:
  → El padre explícitamente pidió hablar con una persona
  → El padre YA TE DIO su nombre completo y el nombre del alumno
  Solo entonces respondés: ACTION_HANDOVER

CASO D — Urgencia real:
  → Es una emergencia médica, accidente, o bullying grave
  → Derivás DE INMEDIATO sin pedir datos
  Respondés: ACTION_HANDOVER

PROHIBIDO derivar si:
- El padre solo mencionó que tiene un problema (sin haber intentado los pasos)
- No completaste el diagnóstico de la base de conocimiento
- No te dieron los datos requeridos todavía
- Hay dudas sobre cuotas, horarios, uniforme, trámites → resolvés VOS

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

HANDOVER: Cuando se cumplan TODAS las condiciones de arriba, respondé SOLO la palabra ACTION_HANDOVER sin ningún texto extra. Si no se cumplen todas, seguí ayudando.
  `.trim();

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: { role: "system", parts: [{ text: prompt }] },
      generationConfig: { temperature: 0.1, maxOutputTokens: 1000 },
    });

    const chat = model.startChat({ history: limpiarHistorial(session.history || []) });
    const result = await chat.sendMessage(buildParts(text, mediaData));
    let botResponse = result.response.text().trim();

    // ── Extraer y guardar datos de contacto ──
    const contactoMatch = botResponse.match(/\|\|\|CONTACTO:(\{.*?\})\|\|\|/s);
    if (contactoMatch) {
      try {
        const datosContacto = JSON.parse(contactoMatch[1]);
        await updateContacto(from, datosContacto);
        console.log(`👤 Contacto actualizado para ${from}:`, datosContacto);
      } catch {}
      botResponse = botResponse.replace(/\|\|\|CONTACTO:.*?\|\|\|/s, "").trim();
    }

    // ── HANDOVER detectado ─────────────────
    if (botResponse.includes("ACTION_HANDOVER")) {
      const historialConMensajeActual = [
        ...(session.history || []),
        { role: "user", parts: [{ text: text || "[media]", ts: Date.now() }] }
      ];
      session.status = "HANDOVER";
      session.history = historialConMensajeActual;
      await updateSession(from, session);
      return "📞 ¡Listo! Tus datos fueron enviados al equipo. En breve alguien te responde por acá. 😊";
    }

    session.greeted = true;

    // Guardamos historial (máx. 14 turnos) con mediaKey si corresponde
    let mediaKey = null;
    if (mediaData) {
      mediaKey = await saveMedia(from, mediaData.mimeType, mediaData.base64);
    }

    const rawHistory = await chat.getHistory();
    session.history = rawHistory
      .map((msg, idx) => {
        const textoBase = limpiarAsteriscos(
          msg.parts.map(p => p.text || "").filter(Boolean).join(" ")
        );
        const esUltimoUser = msg.role === "user" && idx === rawHistory.length - 2;
        if (esUltimoUser && mediaKey) {
          return {
            role: msg.role,
            parts: [{ text: textoBase, mediaKey, mimeType: mediaData.mimeType.split(";")[0].trim(), ts: Date.now() }]
          };
        }
        return { role: msg.role, parts: [{ text: textoBase, ts: Date.now() }] };
      })
      .slice(-14);

    await updateSession(from, session);
    return botResponse;

  } catch (error) {
    console.error("❌ Error en el bot:", error);
    return "Tuve un pequeño micro-corte técnico. ¿Podrías escribirlo de nuevo? 😅";
  }
}