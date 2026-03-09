import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getSession, updateSession } from "./memory.js";
import { enviarAChatwoot, asignarAHumano } from "./chatwoot.js";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const HANDOVER_RESET_MINUTES = 120;

/* =========================================
   CARGADOR DE INFORMACIÓN (Cerebro)
========================================= */
function getContextoActualizado() {
  try {
    const filePath = path.join(process.cwd(), "datos_colegio.txt");
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    console.error("Error leyendo datos_colegio.txt:", error);
    return "No hay información disponible por el momento.";
  }
}

/* =========================================
   LIMPIADOR DE HISTORIAL
========================================= */
function limpiarHistorial(history) {
  return history.map(msg => ({
    ...msg,
    parts: msg.parts.map(part => ({
      ...part,
      text: part.text
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
    }))
  }));
}

/* =========================================
   CONTROLADOR PRINCIPAL
========================================= */
export async function handleTestMessage(message) {
  const from = message.from;
  const text = message.text.body;

  let session = await getSession(from);

  // Si está en HANDOVER, chequeamos si ya pasó el tiempo para reactivar
  if (session.status === "HANDOVER") {
    const minutos = (Date.now() - session.lastSeen) / 1000 / 60;
    if (minutos >= HANDOVER_RESET_MINUTES) {
      console.log(`🔄 Reactivando bot para ${from} (${Math.round(minutos)} min inactivo).`);
      session = { status: "ACTIVE", greeted: false, lastIntent: null, history: [], tempData: {}, turns: 0, lastSeen: Date.now(), isReturningUser: true };
    } else {
      await enviarAChatwoot(from, text, "incoming");
      await updateSession(from, session);
      return null;
    }
  }

  await enviarAChatwoot(from, text, "incoming");

  // El historial no puede empezar con un mensaje del modelo
  while (session.history?.length > 0 && session.history[0].role === "model") {
    session.history.shift();
  }

  const fechaActual = new Date().toLocaleString("es-AR", {
    timeZone: "America/Argentina/Tucuman",
    weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "numeric"
  });

  const promptMaestro = `
Sos "Pucarito", asistente virtual del Colegio Pucará. Ayudás a padres y tutores.

CONTEXTO:
- Fecha/hora: ${fechaActual}
- Primer mensaje: ${!session.greeted ? "NO — saludá, presentate y mostrá el menú" : "SÍ — ir directo al grano, sin saludar"}
- Usuario conocido: ${session.isReturningUser ? "SÍ — podés hacer una bienvenida breve" : "NO"}

BASE DE CONOCIMIENTO:
${getContextoActualizado()}

REGLAS:
1. Nunca uses asteriscos (*) para negritas. Cero asteriscos.
2. Párrafos cortos. Emojis moderados y funcionales.
3. Si preguntan algo ajeno al colegio: decí que solo sabés temas escolares.
4. Si el usuario te dijo su nombre, usalo.
5. Urgencia médica, bullying o accidente: respondé solo ACTION_HANDOVER de inmediato.

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

HANDOVER: Cuando la base de conocimiento indique ACTION_HANDOVER, respondé SOLO esa palabra, sin ningún texto extra.
  `.trim();

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: { role: "system", parts: [{ text: promptMaestro }] },
      generationConfig: { temperature: 0.1, maxOutputTokens: 1000 }
    });

    const historialLimpio = limpiarHistorial(session.history || []);
    const chat = model.startChat({ history: historialLimpio });
    const result = await chat.sendMessage(text);
    const botResponse = result.response.text().trim();

    // Capturador de HANDOVER
    if (botResponse.includes("ACTION_HANDOVER")) {
      session.status = "HANDOVER";
      await updateSession(from, session);
      const mensajeHandover = "📞 ¡Listo! Tus datos ya fueron enviados al equipo. En breve alguien te responde por acá. 😊";
      await enviarAChatwoot(from, mensajeHandover, "outgoing");
      await asignarAHumano(from);
      return mensajeHandover;
    }

    await enviarAChatwoot(from, botResponse, "outgoing");

    session.greeted = true;

    // Guardamos historial limpio (máx. 14 turnos)
    const rawHistory = await chat.getHistory();
    session.history = rawHistory
      .map(msg => ({
        role: msg.role,
        parts: [{ text: msg.parts[0].text.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1") }]
      }))
      .slice(-14);

    await updateSession(from, session);
    return botResponse;

  } catch (error) {
    console.error("❌ Error en la lógica del bot:", error);
    return "Tuve un pequeño micro-corte técnico. ¿Podrías escribirlo de nuevo? 😅";
  }
}