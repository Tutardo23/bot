import { getSession, updateSession } from "../memory.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ message: "Method not allowed" });
    }

    const body = req.body;

    console.log("Webhook recibido:", body.event);

    // 🔥 Detectamos cuando la conversación se resuelve
    if (
      body.event === "conversation_status_changed" &&
      body.status === "resolved"
    ) {
      const telefono = body.conversation?.meta?.sender?.phone_number;

      if (telefono) {
        const session = await getSession(telefono);
        session.status = "ACTIVE";
        await updateSession(telefono, session);

        console.log("🤖 Bot reactivado automáticamente para:", telefono);
      }
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("Error en webhook:", error);
    return res.status(500).json({ error: "Webhook error" });
  }
}