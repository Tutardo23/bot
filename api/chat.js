import { handleTestMessage } from "../bot.js";
import { rateLimitKey, sanitizeText } from "../security.js";

export default async function chatRoute(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    await rateLimitKey(req, "chat-local-test", 60, 60_000);

    const message = sanitizeText(req.body?.message || "", 3000);

    if (!message) {
      return res.status(400).json({ ok: false, error: "Mensaje vacío" });
    }

    const userId =
      req.headers["x-test-user"] ||
      req.headers["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      "web-user-local";

    const simulatedMsg = {
      from: String(userId),
      text: { body: message },
    };

    const reply = await handleTestMessage(simulatedMsg);

    return res.status(200).json({
      ok: true,
      reply: reply || "",
    });
  } catch (error) {
    console.error("Error en /api/chat:", error);

    return res.status(error.status || 500).json({
      ok: false,
      error: error.publicMessage || error.message || "Internal Server Error",
    });
  }
}
