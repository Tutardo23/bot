import { updateSession } from "./memory.js";

const ACCESS_TOKEN = process.env.CHATWOOT_ACCESS_TOKEN;
const ACCOUNT_ID = "76081"; // Sacado de tu URL de Chatwoot
const INBOX_ID = "150035";   // Sacado de tu configuración de bandeja

export async function enviarAChatwoot(telefono, mensajeTexto, tipo = "incoming", session = null) {
  try {
    if (!ACCESS_TOKEN) return;

    // Normalización de número
    let telLimpio = telefono.replace(/\D/g, "");
    if (telLimpio.startsWith("549")) telLimpio = "54" + telLimpio.substring(3);

    // 1. Buscar o crear contacto
    const resBusqueda = await fetch(`https://app.chatwoot.com/api/v1/accounts/${ACCOUNT_ID}/contacts/search?q=${telLimpio}`, {
        headers: { "api_access_token": ACCESS_TOKEN }
    });
    const dataBusqueda = await resBusqueda.json();
    
    let contactId;
    if (dataBusqueda.payload && dataBusqueda.payload.length > 0) {
        contactId = dataBusqueda.payload[0].id;
    } else {
        const resNuevo = await fetch(`https://app.chatwoot.com/api/v1/accounts/${ACCOUNT_ID}/contacts`, {
            method: 'POST',
            headers: { "Content-Type": "application/json", "api_access_token": ACCESS_TOKEN },
            body: JSON.stringify({ name: `Padre ${telLimpio}`, phone_number: `+${telLimpio}`, inbox_id: INBOX_ID })
        });
        const dataNuevo = await resNuevo.json();
        contactId = dataNuevo.payload.contact.id;
    }

    // 2. Buscar o crear conversación
    let conversationId = session?.conversationId;

    if (!conversationId) {
        const resConv = await fetch(`https://app.chatwoot.com/api/v1/accounts/${ACCOUNT_ID}/contacts/${contactId}/conversations`, {
            headers: { "api_access_token": ACCESS_TOKEN }
        });
        const convs = await resConv.json();
        const abierta = convs.payload ? convs.payload.find(c => c.status !== "resolved") : null;

        if (abierta) {
            conversationId = abierta.id;
        } else {
            const resNuevaConv = await fetch(`https://app.chatwoot.com/api/v1/accounts/${ACCOUNT_ID}/conversations`, {
                method: 'POST',
                headers: { "Content-Type": "application/json", "api_access_token": ACCESS_TOKEN },
                body: JSON.stringify({ source_id: telLimpio, contact_id: contactId, inbox_id: INBOX_ID })
            });
            const dataNuevaConv = await resNuevaConv.json();
            conversationId = dataNuevaConv.id;
        }

        if (session && conversationId) {
            session.conversationId = conversationId;
            await updateSession(telefono, session);
        }
    }

    // 3. Enviar mensaje
    await fetch(`https://app.chatwoot.com/api/v1/accounts/${ACCOUNT_ID}/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { "Content-Type": "application/json", "api_access_token": ACCESS_TOKEN },
        body: JSON.stringify({ 
            content: mensajeTexto, 
            message_type: tipo === "incoming" ? 0 : 1 
        })
    });

    console.log(`✅ Sincronizado en Chatwoot: ${conversationId}`);
  } catch (error) {
    console.error("❌ Error API Agente:", error.message);
  }
}