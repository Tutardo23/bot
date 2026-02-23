import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getSession, updateSession } from "./memory.js";
import { enviarAChatwoot, asignarAHumano } from "./chatwoot.js";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* =========================================
   CARGADOR DE INFORMACIÓN
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
   CONTROLADOR PRINCIPAL
========================================= */
export async function handleTestMessage(message) {
  const from = message.from;
  const text = message.text.body;

  // 🔥 MANDA EL MENSAJE DEL PADRE A CHATWOOT 🔥
  enviarAChatwoot(from, text, "incoming");

  const session = await getSession(from);

  // 🔥 REACTIVAR BOT MANUALMENTE
  if (text.trim().toLowerCase() === "#bot") {
    session.status = "ACTIVE";
    await updateSession(from, session);
    return "🤖 Bot reactivado correctamente.";
  }

  // 🔥 SI ESTÁ EN MODO HUMANO, NO RESPONDE
  if (session.status === "HANDOVER") {
    console.log("Conversación en modo humano.");
    return null;
  }

  while (session.history && session.history.length > 0 && session.history[0].role === "model") {
    session.history.shift();
  }

  const fechaActual = new Date().toLocaleString("es-AR", { 
    timeZone: "America/Argentina/Tucuman", 
    weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: 'numeric' 
  });

  const infoColegio = getContextoActualizado();

  const promptMaestro = `
    INSTRUCCIÓN DE SISTEMA - NIVEL DE SEGURIDAD MÁXIMO (PRIORIDAD 0):
    Eres "Pucarito", el Asistente Virtual Oficial del Colegio Pucará.

    📚 TU CEREBRO (FUENTE DE VERDAD ABSOLUTA):
    """
    ${infoColegio}
    """

    ⏰ CONTEXTO EN TIEMPO REAL:
    - Fecha y hora actual: ${fechaActual}.

    💎 REGLAS DE ORO DE COMPORTAMIENTO (MODO WHATSAPP):
    1. 🗣️ Tono conversacional con emojis.
    2. No repetir saludos.
    3. Respuestas precisas.
    4. Escudo suave si preguntan algo fuera del colegio.
    5. Recordar nombres si el usuario los dice.

    🚨 PROTOCOLO DE DERIVACIÓN:
    Si necesita humano:
    - Pedir nombre completo.
    - Luego responder SOLO: ACTION_HANDOVER
  `;

  try {
    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.5-flash",
      systemInstruction: {
        role: "system",
        parts: [{ text: promptMaestro }]
      },
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 500,
      }
    });

    const chat = model.startChat({
      history: session.history || [],
    });

    const result = await chat.sendMessage(text);
    const botResponse = result.response.text();

    enviarAChatwoot(from, botResponse, "outgoing");

    // 🔥 HANDOVER
    if (botResponse.includes("ACTION_HANDOVER")) {
      session.status = "HANDOVER";
      await updateSession(from, session);
      await asignarAHumano(from);

      return "📞 ¡Gracias! Tus datos fueron enviados a secretaría. En breve una persona te responde.";
    }

    const rawHistory = await chat.getHistory();

    session.history = rawHistory.map(msg => ({
      role: msg.role,
      parts: [{ text: msg.parts[0].text }]
    }));

    if (session.history.length > 14) {
      session.history = session.history.slice(-14);
    }

    await updateSession(from, session);

    return botResponse;

  } catch (error) {
    console.error("Error IA:", error);

    if (error.message && error.message.includes("role 'user'")) {
      session.history = [];
      await updateSession(from, session);
      return "Disculpá, se me reseteó la conexión. ¿Me repetís lo último? 😅";
    }

    return "Tuve un pequeño micro-corte técnico. ¿Podrías escribirlo de nuevo?";
  }
}