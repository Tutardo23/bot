const ACCESS_TOKEN = process.env.CHATWOOT_ACCESS_TOKEN;
const ACCOUNT_ID = "76081"; // ID de tu cuenta
const INBOX_ID = "150035";   // ID de la bandeja Atención Pucará

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming") {
  try {
    // 1. Buscamos si el contacto existe
    const resBusqueda = await fetch(`https://app.chatwoot.com/api/v1/accounts/${ACCOUNT_ID}/contacts/search?q=${telefono}`, {
        headers: { "api_access_token": ACCESS_TOKEN }
    });
    const dataBusqueda = await resBusqueda.json();
    
    let contactId;
    if (dataBusqueda.payload && dataBusqueda.payload.length > 0) {
        contactId = dataBusqueda.payload[0].id;
    } else {
        // Creamos contacto si no existe
        const resNuevo = await fetch(`https://app.chatwoot.com/api/v1/accounts/${ACCOUNT_ID}/contacts`, {
            method: 'POST',
            headers: { "Content-Type": "application/json", "api_access_token": ACCESS_TOKEN },
            body: JSON.stringify({ name: `Padre ${telefono}`, phone_number: `+${telefono}`, inbox_id: INBOX_ID })
        });
        const dataNuevo = await resNuevo.json();
        contactId = dataNuevo.payload.contact.id;
    }

    // 2. Buscamos conversación abierta
    const resConv = await fetch(`https://app.chatwoot.com/api/v1/accounts/${ACCOUNT_ID}/contacts/${contactId}/conversations`, {
        headers: { "api_access_token": ACCESS_TOKEN }
    });
    const conversaciones = await resConv.json();
    
    let conversationId;
    const abierta = conversaciones.payload ? conversaciones.payload.find(c => c.status !== "resolved") : null;

    if (abierta) {
        conversationId = abierta.id;
    } else {
        // Creamos conversación
        const resNuevaConv = await fetch(`https://app.chatwoot.com/api/v1/accounts/${ACCOUNT_ID}/conversations`, {
            method: 'POST',
            headers: { "Content-Type": "application/json", "api_access_token": ACCESS_TOKEN },
            body: JSON.stringify({ source_id: telefono, contact_id: contactId, inbox_id: INBOX_ID })
        });
        const dataNuevaConv = await resNuevaConv.json();
        conversationId = dataNuevaConv.id;
    }

    // 3. Mandamos el mensaje
    await fetch(`https://app.chatwoot.com/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { "Content-Type": "application/json", "api_access_token": ACCESS_TOKEN },
        body: JSON.stringify({ 
            content: mensajeTexto, 
            message_type: tipo === "incoming" ? 0 : 1 // 0=padre, 1=bot
        })
    });

    console.log("✅ Chatwoot Sincronizado");
  } catch (error) {
    console.error("❌ Error Chatwoot:", error.message);
  }
}