/**
 * Alerta por Telegram cuando falla la IA.
 * Rate-limit: máximo 1 alerta cada 45 min para no spamear (coherente con el cooldown del bot).
 */
import { logger } from '../config.js';

let lastAlertAt = 0;
const COOLDOWN_MS = 45 * 60 * 1000;

function shouldSend() {
  return Date.now() - lastAlertAt > COOLDOWN_MS;
}

/**
 * Envía una alerta por Telegram si han pasado 45 min desde la última.
 * @param {string} message texto de la alerta
 */
export async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || token.startsWith('your_') || chatId.startsWith('your_')) {
    return; // no configurado: se ignora silenciosamente
  }
  if (!shouldSend()) {
    logger.debug({ telem: 'cooldown' }, 'Alerta Telegram en cooldown');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `⚠️ *Pendientes Bot - IA caída*\n\n${message}\n\nRevisa \`pm2 logs whatsapp-pendientes-bot\` y actualiza \`AI_MODEL\` si es necesario.`,
        parse_mode: 'Markdown',
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Error enviando alerta de Telegram');
    } else {
      lastAlertAt = Date.now();
      logger.info({ telem: 'sent' }, 'Alerta de IA enviada por Telegram');
    }
  } catch (err) {
    logger.error({ err }, 'Error de red enviando alerta de Telegram');
  }
}

export default { sendTelegramAlert };
