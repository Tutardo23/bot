import fetch from "node-fetch";

const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

// 🕒 Función mágica para esperar un toque (evita duplicar chats)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming") {
  try {
    if (!INBOX_TOKEN) {
        console.log("Chatwoot apagado: Faltan credenciales.");
        return;
    }

    // 1️⃣ Si es la respuesta del bot, esperamos 1 segundo.
    // Esto le da tiempo a Chatwoot de terminar de crear el chat del padre 
    // y evita que se creen dos hilos separados.
    if (tipo === "outgoing") {
        await sleep(1000); 
    }

    // 2️⃣ Buscamos o creamos al contacto por su teléfono
    const resContacto = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: telefono, name: `WhatsApp ${telefono}` })
    });
    const dataContacto = await resContacto.json();
    const sourceId = dataContacto.source_id;

    // 3️⃣ Buscamos si ya existe una conversación que NO esté resuelta
    const resGetConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`);
    const conversaciones = await resGetConv.json();

    let conversationId;
    
    // Filtramos para encontrar la que esté "abierta" o "pendiente"
    const convAbierta = conversaciones && conversaciones.length > 0 
        ? conversaciones.find(c => c.status === "open" || c.status === "pending")
        : null;

    if (convAbierta) {
        // Si existe, la usamos
        conversationId = convAbierta.id;
    } else {
        // Si no hay ninguna abierta, creamos una nueva
        const resConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const dataConv = await resConv.json();
        conversationId = dataConv.id;
    }

    // 4️⃣ Mandamos el mensaje al hilo que encontramos/creamos
    await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
          content: mensajeTexto,
          message_type: tipo 
      })
    });
    
    console.log(`✅ Chatwoot: Mensaje (${tipo}) enviado al hilo ${conversationId}.`);
  } catch (error) {
    console.error("❌ Error en la conexión con Chatwoot:", error);
  }
}