import fetch from "node-fetch";

const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming") {
  try {
    if (!INBOX_TOKEN) return;

    // 1. Buscamos o creamos al contacto
    const resContacto = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: telefono, name: `WhatsApp ${telefono}` })
    });

    const dataContacto = await resContacto.json();
    const sourceId = dataContacto.source_id;

    // 2. BUSCADOR DE CHAT ABIERTO (CORREGIDO)
    const resGetConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`);
    const dataConvs = await resGetConv.json();

    // 🔥 Chatwoot a veces devuelve { payload: [...] }
    const conversaciones = Array.isArray(dataConvs) ? dataConvs : dataConvs.payload || [];

    let conversationId;
    const convAbierta = conversaciones.find(
      c => c.status === "open" || c.status === "pending"
    );

    if (convAbierta) {
      conversationId = convAbierta.id;
    } else {
      const resConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const dataConv = await resConv.json();
      conversationId = dataConv.id;
    }

    // 3. Mandamos el mensaje al hilo correcto
    await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: mensajeTexto,
        message_type: tipo
      })
    });

    console.log(`✅ Mensaje (${tipo}) enviado al hilo correcto.`);
  } catch (error) {
    console.error("❌ Error en Chatwoot:", error);
  }
}