const CHATWOOT_URL =
  process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com";

const INBOX_TOKEN = process.env.CHATWOOT_INBOX_TOKEN;

export async function enviarAChatwoot(
  telefono,
  mensajeTexto,
  tipo = "incoming"
) {
  try {
    if (!INBOX_TOKEN) {
      console.log("❌ No hay INBOX_TOKEN");
      return;
    }

    // 🔹 Normalizar número
    let telLimpio = telefono.replace(/\D/g, "");

    if (telLimpio.startsWith("549")) {
      telLimpio = "54" + telLimpio.substring(3);
    }

    // 🔥 Endpoint correcto para Chatwoot Cloud
    const res = await fetch(
      `${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          identifier: telLimpio,
          name: `Padre ${telLimpio}`,
          message: {
            content: mensajeTexto,
            message_type: tipo, // "incoming" o "outgoing"
          },
        }),
      }
    );

    console.log("Mensaje status:", res.status);

    if (!res.ok) {
      const errorText = await res.text();
      console.log("Respuesta error:", errorText);
    } else {
      console.log(`✅ ${telLimpio} enviado correctamente a Chatwoot`);
    }

  } catch (error) {
    console.error("❌ Error en Chatwoot:", error.message);
  }
}