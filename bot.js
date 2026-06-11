import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  getSession,
  updateSession,
  getContacto,
  updateContacto,
  saveMedia,
  getConfig,
} from "./memory.js";

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

function readFileSafe(filename) {
  try {
    return fs.readFileSync(path.join(process.cwd(), filename), "utf-8");
  } catch {
    return "";
  }
}

function cleanVisibleText(text) {
  return String(text || "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/\|\|\|CONTACTO:.*?\|\|\|/gs, "")
    .replace(/\[\[\[DERIVAR_HUMANO\]\]\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function cleanForStorage(text, max = 5000) {
  return String(text || "")
    .replace(/\u0000/g, "")
    .replace(/\|\|\|CONTACTO:.*?\|\|\|/gs, "")
    .replace(/\[\[\[DERIVAR_HUMANO\]\]\]/g, "")
    .trim()
    .slice(0, max);
}

function isGreetingOnly(text) {
  const t = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return [
    "hola",
    "buenas",
    "buen dia",
    "buenos dias",
    "buenas tardes",
    "buenas noches",
    "hello",
    "holaa",
    "hola buenas",
  ].includes(t);
}

function buildKnowledge(config) {
  const fileKnowledge = readFileSafe("datos_colegio.txt").trim();
  const panelKnowledge = String(config.baseConocimiento || "").trim();

  return [
    panelKnowledge ? `BASE EDITABLE DEL PANEL:\n${panelKnowledge}` : "",
    fileKnowledge ? `BASE DEL ARCHIVO datos_colegio.txt:\n${fileKnowledge}` : "",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n")
    .trim() || "No hay base de conocimiento cargada.";
}

function limpiarHistorial(history = [], max = 14) {
  const cleaned = history
    .filter((msg) => msg?.role === "user" || msg?.role === "model")
    .map((msg) => ({
      role: msg.role,
      parts: (Array.isArray(msg.parts) ? msg.parts : [])
        .map((part) => {
          const out = {};
          if (part?.text) out.text = cleanVisibleText(part.text);
          if (part?.inlineData?.mimeType && part?.inlineData?.data) {
            out.inlineData = {
              mimeType: part.inlineData.mimeType,
              data: part.inlineData.data,
            };
          }
          if (!out.text && !out.inlineData) out.text = " ";
          return out;
        })
        .slice(0, 4),
    }))
    .filter((msg) => msg.parts.length);

  // Gemini exige que el primer mensaje del historial sea "user".
  // Redis puede traer conversaciones viejas que arrancan con "model".
  const normalized = [];

  for (const msg of cleaned) {
    if (!normalized.length && msg.role !== "user") continue;

    const last = normalized[normalized.length - 1];

    // Evita roles consecutivos iguales. Gemini puede rechazar esos historiales.
    if (last && last.role === msg.role) {
      last.parts.push(...msg.parts);
      last.parts = last.parts.slice(-6);
    } else {
      normalized.push(msg);
    }
  }

  const recent = normalized.slice(-max);

  while (recent.length && recent[0].role !== "user") {
    recent.shift();
  }

  return recent;
}

function buildParts(text, mediaData) {
  const cleanText = String(text || "").trim();

  if (!mediaData) return [{ text: cleanText || " " }];

  const mime = String(mediaData.mimeType || "application/octet-stream").split(";")[0].trim();

  if (mime.startsWith("audio/")) {
    return [
      {
        text:
          "MENSAJE DE VOZ: escuchá atentamente el audio y respondé directamente la consulta del padre/madre. No digas que no podés escuchar audio.",
      },
      { inlineData: { mimeType: mime, data: mediaData.base64 } },
      ...(cleanText ? [{ text: cleanText }] : []),
    ];
  }

  if (mime.startsWith("image/")) {
    return [
      {
        text:
          "IMAGEN O CAPTURA: analizá visualmente la imagen. Si es un error de Colegium, Google o pago, usala para diagnosticar y orientar con pasos claros.",
      },
      { inlineData: { mimeType: mime, data: mediaData.base64 } },
      ...(cleanText ? [{ text: cleanText }] : []),
    ];
  }

  return [
    { text: cleanText || "Archivo recibido. Analizalo si el formato es compatible." },
    { inlineData: { mimeType: mime, data: mediaData.base64 } },
  ];
}

function extractContactMarker(response) {
  const match = String(response || "").match(/\|\|\|CONTACTO:(\{.*?\})\|\|\|/s);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1]);
    return {
      nombre: parsed.nombre || "",
      dni: parsed.dni || "",
      colegio: parsed.colegio || "",
      curso: parsed.curso || "",
      hijos: Array.isArray(parsed.hijos) ? parsed.hijos : [],
    };
  } catch {
    return null;
  }
}

function shouldEscalate(response) {
  return String(response || "").includes("[[[DERIVAR_HUMANO]]]");
}

function isRetryableGeminiError(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  return [408, 409, 429, 500, 502, 503, 504].includes(status);
}

function getRetryDelayMs(error, attempt) {
  const detail = Array.isArray(error?.errorDetails)
    ? error.errorDetails.find((d) => d?.retryDelay)
    : null;

  if (detail?.retryDelay) {
    const seconds = Number(String(detail.retryDelay).replace("s", ""));
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 12000);
  }

  return Math.min(800 * 2 ** attempt, 6000);
}

async function sendGeminiWithRetry(chat, parts) {
  let lastError = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await chat.sendMessage(parts);
    } catch (error) {
      lastError = error;
      if (!isRetryableGeminiError(error) || attempt === 3) break;

      const wait = getRetryDelayMs(error, attempt);
      console.warn(`⚠️ Gemini temporalmente no disponible. Reintento ${attempt + 1}/3 en ${wait}ms...`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  throw lastError;
}

function buildSystemPrompt({ config, fechaActual, session, contacto }) {
  const colegios = Array.isArray(config.colegios) && config.colegios.length
    ? config.colegios.join(", ")
    : "Pucará, Los Cerros y Los Cerritos";

  const nombrePadre = contacto.nombre || "desconocido";
  const hijos = Array.isArray(contacto.hijos) && contacto.hijos.length ? contacto.hijos.join(", ") : "ninguno registrado";

  return `
Sos ${config.botName || "el asistente virtual de la Red APDES Tucumán"}.

MISIÓN:
Atender por WhatsApp a familias de ${colegios} con una experiencia cálida, precisa y profesional. Tu trabajo es resolver consultas simples, orientar con pasos claros y derivar a una persona cuando corresponda.

CONTEXTO ACTUAL:
- Fecha/hora: ${fechaActual}
- Tono deseado: ${config.tono || "cálido, claro, humano, cercano y respetuoso"}
- Primer mensaje de esta sesión: ${!session.greeted ? "SÍ" : "NO"}
- Nombre conocido del padre/tutor: ${nombrePadre}
- Hijos conocidos: ${hijos}
- Colegio conocido: ${contacto.colegio || session.colegio || "desconocido"}
- Curso conocido: ${contacto.curso || session.curso || "desconocido"}

BASE DE CONOCIMIENTO:
${buildKnowledge(config)}

REGLAS DE CALIDAD:
1. Respondé como una persona amable de secretaría/soporte escolar: simple, útil y confiable.
2. No inventes datos. Si no está en la base, aclaralo con cuidado y ofrecé derivar o indicar secretaría.
3. No uses asteriscos. Nada de markdown con negritas. Para listas usá guiones o emojis.
4. Mensajes cortos, claros y fáciles de leer por WhatsApp.
5. No repitas saludo si la conversación ya empezó.
6. Usá máximo 1 o 2 emojis por respuesta.
7. Si el usuario está molesto, respondé con calma y empatía antes de resolver.
8. Si pregunta por algo fuera de los colegios, explicá que solo podés ayudar con consultas de ${colegios}.

REGLA DE COLEGIO:
Si para responder hace falta saber el colegio y no está claro, preguntá primero:
"¡Claro! Para ayudarte bien, ¿me decís si es por Pucará, Los Cerros o Los Cerritos?"
No preguntes el colegio si el usuario ya lo dijo o si la consulta es general.

MENÚ INICIAL:
Usá este menú solo si el usuario saluda sin consulta específica:
${config.menuInicial || ""}

MINI MENÚ AL CONFIRMAR COLEGIO:
Si el usuario solo dice el colegio y nada más, respondé con un mini menú cálido para ese colegio:
"¡Genial, [Colegio]! 😊 ¿En qué te puedo ayudar?
💰 Cuotas y pagos
⏰ Horarios y entradas
👕 Uniforme reglamentario
📜 Trámites
💻 Problemas técnicos
Escribí tu consulta 👇"

IMÁGENES Y AUDIOS:
- Podés analizar imágenes/capturas y audios.
- Si la consulta técnica no es clara, pedí una captura.
- Si recibís un audio, respondé directo a lo que dijo. No digas "en el audio dijiste".

DERIVACIÓN A HUMANO:
Debés devolver exactamente [[[DERIVAR_HUMANO]]] cuando:
- Pide hablar con una persona.
- Es urgencia médica o situación grave.
- Es cuenta nueva, acceso, contraseña, DNI, usuario o problema técnico que ya probó los pasos y sigue sin funcionar.
- Es un reclamo sensible o administrativo que no podés resolver con la base.

Antes de derivar, si no es urgencia, intentá pedir estos datos cuando falten:
- Nombre completo
- DNI
- Colegio
- Curso/grado/sala
- Nombre del alumno/a si corresponde

Si ya tiene datos suficientes, devolvé SOLO [[[DERIVAR_HUMANO]]].

CONTACTOS Y DATOS:
Si detectás datos de contacto o colegio, al final de la respuesta agregá una marca invisible con este formato exacto:
|||CONTACTO:{"nombre":"Juan Pérez","dni":"12345678","colegio":"Pucará","curso":"3er grado","hijos":["Lucas"]}|||
No uses backticks. Si no detectás datos, no agregues la marca.

RESPUESTA FINAL:
La respuesta visible tiene que estar lista para WhatsApp. Sin texto interno, sin explicación técnica y sin marcas salvo CONTACTO al final cuando corresponda.
`.trim();
}

async function appendTurnAndSave(session, from, userText, botText, mediaData = null) {
  let userPart = { text: userText || (mediaData ? "[media]" : ""), ts: Date.now() };

  if (mediaData) {
    const mediaKey = await saveMedia(from, mediaData.mimeType, mediaData.base64);
    userPart = {
      ...userPart,
      mediaKey,
      mimeType: String(mediaData.mimeType || "").split(";")[0].trim(),
    };
  }

  const botPart = { text: cleanVisibleText(botText), ts: Date.now() };

  session.history = [
    ...(Array.isArray(session.history) ? session.history : []),
    { role: "user", parts: [userPart] },
    { role: "model", parts: [botPart] },
  ].slice(-40);

  session.ultimoMensaje = cleanVisibleText(botText || userText);
  session.lastSeen = Date.now();

  await updateSession(from, session);
}

export async function handleTestMessage(message) {
  const from = String(message.from || "").trim();
  const text = String(message.text?.body || "").trim();
  const mediaData = message.mediaData || null;

  const config = await getConfig();
  let session = await getSession(from);
  const contacto = await getContacto(from);

  const resetMinutes = Number(config.handoverResetMinutes || 120);

  if (session.status === "HANDOVER") {
    const minutos = (Date.now() - Number(session.lastSeen || 0)) / 1000 / 60;

    if (minutos < resetMinutes) {
      let userPart = { text: text || (mediaData ? "[media]" : ""), ts: Date.now() };

      if (mediaData) {
        const mediaKey = await saveMedia(from, mediaData.mimeType, mediaData.base64);
        userPart = {
          ...userPart,
          mediaKey,
          mimeType: String(mediaData.mimeType || "").split(";")[0].trim(),
        };
      }

      session.history = [
        ...(Array.isArray(session.history) ? session.history : []),
        { role: "user", parts: [userPart] },
      ].slice(-40);
      session.ultimoMensaje = cleanForStorage(text || "[media]");
      session.lastSeen = Date.now();
      await updateSession(from, session);
      return null;
    }

    session.status = "ACTIVE";
    session.greeted = false;
    session.isReturningUser = true;
    session.history = [];
  }

  const fechaActual = new Date().toLocaleString("es-AR", {
    timeZone: "America/Argentina/Tucuman",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  if (!session.greeted && !mediaData && isGreetingOnly(text)) {
    const menu = cleanVisibleText(config.menuInicial || "¡Hola! 👋 Soy el asistente virtual. ¿En qué te puedo ayudar?");
    session.greeted = true;
    await appendTurnAndSave(session, from, text, menu);
    return menu;
  }

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("Falta GEMINI_API_KEY");
    }

    const systemPrompt = buildSystemPrompt({
      config,
      fechaActual,
      session,
      contacto,
    });

    const model = genAI.getGenerativeModel({
      model: config.model || process.env.GEMINI_MODEL || "gemini-2.0-flash",
      systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature: Number(config.temperature ?? 0.2),
        maxOutputTokens: Number(config.maxOutputTokens || 4096),
      },
    });

    const chat = model.startChat({
      history: limpiarHistorial(session.history || [], Number(config.maxHistoryForAI || 14)),
    });

    const result = await sendGeminiWithRetry(chat, buildParts(text, mediaData));
    let rawResponse = result.response.text().trim();

    const detectedContact = extractContactMarker(rawResponse);
    if (detectedContact) {
      await updateContacto(from, detectedContact);
      session.contacto = {
        ...(session.contacto || {}),
        ...detectedContact,
      };
      session.nombre = detectedContact.nombre || session.nombre;
      session.dni = detectedContact.dni || session.dni;
      session.colegio = detectedContact.colegio || session.colegio;
      session.curso = detectedContact.curso || session.curso;
      session.hijos = detectedContact.hijos?.length ? detectedContact.hijos : session.hijos;
    }

    if (shouldEscalate(rawResponse)) {
      session.status = "HANDOVER";
      session.greeted = true;
      const derivacion = cleanVisibleText(
        config.mensajeDerivacion ||
          "📞 ¡Listo! Tus datos fueron enviados al equipo de soporte. En breve alguien se contactará por acá. 😊"
      );
      await appendTurnAndSave(session, from, text, derivacion, mediaData);
      return derivacion;
    }

    const visible = cleanVisibleText(rawResponse);
    session.greeted = true;
    await appendTurnAndSave(session, from, text || "[media]", visible, mediaData);

    return visible || "¿Me lo podés repetir con un poco más de detalle? 😊";
  } catch (error) {
    console.error("❌ Error en el bot:", error);

    const fallback =
      "Tuve un pequeño micro-corte técnico. Ya recibí tu mensaje, pero no pude procesarlo bien. ¿Podés escribírmelo de nuevo en un momento? 😅";

    session.greeted = true;
    await appendTurnAndSave(session, from, text || "[media]", fallback, mediaData);
    return fallback;
  }
}
