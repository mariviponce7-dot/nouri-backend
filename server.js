const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
// El perfil personal vive en una variable de entorno de Render (no en el código público).
const USER_PROFILE = process.env.USER_PROFILE || 'Persona adulta que sigue un plan de alimentación indicado por su nutricionista.';

const CRITERIA = `Eres el motor de evaluación nutricional de nouri. Evalúas UNA comida de una persona adulta que sigue el plan de su nutricionista, con foco en una alimentación saludable y sostenible.

REGLAS OBLIGATORIAS
1. La meta diaria es la indicada en el contexto (establecida por su nutricionista). No uses otra meta ni la recalcules.
2. Su actividad física es variable: no asumas ejercicio diario ni descuentes calorías quemadas.
3. Evalúa la comida por su aporte al conjunto de la alimentación del día, no por ingredientes "buenos" o "malos". Ningún alimento es bueno o malo por sí solo.
4. No penalices automáticamente pan blanco, arroz, queso, jugos ni alimentos fritos. Importan la porción, la frecuencia y el contexto del día.
5. Distingue entre una comida realmente desequilibrada (por ejemplo, muy baja en proteína o con una porción muy desproporcionada para el día) y una comida adecuada que solo podría optimizarse.
6. Usa un lenguaje neutral, práctico y basado en evidencia. No moralices ni alarmes; evita palabras como "malo", "culpa", "prohibido" o "trampa".
7. Veredicto: "verde" = comida adecuada (la mayoría de las comidas normales). "amarillo" = solo si hay un desequilibrio real o un ajuste que importe para el día; nunca únicamente por contener jugo, pan blanco o ingredientes refinados. "rojo" = muy raro, solo para una comida claramente desequilibrada.
8. Si el perfil menciona una cirugía bariátrica (manga gástrica), prioriza proteína suficiente, tolerancia digestiva y nutrición adecuada. No des indicaciones médicas; si algo amerita atención, sugiere comentarlo con su equipo de salud.
9. Mejoras: opcionales, como máximo una y solo si de verdad aportan. Si la comida está bien, dilo sin buscar defectos; el campo "tip" puede ir vacío ("").
10. Tus calorías y macros son aproximaciones, no mediciones exactas. Estímalos de forma realista, sin sobreestimar ni subestimar a propósito.`;

function buildPrompt(subject, note, ctx) {
  const target = (ctx && ctx.target) || 1570;
  const protGoal = (ctx && ctx.proteinGoal) || 100;
  const dayContext = ctx
    ? `Antes de esta comida ya registró aprox. ${ctx.kcal || 0} kcal y ${ctx.protein || 0} g de proteína. Meta diaria: ${target} kcal y ${protGoal} g de proteína.`
    : `Meta diaria: ${target} kcal.`;
  const noteText = note && String(note).trim()
    ? `\nAclaración de la persona sobre la comida: "${String(note).trim()}". Tómala en cuenta (por ejemplo, si dice "sin aceite", no asumas grasa de cocción).`
    : '';
  return `${CRITERIA}

PERFIL: ${USER_PROFILE}
CONTEXTO DEL DÍA: ${dayContext}
COMIDA: ${subject}${noteText}

CÁLCULO NUTRICIONAL (obligatorio, ingrediente por ingrediente)
A. Lista cada ingrediente visible en la foto o mencionado por la persona. NO inventes ingredientes, aceite, mantequilla, salsas ni porciones. Si algo pudo usarse pero no se ve ni se indicó (por ejemplo, aceite para freír), NO lo sumes: menciónalo en "uncertainty" e indica que la persona puede aclararlo.
B. Para cada ingrediente da la cantidad en gramos como rango (grams_min, grams_max), justificada con referencias visibles (tamaño del plato o de los cubiertos, unidades contables como huevos o rebanadas) o con lo que indicó la persona. Si la persona dio la cantidad exacta, grams_min = grams_max. Si no hay referencia para estimarla, usa un rango amplio y certainty "baja".
C. Indica "state": "crudo" o "cocido" según el estado en que se pesa (o "n/a" para alimentos que no se cocinan, como la fruta fresca) y usa los valores por 100 g de ESE estado. Ejemplo: el arroz cocido aporta ≈130 kcal/100 g y el crudo ≈360 kcal/100 g.
D. "per100" = kcal, protein, carbs y fat por 100 g según tablas estándar de composición de alimentos (como USDA). Deben ser coherentes entre sí: kcal ≈ 4×proteína + 4×carbohidratos + 9×grasa (con tolerancia por fibra y agua).
E. NO calcules totales ni uses una cifra fija por plato: el sistema suma ingrediente por ingrediente.

Responde SOLO con JSON válido, sin texto extra ni markdown:
{"name":"nombre del plato","ingredients":[{"name":"ingrediente","grams_min":número,"grams_max":número,"state":"crudo|cocido|n/a","certainty":"alta|media|baja","how":"en qué se basa la cantidad","per100":{"kcal":número,"protein":número,"carbs":número,"fat":número}}],"uncertainty":"qué no se puede determinar y por qué (cadena vacía si todo es claro)","verdict":"verde|amarillo|rojo","comment":"evaluación breve, neutral y práctica en español (máx 2 oraciones)","tip":"mejora opcional en 1 oración, o cadena vacía si no hace falta"}

Si no es comida o no tiene sentido: {"error":"no es comida"}`;
}

