import { updateSession } from "./memory.js";

const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming", session = null) {
  try {
    if (!INBOX_TOKEN) return;

    // 1. Limpieza de número para Argentina
    let telLimpio = telefono.replace(/\D/g, "");
    if (telLimpio.startsWith("549")) {
      telLimpio = "54" + telLimpio.substring(3);
    }

    // 2. Crear o buscar contacto (Public API)
    const resContacto = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: telLimpio, name: `Padre ${telLimpio}` }),
    });

    const dataContacto = await resContacto.json();
    const sourceId = dataContacto.source_id || dataContacto.payload?.contact?.source_id;
    if (!sourceId) return;

    // 3. 🔒 Lógica de ID de conversación única
    let conversationId = session?.conversationId;

    // Si no tenemos el ID en la sesión, buscamos si hay uno abierto en Chatwoot antes de crear
    if (!conversationId) {
      const resGet = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`);
      const convs = await resGet.json();
      
      const abierta = Array.isArray(convs) ? convs.find(c => c.status !== "resolved") : null;
      
      if (abierta) {
        conversationId = abierta.id;
      } else {
        // Solo si no hay nada, creamos uno nuevo
        const resNew = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const dataNew = await resNew.json();
        conversationId = dataNew.id;
      }

      // Guardamos el ID en la memoria para el próximo mensaje
      if (session && conversationId) {
        session.conversationId = conversationId;
        await updateSession(telefono, session);
      }
    }

    // 4. Enviar mensaje al hilo correcto
    await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: mensajeTexto, message_type: tipo }),
    });

    console.log(`✅ ${telLimpio} → Hilo ${conversationId}`);
  } catch (error) {
    console.error("❌ Error en Chatwoot:", error.message);
  }
}