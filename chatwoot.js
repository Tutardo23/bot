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

    let telLimpio = telefono.replace(/\D/g, "");

    if (telLimpio.startsWith("549")) {
      telLimpio = "54" + telLimpio.substring(3);
    }

    const res = await fetch(
      `${CHATWOOT_URL}/public/api/v1/inboxes/${INBOX_TOKEN}/contacts/${telLimpio}/conversations`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            content: mensajeTexto,
            message_type: tipo,
          },
        }),
      }
    );

    console.log("Mensaje status:", res.status);

    if (!res.ok) {
      const text = await res.text();
      console.log("Error detalle:", text);
    } else {
      console.log(`✅ ${telLimpio} enviado correctamente a Chatwoot`);
    }

  } catch (error) {
    console.error("❌ Error en Chatwoot:", error.message);
  }
}