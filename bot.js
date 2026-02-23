import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getSession, updateSession } from "./memory.js";
import { enviarAChatwoot } from "./chatwoot.js";
import { asignarAHumano } from "./chatwoot.js";
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
  
  // 🔥 MANDA EL MENSAJE DEL PADRE A CHATWOOT 🔥
  enviarAChatwoot(from, text, "incoming");

  // 1️⃣ PRIMER AWAIT: Buscamos la memoria en la nube de Vercel/Upstash
  const session = await getSession(from);

  if (session.status === "HANDOVER") {
  console.log("Conversación en modo humano.");
  return null;
}

  // Limpieza estricta de historial para evitar el error del primer rol
  while (session.history && session.history.length > 0 && session.history[0].role === "model") {
    session.history.shift();
  }

  // 🔥 ACÁ ESTÁN LAS VARIABLES QUE SE HABÍAN BORRADO 🔥
  const fechaActual = new Date().toLocaleString("es-AR", { 
    timeZone: "America/Argentina/Tucuman", 
    weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: 'numeric' 
  });

  const infoColegio = getContextoActualizado();

  // 🔥 PROMPT MAESTRO "MODO HUMANO CON EMOJIS" 🔥
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
    1. 🗣️ **Tono Conversacional y Emojis:** Escribe como una persona real chateando por WhatsApp. Usa párrafos cortos y acompáñalos siempre con emojis estándar (👋, 🏫, ⏰, 🥪, 👕, 📝) para que el texto sea visual y amigable. ESTÁ TERMINANTEMENTE PROHIBIDO usar asteriscos (*) para poner texto en negrita.
    2. 🏁 **Saludo Inicial y Opciones:** Si el usuario te saluda, preséntate de forma cálida y ofrécele las consultas más comunes usando emojis como viñetas. 
    Usa EXACTAMENTE este formato de saludo:
    "¡Hola! 👋 Soy Pucarito, el asistente del colegio. ¿En qué te puedo ayudar hoy? 🏫
    
    Podés consultarme sobre:
    💰 Cuotas y administración
    ⏰ Horarios de entrada y salida
    🥪 Menú del comedor
    👕 Uniforme reglamentario
    📝 Trámites y constancias
    
    Escribime tu consulta y te respondo al toque."
    
    3. 🚫 **Cero Saludos Repetitivos:** Si ya saludaste una vez, NO vuelvas a decir "Hola" en los siguientes mensajes. Ve directo a la respuesta.
    4. 🤝 **Cortesía Básica:** Si el usuario dice "Gracias", "Todo bien", o manda un emoji, responde con amabilidad (ej: "¡De nada! 😊", "¡Qué bueno! 🙌") y no uses el escudo protector.
    5. 🧠 **Respuestas Precisas:** Responde solo basado en tu "Cerebro". Nunca inventes fechas, precios ni reglas.
    6. 🛡️ **Escudo Suave:** Si te preguntan cosas fuera de lugar, responde amablemente: "Disculpá, pero solo estoy acá para ayudarte con información del colegio. 🏫 ¿Necesitás saber algo de la escuela?"
    7. 🫂 **Memoria Amigable:** Si el usuario te dice su nombre, recuérdalo y úsalo. Si te pregunta su nombre u otros detalles que ya conversaron, respóndele basándote en el historial de la charla, no apliques el Escudo Suave en esos casos.

    🚨 PROTOCOLO DE DERIVACIÓN (HANDOVER):
    Si el usuario tiene un problema complejo, está enojado, o pide hablar con un humano:
    - PASO 1: NO lo derives inmediatamente. Dile: "Entiendo. 🤝 Para que en secretaría te puedan ayudar más rápido, ¿me dirías tu nombre completo y el del alumno por favor?".
    - PASO 2: Solo cuando el usuario te dé esos datos, TU ÚNICA RESPUESTA DEBE SER EXACTAMENTE ESTA PALABRA: ACTION_HANDOVER.
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

    // Iniciamos el chat pasándole el historial guardado
    const chat = model.startChat({
      history: session.history || [],
    });

    // Le mandamos el mensaje a la IA
    const result = await chat.sendMessage(text);
    const botResponse = result.response.text();

    // 🔥 MANDA LA RESPUESTA DE LA IA A CHATWOOT 🔥
    enviarAChatwoot(from, botResponse, "outgoing");

    // 🎯 CAPTURADOR DE DERIVACIÓN
    if (botResponse.includes("ACTION_HANDOVER")) {
  session.status = "HANDOVER";
  await updateSession(from, session);

  await asignarAHumano(from);

  return "📞 ¡Gracias! Tus datos y toda nuestra charla ya fueron enviados a secretaría. En breve una persona te va a responder por este mismo medio.";
}

    // 🔥 EL ARREGLO ESTÁ ACÁ 🔥
    // Pedimos el historial oficial de Gemini y lo guardamos bien estructurado
    const rawHistory = await chat.getHistory();
    
    session.history = rawHistory.map(msg => ({
        role: msg.role,
        parts: [{ text: msg.parts[0].text }]
    }));

    // Limitamos el historial a los últimos 14 mensajes para no gastar tokens de más
    if (session.history.length > 14) {
      session.history = session.history.slice(-14);
    }

    // 3️⃣ TERCER AWAIT: Guardamos el historial limpio en la nube
    await updateSession(from, session);
    
    return botResponse;

  } catch (error) {
    console.error("Error IA:", error);
    if (error.message && error.message.includes("role 'user'")) {
        session.history = [];
        // 4️⃣ CUARTO AWAIT: Guardamos el historial reseteado por error en la nube
        await updateSession(from, session);
        return "Disculpá, se me reseteó la conexión. ¿Me repetirías lo último? 😅";
    }
    return "Tuve un pequeño micro-corte técnico. ¿Podrías escribirlo de nuevo?";
  }
}