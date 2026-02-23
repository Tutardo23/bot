import fetch from "node-fetch";

const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

const conversacionesActivas = {};

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming") {
  try {
    if (!INBOX_TOKEN) return;

    let sourceId;
    let conversationId;

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