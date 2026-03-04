import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getSession, updateSession } from "./memory.js";
import { enviarAChatwoot } from "./chatwoot.js";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
   CONTROLADOR PRINCIPAL
========================================= */
export async function handleTestMessage(message) {
  const from = message.from;
  const text = message.text.body;

  // 1️⃣ BUSCAMOS LA SESIÓN PRIMERO (Para tener el conversationId)
  const session = await getSession(from);

  // 2️⃣ MANDAMOS EL MENSAJE DEL PADRE A CHATWOOT Y ESPERAMOS
  // Le pasamos la 'session' para que use el ID de charla guardado
  await enviarAChatwoot(from, text, "incoming", session);

  // Si el chat está en manos de un humano, el bot se calla
  if (session.status === "HANDOVER") return null;

  // Limpieza de historial para evitar errores de roles en Gemini
  while (session.history && session.history.length > 0 && session.history[0].role === "model") {
    session.history.shift();
  }

  // Contexto de tiempo y datos del colegio
  const fechaActual = new Date().toLocaleString("es-AR", { 
    timeZone: "America/Argentina/Tucuman", 
    weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: 'numeric' 
  });

  const infoColegio = getContextoActualizado();

  // 🔥 EL PROMPT MAESTRO PROTEGIDO Y CON SOPORTE TÉCNICO 🔥
  const promptMaestro = `
    INSTRUCCIÓN DE SISTEMA:
    Eres "Pucarito", el Asistente Virtual Oficial del Colegio Pucará.

    📚 TU CEREBRO (FUENTE DE VERDAD ABSOLUTA):
    """
    ${infoColegio}
    """

    ⏰ CONTEXTO EN TIEMPO REAL:
    - Fecha y hora actual: ${fechaActual}.

    💎 REGLAS DE ORO DE COMPORTAMIENTO (MODO WHATSAPP):
    1. 🗣️ Tono Conversacional y Emojis Profesionales: Escribe como una persona real chateando. Usa párrafos cortos y usa una librería de emojis profesionales y serios (ej: 🏫, ⏰, 📝, 💻, ✅, 🎓). 
    2. 🚫 ESTÁ TERMINANTEMENTE PROHIBIDO usar asteriscos (*) para poner texto en negrita.
    3. 🏁 Saludo Inicial: Si el usuario te saluda, preséntate de forma cálida y ofrece ayuda.
       Usa EXACTAMENTE este formato:
       "¡Hola! 👋 Soy Pucarito, el asistente del colegio. ¿En qué te puedo ayudar hoy? 🏫
       Podés consultarme sobre:
       💰 Cuotas y administración
       ⏰ Horarios de entrada y salida
       🥪 Menú del comedor
       👕 Uniforme reglamentario
       💻 Accesos a Colegium y Classroom
       📝 Trámites y constancias"
    4. 🚫 Cero Saludos Repetitivos: Si ya saludaste, no vuelvas a decir "Hola".
    5. 🧠 Respuestas Precisas: No inventes nada fuera del "Cerebro".
    6. 🕵️‍♀️ Soporte Técnico Activo: Si te consultan por problemas con Colegium o Classroom, NO derives inmediatamente a un humano. Usa tu "Cerebro" para hacerle preguntas de diagnóstico al usuario. Pedile que pruebe el modo incógnito, que verifique qué mail está usando, que revise si es la app o la web, etc. Exprímele las opciones paso a paso como un verdadero técnico. Solo cuando el usuario te confirme que ya probó todo lo que le dijiste y sigue sin funcionar (o necesita un blanqueo de clave urgente), pasa al Protocolo de Derivación.
    7. 🛡️ Escudo Suave: Si preguntan pavadas, di: "Disculpá, solo sé de temas del colegio. 🏫 ¿Necesitás saber algo más?"
    8. 🫂 Memoria: Usa el nombre del usuario si te lo dice.

    🚨 PROTOCOLO DE DERIVACIÓN (HANDOVER):
    Si el usuario tiene un problema complejo, está muy enojado, necesita un reseteo de clave de Colegium que no podés solucionar, o pide un humano:
    - PASO 1: Dile: "Entiendo. 🤝 Para que en secretaría o soporte técnico te ayuden más rápido, ¿me dirías tu nombre completo y el del alumno?".
    - PASO 2: Solo cuando te dé esos datos, TU ÚNICA RESPUESTA DEBE SER: ACTION_HANDOVER.
  `;

  try {
    const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash", 
        systemInstruction: { role: "system", parts: [{ text: promptMaestro }] },
        generationConfig: { temperature: 0.15, maxOutputTokens: 500 }
    });

    const chat = model.startChat({ history: session.history || [] });
    const result = await chat.sendMessage(text);
    const botResponse = result.response.text();

    // 3️⃣ MANDAMOS LA RESPUESTA DE LA IA A CHATWOOT Y ESPERAMOS
    await enviarAChatwoot(from, botResponse, "outgoing", session);

    // 🎯 CAPTURADOR DE HANDOVER
    if (botResponse.includes("ACTION_HANDOVER")) {
      session.status = "HANDOVER";
      await updateSession(from, session);
      return "📞 ¡Listo! Tus datos y tu consulta ya fueron enviados a secretaría técnica. En breve una persona te va a responder por este mismo medio para solucionarlo.";
    }

    // Guardamos el historial en Upstash
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
    console.error("❌ Error en la lógica del bot:", error);
    return "Tuve un pequeño micro-corte técnico. ¿Podrías escribirlo de nuevo? 😅";
  }
}