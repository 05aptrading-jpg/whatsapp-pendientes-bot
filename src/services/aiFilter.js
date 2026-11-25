import { logger } from '../config.js';
import { sendTelegramAlert } from '../utils/telegramAlert.js';

/**
 * System prompt del filtro de incidentes.
 * Llm evalúa el mensaje completo y responde EXCLUSIVAMENTE con un JSON estricto.
 * EL LLM DECIDE TODO: si es problema, el área, el resumen, el motivo de descarte.
 * Esto hace el sistema robusto ante infinitas variantes de escritura de 16 personas.
 */
const SYSTEM_PROMPT = [
  'Eres un analista operativo para el sistema de incidentes WhatsApp. Tu trabajo es evaluar cada mensaje y clasificarlo.',
  '',
  '### Tareas principales (LLM debe decidir todas):',
  '1. ¿ES PROBLEMA? Clasifica si el mensaje representa un problema real, falla, bloqueo, solicitud de acción o pendiente operativo.',
  '   - SÍ: hay fallas técnicas, bloqueos, solicitudes de ayuda con acción clara, errores de equipos, quejas con seguimiento necesario.',
  '   - NO: saludos, cortesías, charla casual, avisos informativos resueltos, preguntas triviales, memes sin acción.',
  '',
  '2. ÁREA RESPONSABLE Si es problema, ¿qué área? Usa estos prefijos (o variantes naturales):',
  '   - "QA:" o variantes -> "Calidad"',
  '   - "PE:" o variantes -> "Producto"',
  '   - "MFG:" o variantes -> "Manufactura"',
  '   - Si no menciona área explícita, pero el problema es obvio para ese departamento, usa el más probable.',
  '   - Si realmente no se puede determinar, "" (cadena vacía).',
  '',
  '3. PROBLEMA RESUMEN Si es problema, describe el problema principal en 4-15 palabras, español neutro, sin saludos ni muletillas.',
  '   - Ejemplo: "Falla de impresión en caja 2" (no "Hola equipo, oigan perdón la molestia pero...").',
  '   - Máximo 120 caracteres.',
  '',
  '4. MOTIVO DESCARTE Si NO es problema, ¿por qué? Usa una de estas categorías:',
  '   - "saludo_o_cortesia"',
  '   - "charla_casual"',
  '   - "aviso_resuelto"',
  '   - "pregunta_trivial"',
  '   - "otro"',
  '',
  '### Salida JSON obligatoria (sin markdown, sin texto adicional):',
  '{',
  '  "es_problema": boolean,',
  '  "area_responsable": "Calidad" | "Producto" | "Manufactura" | "",',
  '  "problema_resumen": string | null,',
  '  "motivo_descarte": string | null,',
  '}',
  '',
  '### Reglas estrictas de salida:',
  '- Responde SIEMPRE con JSON válido, nada fuera.',
  '- No uses bloques ```json``` ni explicaciones.',
  '- Si no estás seguro de algún campo, usa valor vacío "" o null, pero cumple el JSON.',
  '- El campo `es_problema` es la decisión principal: si es false, los otros campos deben reflejar por qué.',
].join('\n');

const TIMEOUT_MS = 8000; // Skill: timeout máximo de petición HTTP = 8 segundos
const MAX_RAW_CHARS = 1000; // Skill: truncar raw_message a los primeros 1,000 caracteres

