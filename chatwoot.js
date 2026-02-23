import fetch from "node-fetch";

const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming") {
  try {
    if (!INBOX_TOKEN) return;

    // 1. Buscamos o creamos al contacto (esto ya lo tenés bien)
    const resContacto = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: telefono, name: `WhatsApp ${telefono}` })
    });
    const dataContacto = await resContacto.json();
    const sourceId = dataContacto.source_id;

    // 2. BUSCADOR DE CHAT ABIERTO: Miramos si ya hay una conversación que NO esté resuelta
    const resGetConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`);
    const conversaciones = await resGetConv.json();

    // Buscamos la que esté "open" o "pending"
    let conversationId;
    const convAbierta = conversaciones.find(c => c.status === "open" || c.status === "pending");

    if (convAbierta) {
        conversationId = convAbierta.id; // ¡Encontramos el chat actual!
    } else {
        // Si no hay ninguna abierta, recién ahí creamos una nueva
        const resConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const dataConv = await resConv.json();
        conversationId = dataConv.id;
    }

    // 3. Mandamos el mensaje al lugar correcto
    await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: mensajeTexto, message_type: tipo })
    });
    
    console.log(`✅ Mensaje (${tipo}) enviado al hilo correcto.`);
  } catch (error) {
    console.error("❌ Error en Chatwoot:", error);
  }
}