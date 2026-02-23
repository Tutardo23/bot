import { updateSession } from "./memory.js";

const CHATWOOT_URL = process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming", session = null) {
  try {
    if (!INBOX_TOKEN) {
      console.error("❌ Error: Falta CHATWOOT_INBOX_TOKEN en las variables de entorno.");
      return;
    }

    // 1. Limpieza de número para Argentina
    let telLimpio = telefono.replace(/\D/g, "");
    if (telLimpio.startsWith("549")) {
      telLimpio = "54" + telLimpio.substring(3);
    }

    // 2. Crear o buscar contacto en Chatwoot
    const resContacto = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: telLimpio,
        name: `Padre ${telLimpio}`,
      }),
    });

    const dataContacto = await resContacto.json();
    const sourceId = dataContacto.source_id || dataContacto.payload?.contact?.source_id;

    if (!sourceId) {
      console.error("❌ No se pudo obtener el source_id del contacto.");
      return;
    }

    // 3. 🔒 Lógica de conversación única usando el ID de la sesión
    let conversationId = session?.conversationId;

    if (!conversationId) {
      // Si no hay ID en memoria, intentamos buscar si ya hay un chat abierto en Chatwoot
      const resBusqueda = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`);
      const chatsExistentes = await resBusqueda.json();
      
      const chatAbierto = Array.isArray(chatsExistentes) 
        ? chatsExistentes.find(c => c.status !== "resolved") 
        : null;

      if (chatAbierto) {
        conversationId = chatAbierto.id;
      } else {
        // Solo si no hay nada abierto, creamos una conversación nueva
        const resNuevaConv = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const dataNuevaConv = await resNuevaConv.json();
        conversationId = dataNuevaConv.id;
      }

      // Guardamos el ID en la memoria de Upstash para futuros mensajes
      if (session && conversationId) {
        session.conversationId = conversationId;
        await updateSession(telefono, session);
      }
    }

    // 4. Enviar el mensaje al hilo correcto
    const resMensaje = await fetch(`${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: mensajeTexto,
        message_type: tipo,
      }),
    });

    if (resMensaje.ok) {
      console.log(`✅ Mensaje (${tipo}) sincronizado en hilo: ${conversationId}`);
    } else {
      console.error("❌ Error al enviar mensaje a Chatwoot.");
    }

  } catch (error) {
    console.error("❌ Error crítico en Chatwoot:", error.message);
  }
}