/**
 * Filtra un mensaje de WhatsApp.
 * @param {string} rawMessage texto extraído del mensaje
 * @param {Object} ctx { source_group_name, sender_name, is_sender_whitelisted, has_whitelisted_mention }
 * @returns {Promise<{es_problema: boolean, problema_resumen: string|null, motivo_descarte: string|null, area_responsable: string, origen?: string}>}
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
        area_responsable: '',
        origen: 'hashtag',
      };
    }
    return { es_problema: false, problema_resumen: null, area_responsable: '', motivo_descarte: 'hashtag_sin_descripcion', origen: 'hashtag' };
  }

  // Skill sección 5.4: mensajes muy cortos sin #reporte.
  if (trimmed.length < 6) {
    return { es_problema: false, problema_resumen: null, area_responsable: '', motivo_descarte: 'mensaje_muy_corto', origen: 'corto' };
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
    'Grupo origen: ' + (ctx.source_group_name ?? ''),
    'Remitente: ' + (ctx.sender_name ?? ''),
    '¿Es miembro de lista blanca?: ' + (ctx.is_sender_whitelisted === true),
    '¿Etiquetaron a alguien de lista blanca?: ' + (ctx.has_whitelisted_mention === true),
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
  const area_responsable = typeof parsed.area_responsable === 'string' ? parsed.area_responsable.trim() : '';
  const problema_resumen = typeof parsed.problema_resumen === 'string' ? parsed.problema_resumen : null;
  const motivo_descarte = typeof parsed.motivo_descarte === 'string' ? parsed.motivo_descarte : null;

  if (es_problema && !problema_resumen) return null; // Skill: fallback conservador

  return {
    es_problema,
    problema_resumen: es_problema ? problema_resumen : null,
    motivo_descarte: es_problema ? null : motivo_descarte || 'no_problema_ia',
    area_responsable,
    origen: parsed.origen || '',
  };
}

function conservativeFallback(raw, ctx) {
  // Skill sección 5.2: fallback seguro - no tirar el bot por error de IA
  const text = String(raw ?? '');
  // Respaldo conservador: si el remitente está en la lista blanca y el mensaje
  // tiene contenido, se crea el pendiente aunque la IA falle. Esto evita perder
  // urgencias reales cuando las menciones @ no llegan como mentionedJid
  // estructurado (común en WhatsApp) o la API de IA está caída.
  // Pero nunca crear pendiente si es solo saludo/cortesía.
  // El LLM ya debería haber decidido esto, pero por seguridad:
  if (ctx.is_sender_whitelisted === true && text.length > 15) {
    return {
      es_problema: true,
      problema_resumen: text.slice(0, 110) + ' [Sin filtrar por IA]',
      area_responsable: '',
      motivo_descarte: null,
      origen: 'fallback_ia_error',
    };
  }
  return { es_problema: false, problema_resumen: null, area_responsable: '', motivo_descarte: 'error_api_ia', origen: 'ia_fallida' };
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
  void sendTelegramAlert(
    `Todas las claves de IA (${keys.length}) fallaron con el proveedor *${provider}*.\nÚltimo error: ${lastErr?.message ?? 'desconocido'}`,
  );
  return null;
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

/**
 * Detecta si un mensaje es SOLO saludo/cortesía sin acción requerida.
 * Ya no se usa como filtro previo - el LLM decide eso ahora.
 * Mantener solo por si se necesita para logging interno.
 * @param {string} texto 
 */
function esSaludoOCortesia(texto) {
  const t = String(texto ?? '')
    .toLowerCase()
    .replace(/@\S+/g, '') // quitar menciones @usuario
    .replace(/[👍👌🙏😊😄😃❤️🙌😁😎✅✔️]/g, '') // quitar emojis comunes
    .replace(/[.,;:¡¿!?()\-_]/g, ' ') // quitar puntuación
    .replace(/\s+/g, ' ')
    .trim();

  if (!t || t.length < 2) return true; // vacío o solo emojis/menciones

  const saludos = [
    'hola', 'buenos dias', 'buen dia', 'buenas tardes', 'buenas noches',
    'saludos', 'saludo', 'gracia', 'gracias', 'gracías', 'muchas gracias',
    'ok', 'oké', 'okay', 'listo', 'va', 'enterado', 'si', 'sí', 'sii',
    'bendiciones', 'que estén bien', 'que esten bien', 'dios los bendiga',
    'buen martes', 'buen miercoles', 'buen jueves', 'buen viernes', 'buen sabado', 'buen domingo',
    'buen lunes', 'buen dia a todos', 'buenas a todos',
  ];

  const palabras = t.split(/\s+/).filter(Boolean);
  // Si TODAS las palabras son saludos/cortesías, es un mensaje sin acción
  return palabras.every(p => saludos.includes(p));
}

export default { filterMessage, SYSTEM_PROMPT };