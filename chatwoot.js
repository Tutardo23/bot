const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming") {
  try {
    if (!INBOX_TOKEN) return;

    // Pausa de seguridad para que Chatwoot procese
    if (tipo === "outgoing") await sleep(1000); 

    // 1. Crear/Buscar Contacto
    const resContacto = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: telefono, name: `WhatsApp ${telefono}` })
    });
    const dataContacto = await resContacto.json();
    const sourceId = dataContacto.source_id;

    // 2. Buscar conversación abierta
    const resGetConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`);
    const conversaciones = await resGetConv.json();

    let conversationId;
    // Buscamos una que esté abierta (status open o pending)
    const convAbierta = Array.isArray(conversaciones) ? conversaciones.find(c => c.status !== "resolved") : null;

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

    // 3. Enviar el mensaje
    const resFinal = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: mensajeTexto, message_type: tipo })
    });
    
    if (resFinal.ok) {
        console.log(`✅ Chatwoot OK: Mensaje ${tipo} enviado.`);
    }
  } catch (error) {
    console.error("❌ Error en Chatwoot:", error);
  }
}