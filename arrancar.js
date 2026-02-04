import express from 'express';
import chatHandler from './api/chat.js'; 

const app = express();

// Permite leer JSON y sirve la carpeta public como página web
app.use(express.json());
app.use(express.static('public'));

// Conectamos la ruta /api/chat con tu código
app.post('/api/chat', async (req, res) => {
    await chatHandler(req, res);
});

app.listen(3000, () => {
    console.log('✅ Bot listo en: http://localhost:3000');
});