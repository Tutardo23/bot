import { getSession, updateSession } from "./memory.js";

const CHATWOOT_URL =
  process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";
const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

export async function enviarAChatwoot(
  telefono,
  mensajeTexto,
  tipo = "incoming",
  session = null
) {
  try {
    if (!INBOX_TOKEN) return;

    let telLimpio = telefono.replace(/\D/g, "");

    if (telLimpio.startsWith("549")) {
      telLimpio = "54" + telLimpio.substring(3);
    }

    // Crear contacto
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

    if (!sourceId) {
      console.log("❌ No sourceId");
      return;
    }

    let conversationId = session?.conversationId;

    if (!conversationId) {
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

      if (session) {
        session.conversationId = conversationId;
        await updateSession(telefono, session);
      }
    }

    // Enviar mensaje SIEMPRE
    const resMsg = await fetch(
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

    console.log("Mensaje status:", resMsg.status);

    // 🔥 DESASIGNACIÓN SEGURA
    if (tipo === "outgoing") {
      try {
        const resAssign = await fetch(
          `${CHATWOOT_URL}/api/v1/accounts/${process.env.CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/assignments`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "api_access_token": process.env.CHATWOOT_ACCESS_TOKEN,
            },
            body: JSON.stringify({
              assignee_id: null,
            }),
          }
        );

        console.log("Desasignación status:", resAssign.status);
      } catch (err) {
        console.log("⚠️ Falló desasignación pero mensaje enviado");
      }
    }

    console.log(`✅ ${telLimpio} → conversación ${conversationId}`);
  } catch (error) {
    console.error("❌ Error en Chatwoot:", error.message);
  }
}