async function callClaude(messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'API error');
  const text = (data.content || []).find(b => b.type === 'text')?.text || '';
  const match = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Respuesta no válida');
  return JSON.parse(match[0]);
}

// Suma ingrediente por ingrediente (el modelo NO calcula totales) y verifica coherencia.
function compute(d) {
  if (!Array.isArray(d.ingredients) || d.ingredients.length === 0) throw new Error('Sin ingredientes');
  const keys = ['kcal', 'protein', 'carbs', 'fat'];
  const zero = () => ({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  const tot = { min: zero(), max: zero() };
  const notes = [];
  const items = d.ingredients.map(it => {
    const p = it.per100 || {};
    const v = {};
    keys.forEach(k => { v[k] = Number(p[k]); });
    const gmin = Number(it.grams_min);
    const gmax = it.grams_max == null ? gmin : Number(it.grams_max);
    if (keys.some(k => !isFinite(v[k]) || v[k] < 0) || !isFinite(gmin) || !isFinite(gmax) || gmin < 0 || gmax < gmin) {
      throw new Error('Datos de ingrediente no válidos');
    }
    const atw = 4 * v.protein + 4 * v.carbs + 9 * v.fat;
    if (v.kcal > 40 && Math.abs(atw - v.kcal) / v.kcal > 0.2) {
      notes.push(`${it.name}: ${v.kcal} kcal/100 g, pero sus macros suman ${Math.round(atw)}`);
    }
    keys.forEach(k => { tot.min[k] += v[k] * gmin / 100; tot.max[k] += v[k] * gmax / 100; });
    return {
      name: String(it.name || 'Ingrediente'), grams_min: gmin, grams_max: gmax,
      state: it.state || 'n/a', certainty: it.certainty || 'media', how: it.how || '',
      kcal_min: v.kcal * gmin / 100, kcal_max: v.kcal * gmax / 100,
    };
  });
  const mid = k => (tot.min[k] + tot.max[k]) / 2;
  const atwTotal = 4 * mid('protein') + 4 * mid('carbs') + 9 * mid('fat');
  if (mid('kcal') > 0 && Math.abs(atwTotal - mid('kcal')) / mid('kcal') > 0.15) {
    notes.push(`Las calorías (${Math.round(mid('kcal'))}) y los macros (${Math.round(atwTotal)} kcal) difieren más de 15 %`);
  }
  return { ok: notes.length === 0, notes, tot, mid, atwTotal, items };
}

function safeCompute(d) {
  try { return compute(d); } catch (e) { return { ok: false, invalid: true, notes: [e.message] }; }
}

function format(d, c) {
  const r = n => Math.round(n);
  return {
    name: d.name,
    cal: r(c.mid('kcal')), cal_min: r(c.tot.min.kcal), cal_max: r(c.tot.max.kcal),
    protein: r(c.mid('protein')), carbs: r(c.mid('carbs')), fat: r(c.mid('fat')),
    verdict: d.verdict, comment: d.comment, tip: d.tip || '', uncertainty: d.uncertainty || '',
    breakdown: c.items.map(i => ({ ...i, grams_min: r(i.grams_min), grams_max: r(i.grams_max), kcal_min: r(i.kcal_min), kcal_max: r(i.kcal_max) })),
    coherence: { ok: c.ok, kcalFromMacros: r(c.atwTotal), notes: c.notes },
  };
}

async function evaluate(content) {
  const messages = [{ role: 'user', content }];
  let draft = await callClaude(messages);
  if (draft.error) return draft;
  let calc = safeCompute(draft);
  if (!calc.ok) {
    try {
      const retry = await callClaude([
        ...messages,
        { role: 'assistant', content: JSON.stringify(draft) },
        { role: 'user', content: `Las cifras no son coherentes (${calc.notes.join('; ')}). Revisa los valores por 100 g, el estado crudo/cocido y los gramos, y devuelve el JSON completo corregido con el mismo formato.` },
      ]);
      if (!retry.error) {
        const c2 = safeCompute(retry);
        if (!c2.invalid) { draft = retry; calc = c2; }
      }
    } catch (e) { console.error('Retry failed:', e.message); }
  }
  if (calc.invalid) throw new Error('No pude calcular el desglose');
  return format(draft, calc);
}

app.post('/analyze', async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: 'API key not configured on server' });
    const { image, media_type, note, context } = req.body;
    const prompt = buildPrompt('la que aparece en la foto adjunta', note, context);
    res.json(await evaluate([
      { type: 'image', source: { type: 'base64', media_type, data: image } },
      { type: 'text', text: prompt },
    ]));
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/analyze-text', async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ error: 'API key not configured on server' });
    const { description, context } = req.body;
    const prompt = buildPrompt(`descrita por la persona: "${String(description || '').slice(0, 500)}". Usa solo las cantidades que ella indicó; si no indicó una, estima con unidades estándar en un rango y márcalo con certainty "baja"`, '', context);
    res.json(await evaluate(prompt));
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
