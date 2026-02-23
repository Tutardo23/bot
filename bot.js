export async function handleTestMessage(message) {
  const from = message.from;
  const text = message.text.body;

  // 🔥 1. MANDAMOS EL MENSAJE DEL PADRE A CHATWOOT
  await enviarAChatwoot(from, text, "incoming");

  // Buscamos la memoria en Upstash
  const session = await getSession(from);

  // Si está en modo humano, el bot no hace nada
  if (session.status === "HANDOVER") return null;

  // Limpieza de historial para evitar errores de roles de Gemini
  while (
    session.history &&
    session.history.length > 0 &&
    session.history[0].role === "model"
  ) {
    session.history.shift();
  }

  const fechaActual = new Date().toLocaleString("es-AR", {
    timeZone: "America/Argentina/Tucuman",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "numeric",
  });

  const infoColegio = getContextoActualizado();

  const promptMaestro = `
    INSTRUCCIÓN DE SISTEMA:
    Eres "Pucarito", el Asistente Virtual Oficial del Colegio Pucará.

    📚 TU CEREBRO (FUENTE DE VERDAD):
    """ ${infoColegio} """

    ⏰ CONTEXTO: Fecha/Hora actual: ${fechaActual}.

    💎 REGLAS DE ORO:
    1. 🗣️ Tono WhatsApp con emojis. Párrafos cortos.
    2. 🚫 PROHIBIDO usar asteriscos (*) para negritas.
    3. 🏁 Saludo Inicial: Si saludan, preséntate como Pucarito y ofrece ayuda sobre cuotas, horarios, menú, uniforme y trámites.
    4. 🧠 No inventes datos. Si no sabes, usa el Escudo Suave.
    5. 🛡️ Escudo Suave: "Disculpá, solo sé de cosas del colegio. 🏫 ¿En qué más te ayudo?"

    🚨 PROTOCOLO DE DERIVACIÓN (HANDOVER):
    Si el usuario está enojado o pide hablar con un humano:
    - PASO 1: Pide nombre completo y del alumno.
    - PASO 2: Solo con esos datos, responde ÚNICAMENTE: ACTION_HANDOVER.
  `;

  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
      systemInstruction: {
        role: "system",
        parts: [{ text: promptMaestro }],
      },
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 500,
      },
    });

    const chat = model.startChat({
      history: session.history || [],
    });

    const result = await chat.sendMessage(text);
    const botResponse = result.response.text();

    // 🎯 SI HAY HANDOVER
    if (botResponse.includes("ACTION_HANDOVER")) {
      session.status = "HANDOVER";
      await updateSession(from, session);

      await enviarAChatwoot(
        from,
        "📞 ¡Gracias! Tus datos ya fueron enviados a secretaría. En breve una persona te va a responder por este mismo medio.",
        "incoming"
      );

      return null;
    }

    // 🔥 2. MANDAMOS RESPUESTA DEL BOT A CHATWOOT
    await enviarAChatwoot(from, botResponse, "incoming");

    // Guardamos historial
    const rawHistory = await chat.getHistory();
    session.history = rawHistory.map((msg) => ({
      role: msg.role,
      parts: [{ text: msg.parts[0].text }],
    }));

    if (session.history.length > 14) {
      session.history = session.history.slice(-14);
    }

    await updateSession(from, session);

    return botResponse;

  } catch (error) {
    console.error("❌ Error en la lógica del bot:", error);
    return "Tuve un pequeño micro-corte técnico. ¿Podrías escribirlo de nuevo? 😅";
  }
}