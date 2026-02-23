import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getSession, updateSession } from "./memory.js";
import { enviarAChatwoot } from "./chatwoot.js";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function getContextoActualizado() {
  try {
    const filePath = path.join(process.cwd(), "datos_colegio.txt");
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    console.error("Error leyendo datos_colegio.txt:", error);
    return "No hay información disponible por el momento.";
  }
}

export async function handleTestMessage(message) {
  const from = message.from;
  const text = message.text.body;

  // 1️⃣ BUSCAMOS LA SESIÓN PRIMERO (Para tener el ID de charla si ya existe)
  const session = await getSession(from);

  // 2️⃣ MANDAMOS A CHATWOOT (Pasando la session para evitar duplicados)
  await enviarAChatwoot(from, text, "incoming", session);

  if (session.status === "HANDOVER") return null;

  // Limpieza de historial para Gemini
  while (session.history && session.history.length > 0 && session.history[0].role === "model") {
    session.history.shift();
  }

  const fechaActual = new Date().toLocaleString("es-AR", { 
    timeZone: "America/Argentina/Tucuman", 
    weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: 'numeric' 
  });

  const infoColegio = getContextoActualizado();

  // 🔥 EL PROMPT MAESTRO (Tal cual lo definimos para Pucarito) 🔥
  const promptMaestro = `
    Eres "Pucarito", el Asistente Virtual Oficial del Colegio Pucará.

    📚 TU CEREBRO (FUENTE DE VERDAD):
    """ ${infoColegio} """

    ⏰ CONTEXTO ACTUAL: ${fechaActual}.

    💎 REGLAS DE ORO DE COMPORTAMIENTO:
    1. 🗣️ Tono WhatsApp: Escribe de forma cálida y humana. Usa párrafos cortos y emojis (👋, 🏫, ⏰, 🥪).
    2. 🚫 PROHIBIDO EL USO DE ASTERISCOS: No uses asteriscos (*) para poner texto en negrita bajo ninguna circunstancia.
    3. 🏁 Saludo Inicial: Si el usuario saluda, usa este formato:
       "¡Hola! 👋 Soy Pucarito, el asistente del colegio. ¿En qué te puedo ayudar hoy? 🏫
       Podés consultarme sobre:
       💰 Cuotas y administración
       ⏰ Horarios de entrada y salida
       🥪 Menú del comedor
       👕 Uniforme reglamentario
       📝 Trámites y constancias"
    4. 🚫 No repitas el saludo si la conversación ya empezó.
    5. 🛡️ Escudo Suave: Si preguntan algo ajeno al colegio, di: "Disculpá, solo puedo ayudarte con info del colegio. 🏫 ¿Necesitás saber algo más?"
    6. 🫂 Memoria: Usa el nombre del usuario si te lo dice.

    🚨 PROTOCOLO DE DERIVACIÓN (HANDOVER):
    Si el usuario está enojado o pide hablar con una persona:
    - PASO 1: Di: "Entiendo. 🤝 Para que en secretaría te ayuden mejor, ¿me dirías tu nombre completo y el del alumno?"
    - PASO 2: Solo cuando te dé los datos, responde ÚNICAMENTE: ACTION_HANDOVER.
  `;

  try {
    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.5-flash", 
        systemInstruction: { role: "system", parts: [{ text: promptMaestro }] },
        generationConfig: { temperature: 0.15, maxOutputTokens: 500 }
    });

    const chat = model.startChat({ history: session.history || [] });
    const result = await chat.sendMessage(text);
    const botResponse = result.response.text();

    // 3️⃣ MANDAMOS LA RESPUESTA DE LA IA A CHATWOOT
    await enviarAChatwoot(from, botResponse, "outgoing", session);

    if (botResponse.includes("ACTION_HANDOVER")) {
      session.status = "HANDOVER";
      await updateSession(from, session);
      return "📞 ¡Gracias! Tus datos ya fueron enviados a secretaría. En breve te responderán por acá.";
    }

    // Guardamos historial
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
    console.error("❌ Error IA:", error);
    return "Tuve un pequeño micro-corte técnico. ¿Me lo repetís? 😅";
  }
}