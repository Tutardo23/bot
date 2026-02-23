const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming") {
  try {
    if (!INBOX_TOKEN) return;

    // 1️⃣ LIMPIEZA DE NÚMERO: Clave para Argentina 🇦🇷
    // Quitamos el '9' si existe para que Chatwoot no vea dos personas distintas
    let telLimpio = telefono.replace(/\D/g, ''); 
    if (telLimpio.startsWith("549")) {
        telLimpio = "54" + telLimpio.substring(3); 
    }

    // Pausa de seguridad para que Chatwoot procese el mensaje anterior
    if (tipo === "outgoing") await sleep(1500); 

    // 2️⃣ BUSCAR O CREAR CONTACTO
    const resContacto = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: telLimpio, name: `WhatsApp ${telLimpio}` })
    });
    const dataContacto = await resContacto.json();
    const sourceId = dataContacto.source_id || dataContacto.payload?.contact?.source_id;

    if (!sourceId) {
        console.error("❌ Error: No se pudo obtener el ID del contacto.");
        return;
    }

    // 3️⃣ BUSCAR CONVERSACIÓN EXISTENTE
    const resGetConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`);
    const conversaciones = await resGetConv.json();

    let conversationId;
    // Buscamos cualquier chat que NO esté resuelto (status open o pending)
    const convAbierta = Array.isArray(conversaciones) 
        ? conversaciones.find(c => c.status !== "resolved") 
        : null;

    if (convAbierta) {
        conversationId = convAbierta.id;
    } else {
        // Solo si no hay NADA abierto, creamos una nueva
        const resConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const dataConv = await resConv.json();
        conversationId = dataConv.id;
    }

    // 4️⃣ ENVIAR EL MENSAJE
    await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: mensajeTexto, message_type: tipo })
    });
    
    console.log(`✅ Chatwoot sincronizado: Mensaje ${tipo} en conversación ${conversationId}`);

  } catch (error) {
    console.error("❌ Error en chatwoot.js:", error.message);
  }
}