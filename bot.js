import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getSession, updateSession } from "./memory.js";
import { enviarAChatwoot, asignarAHumano } from "./chatwoot.js";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Cuántos minutos de inactividad para reactivar el bot tras un handover
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
   Elimina asteriscos de respuestas viejas para que Gemini no las imite
========================================= */
function limpiarHistorial(history) {
  return history.map(msg => ({
    ...msg,
    parts: msg.parts.map(part => ({
      ...part,
      text: part.text
        .replace(/\*\*(.*?)\*\*/g, "$1") // Elimina **negrita**
        .replace(/\*(.*?)\*/g, "$1")     // Elimina *cursiva*
    }))
  }));
}

/* =========================================
   CONTROLADOR PRINCIPAL
========================================= */
export async function handleTestMessage(message) {
  const from = message.from;
  const text = message.text.body;

  // 1️⃣ Buscamos la sesión
  let session = await getSession(from);

  // 2️⃣ Si estaba en HANDOVER, chequeamos si pasaron las X horas para reactivar el bot
  if (session.status === "HANDOVER") {
    const minutosDesdeUltimoMensaje = (Date.now() - session.lastSeen) / 1000 / 60;
    
    if (minutosDesdeUltimoMensaje >= HANDOVER_RESET_MINUTES) {
      // Pasaron las horas → reseteamos la sesión para que el bot retome
      console.log(`🔄 Reactivando bot para ${from} después de ${Math.round(minutosDesdeUltimoMensaje)} minutos.`);
      session = {
        status: "ACTIVE",
        greeted: false,
        lastIntent: null,
        history: [],
        tempData: {},
        turns: 0,
        lastSeen: Date.now(),
        isReturningUser: true
      };
    } else {
      // Sigue en handover → el bot permanece en silencio
      await enviarAChatwoot(from, text, "incoming");
      // Actualizamos lastSeen para que el agente humano vea el mensaje
      await updateSession(from, session);
      return null;
    }
  }

  // 3️⃣ Mandamos el mensaje entrante a Chatwoot
  await enviarAChatwoot(from, text, "incoming");

  // Limpieza: el historial no puede empezar con un mensaje del modelo
  while (session.history && session.history.length > 0 && session.history[0].role === "model") {
    session.history.shift();
  }

  const fechaActual = new Date().toLocaleString("es-AR", {
    timeZone: "America/Argentina/Tucuman",
    weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "numeric"
  });

  const infoColegio = getContextoActualizado();

  const promptMaestro = `
    INSTRUCCIÓN DE SISTEMA:
    Eres "Pucarito", el Asistente Virtual Oficial del Colegio Pucará.

    📚 TU CEREBRO (FUENTE DE VERDAD ABSOLUTA):
    """
    ${infoColegio}
    """

    ⏰ CONTEXTO EN TIEMPO REAL:
    - Fecha y hora actual: ${fechaActual}.
    - ¿Ya saludaste en esta sesión?: ${session.greeted ? "SÍ, ya saludaste. NO vuelvas a presentarte." : "NO, es el primer mensaje. Saluda y preséntate."}

    💎 REGLAS DE ORO DE COMPORTAMIENTO (MODO WHATSAPP):
    1. 🗣️ Tono Conversacional y Emojis: Escribe de forma cálida y profesional. Usa párrafos cortos y emojis (🏫, ⏰, 📝, 💻, ✅, 🎓).
    2. 🚫 ESTÁ TERMINANTEMENTE PROHIBIDO usar asteriscos (*) para poner texto en negrita. NUNCA uses **texto** ni *texto*.
    3. 🏁 SALUDO INICIAL CON MENÚ: Si el campo "¿Ya saludaste?" dice NO, SIEMPRE saludá, presentate y mostrá este menú de consultas comunes exactamente así (sin asteriscos):

       "¡Hola! 👋 Soy Pucarito, el asistente virtual del Colegio Pucará 🏫
       
       ¿En qué te puedo ayudar hoy? Estas son las consultas más frecuentes:
       
       💰 Cuotas y pagos
       ⏰ Horarios y entradas
       🍽️ Comedor del día
       👕 Uniforme reglamentario
       📜 Trámites (constancias, pases)
       💻 Problemas con Colegium o Classroom
       
       Escribí tu consulta o elegí un tema 👇"
       
       Si el campo "¿Ya saludaste?" dice SÍ, ve directo al grano sin saludar ni mostrar el menú.
    4. 🆕 CREACIÓN DE CUENTAS NUEVAS: Si el usuario pide explícitamente CREAR una cuenta nueva, dile:
       "Entiendo. 🤝 Para que desde secretaría puedan generarte la cuenta nueva, ¿me pasarías tu nombre completo y tu DNI por favor? 📝"
       Una vez que te respondan con esos datos, tu única respuesta debe ser exactamente: ACTION_HANDOVER
    5. 🕵️‍♀️ DIAGNÓSTICO TÉCNICO: Si te dicen "Me olvidé la contraseña", "No me anda la cuenta" o similar, NO derives todavía. Investigá primero siguiendo los pasos del manual.
    6. 🛡️ Escudo Suave: Si preguntan cosas fuera del colegio, decí que solo sabés de temas de la escuela.
    7. 🫂 Memoria: Usá el nombre del usuario si te lo dijo.

    🚨 PROTOCOLO DE DERIVACIÓN (HANDOVER):
    SOLO derivás en estos tres casos:
    1) Quieren crear una cuenta nueva y ya te dieron nombre y DNI.
    2) Ya hiciste el diagnóstico técnico completo y no se solucionó, y el usuario ya te dio su nombre y el del alumno.
    3) Piden explícitamente hablar con un humano y ya te dieron su nombre y el del alumno.

    - PASO 1 (si no es creación de cuenta): Decí: "Entiendo. 🤝 Para que en soporte técnico puedan revisar tu caso, ¿me dirías tu nombre completo y el del alumno?"
    - PASO 2: Cuando te den los datos, TU ÚNICA RESPUESTA DEBE SER EXACTAMENTE ESTO (nada más, nada menos): ACTION_HANDOVER
  `;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: { role: "system", parts: [{ text: promptMaestro }] },
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 2000
      }
    });

    // Limpiamos el historial de asteriscos antes de mandárselo a Gemini
    const historialLimpio = limpiarHistorial(session.history || []);

    const chat = model.startChat({ history: historialLimpio });
    const result = await chat.sendMessage(text);
    const botResponse = result.response.text().trim();

    // 🎯 CAPTURADOR DE HANDOVER — ANTES de mandar nada al usuario
    if (botResponse.includes("ACTION_HANDOVER")) {
      session.status = "HANDOVER";
      await updateSession(from, session);

      // Mensaje amigable que sí le llega al usuario
      const mensajeHandover = "📞 ¡Listo! Tus datos ya fueron enviados al equipo. En breve una persona te va a responder por este mismo medio. 😊";
      await enviarAChatwoot(from, mensajeHandover, "outgoing");

      // 🔑 Asignamos la conversación al agente y la marcamos como pendiente en Chatwoot
      await asignarAHumano(from);

      return mensajeHandover;
    }

    // 4️⃣ Mandamos la respuesta normal a Chatwoot
    await enviarAChatwoot(from, botResponse, "outgoing");

    // Marcamos que ya saludamos
    session.greeted = true;

    // Guardamos historial (limpio, sin asteriscos)
    const rawHistory = await chat.getHistory();
    session.history = rawHistory.map(msg => ({
      role: msg.role,
      parts: [{ text: msg.parts[0].text.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*(.*?)\*/g, "$1") }]
    }));

    // Máximo 14 turnos en memoria
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