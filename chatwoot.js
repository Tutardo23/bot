import fetch from "node-fetch";

const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming") {
  try {
    if (!INBOX_TOKEN) {
        console.log("Chatwoot apagado: Faltan credenciales.");
        return;
    }

    // 1. Buscamos o creamos al usuario
    const resContacto = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: telefono, name: `WhatsApp ${telefono}` })
    });
    const dataContacto = await resContacto.json();
    const sourceId = dataContacto.source_id;

    // 2. Creamos o recuperamos la conversación
    const resConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const dataConv = await resConv.json();
    const conversationId = dataConv.id;

    // 3. Mandamos el mensaje a Chatwoot indicando si es del padre o del bot
    await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
          content: mensajeTexto,
          message_type: tipo // Acá decide si lo pone a la derecha o a la izquierda en tu pantalla
      })
    });
    
    console.log(`✅ Mensaje (${tipo}) reenviado a Chatwoot.`);
  } catch (error) {
    console.error("❌ Error conectando con Chatwoot:", error);
  }
}