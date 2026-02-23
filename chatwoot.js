import { getSession, updateSession } from "./memory.js";

const CHATWOOT_URL =
  process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";

const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

export async function enviarAChatwoot(
  telefono,
  mensajeTexto,
  tipo = "incoming"
) {
  try {
    if (!INBOX_TOKEN) return;

    let telLimpio = telefono.replace(/\D/g, "");

    if (telLimpio.startsWith("549")) {
      telLimpio = "54" + telLimpio.substring(3);
    }

    // 🔹 Obtener sesión guardada
    const session = await getSession(telefono);

    let conversationId = session.conversationId;

    // 🔹 Crear o buscar contacto
    const resContacto = await fetch(
      `${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: telLimpio,
          name: `Padre ${telLimpio}`,
        }),
      }
    );

    const dataContacto = await resContacto.json();
    const sourceId =
      dataContacto.source_id || dataContacto.payload?.contact?.source_id;

    if (!sourceId) return;

    // 🔹 Si no hay conversación guardada, buscar o crear
    if (!conversationId) {
      const resGetConv = await fetch(
        `${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`
      );

      const conversaciones = await resGetConv.json();

      const convAbierta = Array.isArray(conversaciones)
        ? conversaciones.find((c) => c.status !== "resolved")
        : null;

      if (convAbierta) {
        conversationId = convAbierta.id;
      } else {
        const resConv = await fetch(
          `${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          }
        );

        const dataConv = await resConv.json();
        conversationId = dataConv.id;
      }

      // 🔹 Guardamos conversationId en memoria
      session.conversationId = conversationId;
      await updateSession(telefono, session);
    }

    // 🔹 Enviar mensaje
    await fetch(
      `${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${sourceId}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: mensajeTexto,
          message_type: tipo,
        }),
      }
    );

    console.log(`✅ ${telLimpio} → conversación ${conversationId}`);

  } catch (error) {
    console.error("❌ Error en Chatwoot:", error.message);
  }
}