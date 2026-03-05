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
   RUTA DE SIMULACIÓN LOCAL
========================================= */
app.post("/chat-local", async (req, res) => {
  try {
    const { message } = req.body;
    const userSimulatorId = "usuario_local_browser";

    console.log(`💻 Local: ${message}`);

    const fakeMessageObj = {
      from: userSimulatorId,
      text: { body: message }
    };

    const respuesta = await handleTestMessage(fakeMessageObj);

    if (respuesta === null) {
      return res.json({ reply: "🤫 El bot está en silencio (Modo Humano activado)." });
    }

    res.json({ reply: respuesta });

  } catch (error) {
    console.error("\n🔥 ERROR GRAVE ATRAPADO EN INDEX.JS:");
    console.error(error);
    res.status(500).json({ reply: "❌ El código crasheó por detrás. Revisá la terminal para ver el error exacto." });
  }
});

/* =========================================
   WEBHOOK DE CHATWOOT
   Recibe mensajes de agentes humanos
========================================= */
app.post("/chatwoot-webhook", async (req, res) => {
  try {
    const data = req.body;

    if (data.event === "message_created" && data.message_type === "outgoing") {

      const numeroTelefono = data.conversation?.meta?.sender?.identifier;
      const textoRespuesta = data.content?.trim();

      if (!numeroTelefono || !textoRespuesta) {
        return res.sendStatus(200);
      }

      // 🤖 COMANDO SECRETO: /bot — Reactiva el bot desde Chatwoot
      // El agente escribe "/bot" en el chat y ese mensaje NO se envía a WhatsApp
      if (textoRespuesta.toLowerCase() === "/bot") {
        const session = await getSession(numeroTelefono);

        // Reseteamos el estado a ACTIVE y borramos el historial para empezar limpio
        session.status = "ACTIVE";
        session.greeted = false;
        session.history = [];

        await updateSession(numeroTelefono, session);

        console.log(`🤖 Bot reactivado para ${numeroTelefono} por un agente desde Chatwoot.`);

        // No reenviamos nada a WhatsApp, el comando es invisible para el usuario
        return res.sendStatus(200);
      }

      // Mensaje normal del agente → lo mandamos a WhatsApp
      console.log(`👨‍💼 Agente responde a ${numeroTelefono}: ${textoRespuesta}`);
      await sendMessage(numeroTelefono, textoRespuesta);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Error procesando el webhook de Chatwoot:", error);
    res.sendStatus(500);
  }
});

/* =========================================
   RUTAS DE WHATSAPP REAL (Meta)
========================================= */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === MY_TOKEN) {
      console.log("✅ Webhook verificado correctamente!");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object) {
    if (
      body.entry &&
      body.entry[0].changes &&
      body.entry[0].changes[0].value.messages &&
      body.entry[0].changes[0].value.messages[0]
    ) {
      const message = body.entry[0].changes[0].value.messages[0];
      const from = message.from;

      if (message.type === "text") {
        console.log(`📩 WhatsApp de ${from}: ${message.text.body}`);
        const respuestaBot = await handleTestMessage(message);

        if (respuestaBot) {
          let numeroDestino = from;
          if (from === "5493816559383") {
            numeroDestino = "54381156559383";
          }
          await sendMessage(numeroDestino, respuestaBot);
        }
      }
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

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
        to: to,
        text: { body: text },
      },
    });
    console.log(`🤖 Respondido a WhatsApp: ${text.substring(0, 30)}...`);
  } catch (error) {
    console.error("❌ Error enviando a WhatsApp:", error.response ? error.response.data : error.message);
  }
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor listo!`);
  console.log(`👉 Abrí en tu navegador: http://localhost:${PORT}/chat.html`);
});

export default app;