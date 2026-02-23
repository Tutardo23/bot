import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getSession, updateSession } from "./memory.js";
import { enviarAChatwoot } from "./chatwoot.js";

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
   CONTROLADOR PRINCIPAL (Nivel 100 - Corregido)
========================================= */
export async function handleTestMessage(message) {
  const from = message.from;
  const text = message.text.body;

  // 🔥 PRIMERO OBTENEMOS SESSION 🔥
  const session = await getSession(from);

  // 🔥 ENVIAMOS A CHATWOOT CON SESSION 🔥
  await enviarAChatwoot(from, text, "incoming", session);

  if (session.status === "HANDOVER") return null;

  // Limpieza estricta de historial
  while (
    session.history &&
    session.history.length > 0 &&
    session.history[0].role === "model"
  ) {
    session.history.shift();
  }

  const fechaActual = new Date().toLocaleString("es-AR", {
    timeZone: "America/Argentina/Tucuman",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "numeric",
  });

  const infoColegio = getContextoActualizado();

  // 🔥 TU PROMPT ORIGINAL INTACTO 🔥
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
    1. 🗣️ **Tono Conversacional y Emojis:** Escribe como una persona real chateando por WhatsApp. Usa párrafos cortos y acompáñalos siempre con emojis estándar (👋, 🏫, ⏰, 🥪, 👕, 📝). ESTÁ TERMINANTEMENTE PROHIBIDO usar asteriscos (*) para poner texto en negrita.
    2. 🏁 **Saludo Inicial y Opciones:** Si el usuario te saluda, preséntate de forma cálida y ofrécele las consultas más comunes.
    Usa EXACTAMENTE este formato de saludo:
    "¡Hola! 👋 Soy Pucarito, el asistente del colegio. ¿En qué te puedo ayudar hoy? 🏫
    
    Podés consultarme sobre:
    💰 Cuotas y administración
    ⏰ Horarios de entrada y salida
    🥪 Menú del comedor
    👕 Uniforme reglamentario
    📝 Trámites y constancias
    
    Escribime tu consulta y te respondo al toque."
    
    3. 🚫 **Cero Saludos Repetitivos:** Si ya saludaste una vez, NO vuelvas a decir "Hola".
    4. 🤝 **Cortesía Básica:** Si el usuario es amable, responde igual.
    5. 🧠 **Respuestas Precisas:** Responde solo basado en tu "Cerebro".
    6. 🛡️ **Escudo Suave:** Si preguntan fuera de lugar, redirige amablemente a temas escolares.
    7. 🫂 **Memoria Amigable:** Recuerda el nombre del usuario si te lo dice.

    🚨 PROTOCOLO DE DERIVACIÓN (HANDOVER):
    Si el usuario tiene un problema complejo o pide hablar con un humano:
    - PASO 1: Pide nombre completo y del alumno.
    - PASO 2: Solo con esos datos, responde ÚNICAMENTE: ACTION_HANDOVER.
  `;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: {
        role: "system",
        parts: [{ text: promptMaestro }],
      },
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 500,
      },
    });

    const chat = model.startChat({
      history: session.history || [],
    });

    const result = await chat.sendMessage(text);
    const botResponse = result.response.text();

    // 🔥 RESPUESTA A CHATWOOT CON SESSION 🔥
    await enviarAChatwoot(from, botResponse, "outgoing", session);

    if (botResponse.includes("ACTION_HANDOVER")) {
      session.status = "HANDOVER";
      await updateSession(from, session);
      return "📞 ¡Gracias! Tus datos y toda nuestra charla ya fueron enviados a secretaría. En breve una persona te va a responder por este mismo medio.";
    }

    const rawHistory = await chat.getHistory();
    session.history = rawHistory.map((msg) => ({
      role: msg.role,
      parts: [{ text: msg.parts[0].text }],
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
      return "Disculpá, se me reseteó la conexión. ¿Me repetirías lo último? 😅";
    }

    return "Tuve un pequeño micro-corte técnico. ¿Podrías escribirlo de nuevo?";
  }
}