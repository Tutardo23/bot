import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { handleTestMessage } from "./bot.js";
import { getSession, updateSession } from "./memory.js";

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const MY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

/* =========================================
   DESCARGADOR DE MEDIA (imágenes y audios)
   WhatsApp envía un media_id → lo descargamos
   de los servidores de Meta y lo convertimos
   a base64 para enviárselo a Gemini.
========================================= */
async function downloadMedia(mediaId) {
  try {
    // 1️⃣ Pedimos la URL real del archivo a Meta
    const { data: mediaInfo } = await axios.get(
      `https://graph.facebook.com/v21.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );

    // 2️⃣ Descargamos el archivo binario
    const { data: mediaBuffer } = await axios.get(mediaInfo.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      responseType: "arraybuffer"
    });

    return {
      base64: Buffer.from(mediaBuffer).toString("base64"),
      mimeType: mediaInfo.mime_type  // ej: "image/jpeg", "audio/ogg; codecs=opus"
    };

  } catch (error) {
    console.error("❌ Error descargando media:", error.message);
    return null;
  }
}

/* =========================================
   RUTA DE SIMULACIÓN LOCAL
========================================= */
app.post("/chat-local", async (req, res) => {
  try {
    const { message } = req.body;
    const userSimulatorId = "usuario_local_browser";

    console.log(`💻 Local: ${message}`);

    const fakeMessageObj = {
      from: userSimulatorId,
      type: "text",
      text: { body: message }
    };

    const respuesta = await handleTestMessage(fakeMessageObj);

    if (respuesta === null) {
      return res.json({ reply: "🤫 El bot está en silencio (Modo Humano activado)." });
    }

    res.json({ reply: respuesta });

  } catch (error) {
    console.error("\n🔥 ERROR GRAVE:", error);
    res.status(500).json({ reply: "❌ Error en el servidor. Revisá la terminal." });
  }
});

/* =========================================
   WEBHOOK DE CHATWOOT
========================================= */
app.post("/chatwoot-webhook", async (req, res) => {
  try {
    const data = req.body;

    if (data.event === "message_created" && data.message_type === "outgoing") {
      const numeroTelefono = data.conversation?.meta?.sender?.identifier;
      const textoRespuesta = data.content?.trim();

      if (!numeroTelefono || !textoRespuesta) return res.sendStatus(200);

      if (textoRespuesta.toLowerCase() === "/bot") {
        const session = await getSession(numeroTelefono);
        session.status = "ACTIVE";
        session.greeted = false;
        session.history = [];
        await updateSession(numeroTelefono, session);
        console.log(`🤖 Bot reactivado para ${numeroTelefono}`);
        return res.sendStatus(200);
      }

      console.log(`👨‍💼 Agente responde a ${numeroTelefono}: ${textoRespuesta}`);
      await sendMessage(numeroTelefono, textoRespuesta);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error en webhook de Chatwoot:", error);
    res.sendStatus(500);
  }
});

/* =========================================
   WEBHOOK DE WHATSAPP (Meta)
========================================= */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === MY_TOKEN) {
    console.log("✅ Webhook verificado!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (!body.object) return res.sendStatus(404);

  const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!message) return res.sendStatus(200);

  const from = message.from;
  const type = message.type; // "text" | "image" | "audio"

  console.log(`📩 Mensaje de ${from} — tipo: ${type}`);

  let messageObj = { from, type };
  let mediaData = null;

  // ── TEXTO ──────────────────────────────
  if (type === "text") {
    messageObj.text = message.text;

  // ── IMAGEN ─────────────────────────────
  } else if (type === "image") {
    const mediaId = message.image.id;
    const caption = message.image.caption || "";
    console.log(`🖼️ Imagen recibida (id: ${mediaId})`);

    mediaData = await downloadMedia(mediaId);
    messageObj.text = { body: caption || "[El usuario envió una imagen]" };
    messageObj.mediaData = mediaData;

  // ── AUDIO (notas de voz) ───────────────
  } else if (type === "audio") {
    const mediaId = message.audio.id;
    console.log(`🎙️ Audio recibido (id: ${mediaId})`);

    mediaData = await downloadMedia(mediaId);
    messageObj.text = { body: "[El usuario envió un audio de voz]" };
    messageObj.mediaData = mediaData;

  // ── TIPO NO SOPORTADO ──────────────────
  } else {
    console.log(`⚠️ Tipo de mensaje no soportado: ${type}`);
    await sendMessage(from, "Por el momento solo puedo leer textos, imágenes y audios de voz. 😊");
    return res.sendStatus(200);
  }

  const respuestaBot = await handleTestMessage(messageObj);

  if (respuestaBot) {
    let numeroDestino = from;
    // Fix de número conocido
    if (from === "5493816559383") numeroDestino = "54381156559383";
    await sendMessage(numeroDestino, respuestaBot);
  }

  res.sendStatus(200);
});

/* =========================================
   ENVÍO DE MENSAJES A WHATSAPP
========================================= */
async function sendMessage(to, text) {
  try {
    await axios({
      method: "POST",
      url: `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      data: {
        messaging_product: "whatsapp",
        to,
        text: { body: text },
      },
    });
    console.log(`🤖 Respuesta enviada: ${text.substring(0, 40)}...`);
  } catch (error) {
    console.error("❌ Error enviando a WhatsApp:", error.response?.data || error.message);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en puerto ${PORT}`);
  console.log(`👉 Simulador: http://localhost:${PORT}/chat.html`);
});

export default app;