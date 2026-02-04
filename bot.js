import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { getSession, updateSession } from "./memory.js";

dotenv.config();

// Inicializamos cliente
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* =========================================
   CARGADOR DE INFORMACIÓN
========================================= */
function getContextoActualizado() {
  try {
    // Usamos process.cwd() para encontrar el archivo donde sea que estemos
    const filePath = path.join(process.cwd(), "datos_colegio.txt");
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    console.error("Error leyendo datos_colegio.txt:", error);
    return "No hay información disponible por el momento.";
  }
}

/* =========================================
   CONTROLADOR PRINCIPAL (Con Menú)
========================================= */
export async function handleTestMessage(message) {
  const from = message.from;
  const text = message.text.body;
  const session = getSession(from);

  if (session.status === "HANDOVER") return null;

  // 1. Limpieza de historial para evitar errores de Gemini
  while (session.history.length > 0 && session.history[0].role === "model") {
    session.history.shift();
  }

  // 2. Datos dinámicos
  const fechaActual = new Date().toLocaleString("es-AR", { 
    timeZone: "America/Argentina/Tucuman", 
    weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: 'numeric' 
  });

  const infoColegio = getContextoActualizado();

  // 3. Prompt Maestro (CON MENÚ INTEGRADO)
  const promptMaestro = `
    INSTRUCCIÓN DE SEGURIDAD MÁXIMA:
    Eres "Pucarito", el asistente virtual del Colegio.
    Tu conocimiento se limita EXCLUSIVAMENTE a la información provista abajo.
    
    INFORMACIÓN PERMITIDA (TU FUENTE DE VERDAD):
    """
    ${infoColegio}
    """

    CONTEXTO ACTUAL:
    - Hoy es: ${fechaActual}.

    DISEÑO DEL MENÚ DE OPCIONES:
    Cuando debas mostrar el menú, usa ESTE formato exacto:
    """
    🏫 *Menú de Opciones - Colegio Pucará*
    
    1️⃣ *Administración y Pagos* (Cuotas, CBU, Vencimientos)
    2️⃣ *Horarios y Clases* (Entradas, Salidas, Tardanzas)
    3️⃣ *Comedor y Kiosco* (Menú del día, Precios)
    4️⃣ *Uniformes* (Reglamento y dónde comprar)
    5️⃣ *Trámites* (Constancias, Pases, Inscripciones)
    
    ✍️ *Escribí tu consulta o el tema que te interese.*
    """

    REGLAS DE RESPUESTA:
    1. 🏁 **Saludo/Ayuda:** Si el usuario saluda ("Hola", "Buenas") o pide "Menú/Ayuda", preséntate brevemente y MUESTRA EL MENÚ diseñado arriba.
    2. 🧠 **Consultas:** Si pregunta algo específico (ej: "qué se come hoy"), responde DIRECTAMENTE la información sin mostrar el menú completo, salvo que sea necesario.
    3. 🚫 **Fuera de tema:** Si la respuesta NO está en el texto (ej: "¿Quién ganó el partido?"), di: "Disculpá, solo tengo información oficial del colegio. 🏫".
    4. 📞 **Humano:** Si piden hablar con alguien real, responde SOLO: "ACTION_HANDOVER".
  `;

  try {
    const model = genAI.getGenerativeModel({ 
        model: "gemini-2.5-flash", 
        systemInstruction: {
            role: "system",
            parts: [{ text: promptMaestro }]
        },
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 500, // Aumenté un poco para que quepa el menú
        }
    });

    const chat = model.startChat({
      history: session.history,
    });

    const result = await chat.sendMessage(text);
    const botResponse = result.response.text();

    if (botResponse.includes("ACTION_HANDOVER")) {
      session.status = "HANDOVER";
      updateSession(from, session);
      return "📞 Entendido. Te derivo con secretaría.";
    }

    session.history.push({ role: "user", parts: [{ text: text }] });
    session.history.push({ role: "model", parts: [{ text: botResponse }] });

    if (session.history.length > 10) {
      session.history = session.history.slice(-10);
    }

    updateSession(from, session);
    
    return botResponse;

  } catch (error) {
    console.error("Error IA:", error);
    // Reset de emergencia si se rompe la memoria
    if (error.message && error.message.includes("role 'user'")) {
        session.history = [];
        updateSession(from, session);
        return "Tuve un error de memoria. Por favor, saludame de nuevo.";
    }
    return "Tuve un pequeño error técnico. ¿Podrías repetir?";
  }
}