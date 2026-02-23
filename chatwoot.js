const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming") {
  try {
    if (!INBOX_TOKEN) return;

    // 1. Limpieza de número (Formato internacional limpio)
    // Esto evita que Chatwoot cree dos contactos para el mismo padre
    let telLimpio = telefono.replace(/\D/g, ''); 
    if (telLimpio.startsWith("549")) {
        telLimpio = "54" + telLimpio.substring(3); // Cambia 549381... a 54381...
    }

    // Pausa estratégica para evitar que la respuesta llegue antes que la pregunta
    if (tipo === "outgoing") await sleep(1500); 

    // 2. Buscar o crear el contacto
    const resContacto = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: telLimpio, name: `WhatsApp ${telLimpio}` })
    });
    const dataContacto = await resContacto.json();
    const sourceId = dataContacto.source_id;

    if (!sourceId) {
        console.error("❌ No se pudo obtener el Source ID de Chatwoot");
        return;
    }

    // 3. Buscar conversación activa (que no esté resuelta)
    const resGetConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`);
    const conversaciones = await resGetConv.json();

    let conversationId;
    // Buscamos cualquier chat que NO esté resuelto
    const convExistente = Array.isArray(conversaciones) 
        ? conversaciones.find(c => c.status !== "resolved") 
        : null;

    if (convExistente) {
        conversationId = convExistente.id;
    } else {
        // Crear conversación nueva si no hay nada abierto
        const resConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const dataConv = await resConv.json();
        conversationId = dataConv.id;
    }

    // 4. Enviar el mensaje final
    await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: mensajeTexto, message_type: tipo })
    });
    
    console.log(`✅ Chatwoot sincronizado (${tipo})`);
  } catch (error) {
    console.error("❌ Error crítico en Chatwoot:", error.message);
  }
}