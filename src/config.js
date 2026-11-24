import 'dotenv/config';
import pino from 'pino';
import path from 'node:path';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Variables de entorno que el bot necesita para funcionar.
const required = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'AI_PROVIDER',
  'AI_API_KEY',
  'AI_MODEL',
];

// BOARD_GROUP_JID se obtiene con el comando !id después de vincular el número,
// por eso no es obligatorio en el primer arranque.
if (!process.env.BOARD_GROUP_JID) {
  logger.warn('BOARD_GROUP_JID vacío: se obtiene con !id. El bot arranca en modo vinculación.');
}

for (const key of required) {
  if (!process.env[key]) {
    logger.error({ key }, `Variable de entorno requerida faltante: ${key}`);
    process.exit(1);
  }
}

// carpeta donde guarda la sesión de Baileys (índole de .gitignore)
const SESSION_DIR = path.join(process.cwd(), 'auth_info');

export { logger, required, SESSION_DIR };
