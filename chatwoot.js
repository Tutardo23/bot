const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming") {
  try {
    if (!INBOX_TOKEN) return;

    // 1️⃣ NORMALIZACIÓN AGRESIVA DEL NÚMERO
    let telLimpio = telefono.replace(/\D/g, ''); 
    
    // Si empieza con 549, le sacamos el 9. Queremos que SIEMPRE sea 54381...
    if (telLimpio.startsWith("549")) {
        telLimpio = "54" + telLimpio.substring(3);
    }

    // Espera estratégica para que Chatwoot no se pise a sí mismo
    if (tipo === "outgoing") await sleep(1500); 

    // 2️⃣ BUSCAR O CREAR CONTACTO (Con el ID único del teléfono)
    const resContacto = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
          identifier: telLimpio, 
          name: `Padre ${telLimpio}` 
      })
    });
    const dataContacto = await resContacto.json();
    const sourceId = dataContacto.source_id || dataContacto.payload?.contact?.source_id;

    if (!sourceId) return;

    // 3️⃣ BUSCAR CONVERSACIÓN EXISTENTE (Cualquiera que no esté resuelta)
    const resGetConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`);
    const conversaciones = await resGetConv.json();

    let conversationId;
    const convAbierta = Array.isArray(conversaciones) 
        ? conversaciones.find(c => c.status !== "resolved") 
        : null;

    if (convAbierta) {
        conversationId = convAbierta.id;
    } else {
        // Solo si no hay nada, creamos uno nuevo
        const resConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const dataConv = await resConv.json();
        conversationId = dataConv.id;
    }

    // 4️⃣ MANDAR EL MENSAJE
    await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
          content: mensajeTexto, 
          message_type: tipo 
      })
    });
    
    console.log(`✅ OK: ${telLimpio} -> Chat ${conversationId}`);
  } catch (error) {
    console.error("❌ Error en Chatwoot:", error.message);
  }
}