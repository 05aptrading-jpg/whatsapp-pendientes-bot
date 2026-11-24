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
 * de Baileys (probando @s.whatsapp.net y @lid). Si no está en la agenda, usa
 * solo el número de teléfono limpio (sin @lid ni @s.whatsapp.net).
 */
export function displayName(sock, jid) {
  if (!jid) return '';
  const jidStr = String(jid);
  const numOnly = jidStr.split('@')[0].replace(/\D/g, '');

  // Intentar obtener el nombre probando múltiples formas del JID
  const candidates = [
    jidStr,
    jidStr.replace('@lid', '@s.whatsapp.net'),
    jidStr.replace('@s.whatsapp.net', '@lid'),
    `${numOnly}@s.whatsapp.net`,
    `${numOnly}@lid`,
  ];

  for (const candidate of candidates) {
    try {
      const contact = sock.getContact?.(candidate)?.name;
      if (contact && contact !== candidate) {
        return contact;
      }
    } catch {
      // seguir probando
    }
  }

  // Si no hay nombre en la agenda, devolver solo el número limpio
  return numOnly || jidStr;
}
