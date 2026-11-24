/**
 * Normaliza un texto: pasa a minúsculas, elimina acentos y ñ.
 * Útil para comparar menciones, comandos y palabras clave de forma insensible.
 */
export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[́-ͯ]/g, '')
    .replace(/ñ/g, 'n')
    .trim();
}

/**
 * Extrae el texto legible de un mensaje de WhatsApp (sin descargar multimedia).
 * Según la spec: conversation, extendedTextMessage.text, caption (imagen/video).
 */
export function extractText(message) {
  const m = message || {};
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  return '';
}

/**
 * True si el JID deBaileys es de grupo (@g.us).
 */
export function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

/**
 * True si el JID es de WhatsApp Cloud (vs LID). Both forms exist; comparison is on exact string.
 */
export function isWhatsappJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net');
}

/**
 * Nombre de displays a mostrar: intenta obtener el nombre del contacto del store
 * de Baileys; si no está, usa el JID en bruto.
 */
export function displayName(sock, jid) {
  if (!jid) return '';
  try {
    const contact = sock.getContact?.(jid)?.name;
    return contact || jid;
  } catch {
    return jid;
  }
}
