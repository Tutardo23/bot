import fetch from "node-fetch";
import { Redis } from "@upstash/redis";
import dotenv from "dotenv";

dotenv.config();

const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN  = process.env.CHATWOOT_INBOX_TOKEN;
const ACCOUNT_ID   = process.env.CHATWOOT_ACCOUNT_ID;
const API_TOKEN    = process.env.CHATWOOT_API_TOKEN;
const AGENT_ID     = process.env.CHATWOOT_AGENT_ID;

// Usamos Redis para que los IDs de conversación sobrevivan reinicios del servidor
const redis = new Redis({
  url:   process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

/* =========================================
   HELPERS DE PERSISTENCIA EN REDIS
========================================= */
async function getConversacionActiva(telefono) {
  try {
    const data = await redis.get(`chatwoot:${telefono}`);
    if (!data) return null;
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch (e) {
    return null;
  }
}

async function setConversacionActiva(telefono, sourceId, conversationId) {
  try {
    // Guardamos por 30 días
    await redis.set(
      `chatwoot:${telefono}`,
      JSON.stringify({ sourceId, conversationId }),
      { ex: 60 * 60 * 24 * 30 }
    );
  } catch (e) {
    console.error("❌ Error guardando conversación en Redis:", e);
  }
}

/* =========================================
   FUNCIÓN PRINCIPAL: ENVIAR MENSAJE
========================================= */
export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming") {
  try {
    if (!INBOX_TOKEN) return;

    // 1️⃣ Creamos o recuperamos el contacto
    const resContacto = await fetch(
      `${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: telefono,
          name: `WhatsApp ${telefono}`
        })
      }
    );
    const dataContacto = await resContacto.json();
    const sourceId = dataContacto.source_id;

    // 2️⃣ Buscamos la conversación en Redis
    let conversacion = await getConversacionActiva(telefono);
    let conversationId = conversacion?.conversationId;

    if (!conversationId) {
      // No existe → creamos una nueva
      const resConv = await fetch(
        `${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignee_id: null })
        }
      );
      const dataConv = await resConv.json();
      conversationId = dataConv.id;

      // La guardamos en Redis para siempre (hasta los 30 días)
      await setConversacionActiva(telefono, sourceId, conversationId);
      console.log(`📋 Nueva conversación Chatwoot creada: ${conversationId} para ${telefono}`);
    }

    // 3️⃣ Enviamos el mensaje al hilo correcto
    await fetch(
      `${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: mensajeTexto,
          message_type: tipo
        })
      }
    );

    console.log(`✅ Mensaje (${tipo}) enviado al hilo ${conversationId}.`);
  } catch (error) {
    console.error("❌ Error en Chatwoot:", error);
  }
}

/* =========================================
   FUNCIÓN DE HANDOVER: ASIGNAR A AGENTE
   Se llama cuando el bot detecta ACTION_HANDOVER
========================================= */
export async function asignarAHumano(telefono) {
  try {
    if (!ACCOUNT_ID || !API_TOKEN || !AGENT_ID) {
      console.warn("⚠️ Faltan variables de entorno para asignar agente (ACCOUNT_ID, API_TOKEN o AGENT_ID).");
      return;
    }

    const conversacion = await getConversacionActiva(telefono);
    const conversationId = conversacion?.conversationId;

    if (!conversationId) {
      console.warn(`⚠️ No se encontró conversación activa para ${telefono}, no se puede asignar.`);
      return;
    }

    // Primero asignamos al agente
    const resAsignacion = await fetch(
      `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/assignments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api_access_token": API_TOKEN
        },
        body: JSON.stringify({ assignee_id: Number(AGENT_ID) })
      }
    );

    if (!resAsignacion.ok) {
      const errorData = await resAsignacion.json();
      console.error("❌ Error en la asignación:", errorData);
      return;
    }

    // Luego la marcamos como "open" para que aparezca en la bandeja "Mine" del agente
    await fetch(
      `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/toggle_status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api_access_token": API_TOKEN
        },
        body: JSON.stringify({ status: "open" })
      }
    );

    console.log(`👤 Conversación ${conversationId} asignada al agente y marcada como pendiente.`);
  } catch (error) {
    console.error("❌ Error asignando conversación:", error);
  }
}