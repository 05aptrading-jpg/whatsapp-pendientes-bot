import { logger } from '../config.js';

/**
 * System prompt del filtro de incidentes (espejo de skills/incident_filter.md).
 * Llm responde EXCLUSIVAMENTE con un JSON estricto.
 */
const SYSTEM_PROMPT = [
  'Eres un analista operativo encargado de filtrar mensajes de grupos de WhatsApp para detectar únicamente problemas reales, fallas, bloqueos o solicitudes pendientes que requieran atención.',
  '',
  'Tu tarea es analizar el mensaje recibido y responder EXCLUSIVAMENTE con un objeto JSON válido, sin texto adicional, sin bloques markdown (```json) y sin explicaciones fuera del JSON.',
  '',
  '### Criterios para clasificar como `es_problema: true`',
  '1. Reportes de fallas técnicas, errores de sistema, caídas de servicio o equipos dañados.',
  '2. Bloqueos operativos, retrasos críticos, falta de insumos o incidencias con clientes/proveedores.',
  '3. Solicitudes directas de acción, revisión urgente o soporte dirigidas a alguien del equipo (especialmente cuando etiquetan con @usuario).',
  '4. Quejas o alertas que requieran seguimiento hasta resolverse.',
  '',
  '### Criterios para clasificar como `es_problema: false` (DESCARTAR)',
  '1. Saludos, despedidas o cortesías ("buenos días", "gracias", "ok", "enterado", "listo", "va", "👍").',
  '2. Charla casual, bromas, memes o comentarios sin acción requerida.',
  '3. Mensajes donde solo se etiqueta a alguien sin explicar ningún problema ni pedir algo (ej. "@Juan mira esto" sin más contexto).',
  '4. Avisos meramente informativos de algo que ya quedó resuelto y no requiere seguimiento (ej. "ya quedó reiniciado el servidor, todo bien").',
  '5. Preguntas triviales de coordinación general que no representan un problema ni pendiente operativo (ej. "¿a qué hora es la junta?").',
  '',
  '### Reglas para redactar `problema_resumen` (cuando `es_problema` es `true`)',
  '- Debe describir únicamente el **problema principal** de forma directa, objetiva y accionable.',
  '- Elimina saludos, muletillas, relleno emocional y menciones innecesarias (ej. de "Hola equipo, oigan perdón la molestia pero fíjense que desde hace rato no imprime la factura en caja 2" -> "Falla de impresión de facturas en caja 2").',
  '- Longitud estricta: entre 4 y 15 palabras (máximo 120 caracteres).',
  '- Escribe siempre en español neutro y claro.',
  '',
  '### Formato de salida obligatorio (JSON estricto)',
  '{',
  '  "es_problema": boolean,',
  '  "problema_resumen": string | null,',
  '  "motivo_descarte": string | null',
  '}',
].join('\n');

const TIMEOUT_MS = 8000; // Skill: timeout máximo de petición HTTP = 8 segundos
const MAX_RAW_CHARS = 1000; // Skill: truncar raw_message a los primeros 1,000 caracteres

/**
 * Filtra un mensaje de WhatsApp.
 * @param {string} rawMessage texto extraído del mensaje
 * @param {Object} ctx { source_group_name, sender_name, is_sender_whitelisted, has_whitelisted_mention }
 * @returns {Promise<{es_problema: boolean, problema_resumen: string|null, motivo_descarte: string|null, origen?: string}>}
 */
