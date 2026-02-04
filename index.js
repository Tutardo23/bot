import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import path from "path"; // <--- NUEVO
import { handleTestMessage } from "./bot.js";

dotenv.config();

const app = express();
app.use(express.json());

// 🟢 NUEVO: Servir archivos estáticos (HTML) de la carpeta public
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const MY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

/* =========================================
   RUTA DE SIMULACIÓN LOCAL (Para tu navegador)
========================================= */
app.post("/chat-local", async (req, res) => {
  const { message } = req.body;
  const userSimulatorId = "usuario_local_browser"; // ID ficticio para probar

  console.log(`💻 Local: ${message}`);

  // Simulamos la estructura que tiene un mensaje de WhatsApp real
  const fakeMessageObj = {
    from: userSimulatorId,
    text: { body: message }
  };

  // Le pasamos el mensaje falso a tu cerebro real
  const respuesta = await handleTestMessage(fakeMessageObj);

  // Devolvemos la respuesta directa al navegador
  res.json({ reply: respuesta });
});

/* =========================================
   RUTAS DE WHATSAPP REAL (Meta)
========================================= */
// Verificación del Webhook
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

// Recepción de mensajes reales
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
          await sendMessage(from, respuestaBot);
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