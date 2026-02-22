import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getSession, updateSession } from "./memory.js";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* =========================================
   CARGADOR DE INFORMACIÓN
========================================= */
function getContextoActualizado() {
  try {
    const filePath = path.join(process.cwd(), "datos_colegio.txt");
    return fs.readFileSync(filePath, "utf-8"); // Leer archivos fijos sí funciona en Vercel
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
  
  // 1️⃣ PRIMER AWAIT: Buscamos la memoria en la nube de Vercel/Upstash
  const session = await getSession(from);

  if (session.status === "HANDOVER") return null;

  // Limpieza estricta de historial
  while (session.history.length > 0 && session.history[0].role === "model") {
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

    const chat = model.startChat({
      history: session.history,
    });

    const result = await chat.sendMessage(text);
    const botResponse = result.response.text();

    // 🎯 CAPTURADOR DE DERIVACIÓN
    if (botResponse.includes("ACTION_HANDOVER")) {
      session.status = "HANDOVER";
      // 2️⃣ SEGUNDO AWAIT: Guardamos el estado de Handover en la nube
      await updateSession(from, session);
      return "📞 ¡Gracias! Tus datos y toda nuestra charla ya fueron enviados a secretaría. En breve una persona te va a responder por este mismo medio.";
    }

    session.history.push({ role: "user", parts: [{ text: text }] });
    session.history.push({ role: "model", parts: [{ text: botResponse }] });

    if (session.history.length > 14) {
      session.history = session.history.slice(-14);
    }

    // 3️⃣ TERCER AWAIT: Guardamos el historial de la charla en la nube
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