export async function filterMessage(rawMessage, ctx = {}) {
  const raw = String(rawMessage ?? '');
  const trimmed = raw.trim();

  // Bypass deterministista (#reporte) - Skill sección 2.
  if (trimmed.toLowerCase().includes('#reporte')) {
    const clean = trimmed.replace(/#reporte/gi, '').replace(/\s+/g, ' ').trim();
    if (clean.length >= 3) {
      return {
        es_problema: true,
        problema_resumen: clean.slice(0, 120),
        motivo_descarte: null,
        origen: 'hashtag',
      };
    }
    return { es_problema: false, problema_resumen: null, motivo_descarte: 'hashtag_sin_descripcion' };
  }

  // Skill sección 5.4: mensajes muy cortos sin #reporte.
  if (trimmed.length < 6) {
    return { es_problema: false, problema_resumen: null, motivo_descarte: 'mensaje_muy_corto' };
  }

  // Llamada al LLM con el payload de entrada definido en el Skill sección 4.
  const userPayload = buildUserPayload(ctx, raw.slice(0, MAX_RAW_CHARS));
  const rawText = await callAi(userPayload);
  if (rawText === null) return conservativeFallback(raw, ctx);

  const parsed = parseFilterResponse(rawText);
  if (!parsed) return conservativeFallback(raw, ctx);
  return parsed;
}

function buildUserPayload(ctx, raw) {
  return [
    `Grupo origen: ${ctx.source_group_name ?? ''}`,
    `Remitente: ${ctx.sender_name ?? ''}`,
    `¿Es miembro de lista blanca?: ${ctx.is_sender_whitelisted === true}`,
    `¿Etiquetaron a alguien de lista blanca?: ${ctx.has_whitelisted_mention === true}`,
    'Mensaje:',
    '"""',
    raw,
    '"""',
  ].join('\n');
}

function parseFilterResponse(rawText) {
  // Skill sección 5.1: limpiar envoltorio markdown
  const text = String(rawText || '').replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger.warn({ preview: text.slice(0, 200) }, 'JSON malformado del LLM del filtro');
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const es_problema = parsed.es_problema === true;
  const problema_resumen = typeof parsed.problema_resumen === 'string' ? parsed.problema_resumen : null;
  const motivo_descarte = typeof parsed.motivo_descarte === 'string' ? parsed.motivo_descarte : null;

  if (es_problema && !problema_resumen) return null; // Skill: fallback conservador

  return {
    es_problema,
    problema_resumen: es_problema ? problema_resumen : null,
    motivo_descarte: es_problema ? null : motivo_descarte || 'no_problema_ia',
  };
}

function conservativeFallback(raw, ctx) {
  // Skill sección 5.2: fallback seguro - no tirar el bot por error de IA
  const text = String(raw ?? '');
  if (ctx.has_whitelisted_mention === true && text.length > 15) {
    return {
      es_problema: true,
      problema_resumen: text.slice(0, 110) + ' [Sin filtrar por IA]',
      motivo_descarte: null,
      origen: 'fallback_ia_error',
    };
  }
  return { es_problema: false, problema_resumen: null, motivo_descarte: 'error_api_ia' };
}

/**
 * Claves de la API del proveedor activo: AI_API_KEY, AI_API_KEY_2, AI_API_KEY_3...
 * Se usan en orden; si una falla (429/5xx/red), se pasa a la siguiente.
 */
function getApiKeys() {
  const keys = [];
  if (process.env.AI_API_KEY) keys.push(process.env.AI_API_KEY);
  for (let i = 2; ; i += 1) {
    const key = process.env[`AI_API_KEY_${i}`];
    if (!key) break;
    keys.push(key);
  }
  return [...new Set(keys)];
}

async function callAi(userPayload) {
  const provider = process.env.AI_PROVIDER;
  if (provider !== 'groq' && provider !== 'gemini') {
    logger.error({ provider }, 'AI_PROVIDER no reconocido');
    return null;
  }

  const keys = getApiKeys();
  if (keys.length === 0) {
    logger.error({ provider }, 'No hay claves de IA (AI_API_KEY, AI_API_KEY_2, ...)');
    return null;
  }

  let lastErr;
  for (const key of keys) {
    try {
      const text = provider === 'groq' ? await callGroq(userPayload, key) : await callGemini(userPayload, key);
      if (text !== null) return text;
      lastErr = new Error('IA devolvió un payload null');
    } catch (err) {
      lastErr = err;
      logger.warn({ err }, `Clave falló, probando la siguiente (${keys.length} disponibles)`);
    }
  }
  logger.error({ provider, totalKeys: keys.length, lastErr }, 'Todas las claves de IA fallaron');
  return null;
}

function startTimeout() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  return { signal: ac.signal, done: () => clearTimeout(timer) };
}

async function callGroq(userPayload, key) {
  const base = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
  const { signal, done } = startTimeout();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.AI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPayload },
        ],
        temperature: 0,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? null;
  } finally {
    done();
  }
}

async function callGemini(userPayload, key) {
  const model = process.env.AI_MODEL || 'gemini-2.0-flash-lite';
  const base = (process.env.AI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
  const { signal, done } = startTimeout();
  try {
    const res = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\n${userPayload}` }] }],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } finally {
    done();
  }
}

export default { filterMessage };
