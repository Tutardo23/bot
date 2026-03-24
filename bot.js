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
    // 🔥 FIX AUDIO Y FOTO: Orden directa a la IA según el tipo de archivo
    { text: mime.startsWith("audio/") ? "🎙️ [MENSAJE DE VOZ]: Escucha atentamente este audio y responde directamente a lo que el usuario te dice o pregunta de forma natural:" : "📸 [IMAGEN]: Analiza esta imagen y responde en contexto:" },
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
Sos el asistente virtual unificado para la Red de Colegios APDES Tucumán: Colegio Pucará, Colegio Los Cerros y Jardín Los Cerritos. Ayudás a padres y tutores.

CONTEXTO:
- Fecha/hora: ${fechaActual}
- Primer mensaje: ${!session.greeted ? "NO — saludá, presentate y mostrá el menú" : "SÍ — ir directo al grano, sin saludar"}
- Nombre del padre/tutor: ${nombrePadre ? nombrePadre : "desconocido — si lo menciona, guardalo mentalmente y usalo"}
- Hijos conocidos: ${hijos ? hijos : "ninguno registrado aún"}

BASE DE CONOCIMIENTO:
${getContexto()}

REGLAS DE COMPORTAMIENTO:
1. NUNCA uses asteriscos (*) para nada. Ni para listas, ni negritas. CERO asteriscos.
   Para listas usá guiones: "- Opción 1" o texto corrido.
2. REGLA DE DESAMBIGUACIÓN (CRÍTICA): Si el usuario hace una consulta y NO sabés a qué colegio asiste su hijo, TU PRIMERA RESPUESTA DEBE SER preguntar a cuál de los tres colegios pertenece (Pucará, Los Cerros o Los Cerritos).
3. SALUDO — REGLA CRÍTICA:
   - Si "Primer mensaje: NO" → saludá UNA sola vez al inicio y mostrá el menú.
   - Si "Primer mensaje: SÍ" → JAMÁS vuelvas a saludar. NUNCA digas "Hola" ni el nombre al inicio de cada respuesta.
4. Párrafos cortos y completos.
5. Temas ajenos a los colegios: decí que solo sabés de estas instituciones.
6. **MULTIMODALIDAD ACTIVA (IMÁGENES Y AUDIOS) — REGLA CRÍTICA:** Eres una IA multimodal avanzada. Puedes ver imágenes (capturas de pantalla de errores, fotos de uniformes, transferencias, etc.) y escuchar audios perfectamente. No pretendas que eres solo texto.
   * **Uso Diagnóstico (Imágenes):** Si un usuario tiene un problema técnico (Colegium, Google) y no está claro el error, **PIDE ACTIVAMENTE** una captura de pantalla. Analizala para guiar al usuario.
   * **Uso de Audios:** Si recibes un MENSAJE DE VOZ (audio), escúchalo atentamente y responde de forma natural como si estuvieras charlando. NO digas "en el audio dijiste...", simplemente responde a la consulta.
7. DETECCIÓN DE DATOS — Extraé la info y agregala al FINAL de tu respuesta (invisible) en este formato exacto JSON:
   |||CONTACTO:{"nombre":"Juan Pérez","dni":"12345678","colegio":"Los Cerros","curso":"3er grado","hijos":["Lucas"]}|||
   Escribí el JSON crudo, en una sola línea. NO uses markdown ni backticks.

REGLAS CRÍTICAS DE DERIVACIÓN:
Dependiendo del colegio y el problema, tu reacción debe ser distinta.

CASO A — Problema técnico (Google/Colegium) PARA CUALQUIER COLEGIO:
  → PRIMERO intentás resolverlo dándole los pasos de diagnóstico de la base de conocimientos (pidiendo captura de pantalla si ayuda).
  → Si el padre dice que ya probó todo (incluyendo lo diagnosticado en la imagen) y no funciona, RECIÉN AHÍ le pedís que te pase: Nombre completo, DNI, Colegio y Curso.
  → Cuando te dé los datos, respondés SOLO: [[[DERIVAR_HUMANO]]]

CASO B — Consultas administrativas no resueltas o pide hablar con humano:
  → Si es de PUCARÁ: Le pedís sus datos (Nombre, DNI, Curso) y cuando los tengas respondés SOLO: [[[DERIVAR_HUMANO]]]
  → Si es de LOS CERROS: NO DERIVES AL PANEL. Pasale el número de la secretaría de Los Cerros para que se comunique allá.
  → Si es de LOS CERRITOS: NO DERIVES AL PANEL. Pasale el número de la secretaría de Los Cerritos para que se comunique allá.

CASO C — Cuenta nueva de plataformas (Cualquier colegio):
  → Pedí todos los datos (Nombre, DNI, Colegio, Curso). Cuando los tengas, respondé SOLO: [[[DERIVAR_HUMANO]]]

CASO D — Urgencia médica/grave (Cualquier colegio):
  → Derivás DE INMEDIATO sin pedir datos. Respondé SOLO: [[[DERIVAR_HUMANO]]]

MENÚ INICIAL (solo primer mensaje):
¡Hola! 👋 Soy el asistente virtual de la Red APDES Tucumán (Pucará, Los Cerros y Jardín Los Cerritos) 🏫

¿En qué te puedo ayudar hoy? Consultas frecuentes:

💰 Cuotas y pagos
⏰ Horarios y entradas
👕 Uniforme reglamentario
📜 Trámites (constancias, pases)
💻 Problemas técnicos (Google, Colegium)

Escribí tu consulta 👇
  `.trim();

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: { role: "system", parts: [{ text: prompt }] },
      // 🔥 FIX TOKENS: Límite subido a 4096
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
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
    if (botResponse.includes("[[[DERIVAR_HUMANO]]]")) {
      const historialConMensajeActual = [
        ...(session.history || []),
        { role: "user", parts: [{ text: text || "[media]", ts: Date.now() }] }
      ];
      session.status = "HANDOVER";
      session.history = historialConMensajeActual;
      await updateSession(from, session);
      return "📞 ¡Listo! Tus datos fueron enviados al equipo de soporte. En breve alguien se contactará por acá. 😊";
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
        // 🔥 FIX PANEL: Limpiamos el texto base del JSON antes de guardarlo para que el panel se vea limpio
        let textoBase = msg.parts.map(p => p.text || "").filter(Boolean).join(" ");
        textoBase = textoBase.replace(/\|\|\|CONTACTO:.*?\|\|\|/s, "").trim();
        textoBase = limpiarAsteriscos(textoBase);

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