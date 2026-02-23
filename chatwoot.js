import fetch from "node-fetch";

const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const API_TOKEN = process.env.CHATWOOT_API_TOKEN;
const AGENT_ID = process.env.CHATWOOT_AGENT_ID;

const conversacionesActivas = {};

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming") {
  try {
    if (!INBOX_TOKEN) return;

    let sourceId;
    let conversationId;

    // 1️⃣ Crear o reutilizar contacto
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
    sourceId = dataContacto.source_id;

    // 2️⃣ Crear conversación solo una vez
    if (conversacionesActivas[telefono]) {
      conversationId = conversacionesActivas[telefono];
    } else {
      const resConv = await fetch(
        `${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            assignee_id: null
          })
        }
      );

      const dataConv = await resConv.json();
      conversationId = dataConv.id;

      conversacionesActivas[telefono] = conversationId;
    }

    // 3️⃣ Enviar mensaje
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

    console.log(`✅ Mensaje (${tipo}) enviado al mismo hilo.`);

  } catch (error) {
    console.error("❌ Error en Chatwoot:", error);
  }
}

// 🔥 NUEVA FUNCIÓN PARA ASIGNAR A HUMANO
export async function asignarAHumano(telefono) {
  try {
    const conversationId = conversacionesActivas[telefono];
    if (!conversationId) return;

    await fetch(
      `${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/assignments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api_access_token": API_TOKEN
        },
        body: JSON.stringify({
          assignee_id: AGENT_ID
        })
      }
    );

    console.log("👤 Conversación asignada a humano.");
  } catch (error) {
    console.error("❌ Error asignando conversación:", error);
  }
}