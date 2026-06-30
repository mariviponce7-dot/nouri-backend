const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

app.post('/analyze', async (req, res) => {
  try {
    const { image, media_type } = req.body;

    if (!API_KEY) {
      return res.status(500).json({ error: 'API key not configured on server' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type, data: image } },
            { type: 'text', text: `Analiza esta foto de comida. La persona: 80kg, 1.72m, 36 años, box 2x/semana, meta bajar de peso, 1420 kcal/día.

Responde SOLO JSON válido, sin texto extra ni markdown:
{"name":"nombre del plato","cal":número,"protein":gramos,"carbs":gramos,"fat":gramos,"verdict":"verde|amarillo|rojo","comment":"feedback corto honesto en español máx 2 oraciones","tip":"tip práctico personalizado máx 1 oración"}

Si no es comida: {"error":"no es comida"}` }
          ]
        }]
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('Anthropic API error:', data.error);
      return res.status(500).json({ error: data.error.message || 'API error' });
    }

    const text = data.content?.find(b => b.type === 'text')?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    res.json(parsed);
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('nouri backend is running ✅');
});

app.listen(PORT, () => {
  console.log(`nouri backend listening on port ${PORT}`);
});
