import { handleTestMessage } from '../bot.js'; 

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message } = req.body;
    
    // Obtenemos una ID simple para el usuario web
    const userId = req.headers['x-forwarded-for'] || 'web-user';

    const simulatedMsg = {
      from: userId,
      text: { body: message }
    };

    const reply = await handleTestMessage(simulatedMsg);
    
    return res.status(200).json({ reply });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}