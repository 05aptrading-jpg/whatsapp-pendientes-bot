import { logger, SESSION_DIR } from './config.js';
import { supabase } from './db.js';
import { filterMessage } from './services/aiFilter.js';
import { displayName, extractText, isGroupJid, normalizeText } from './utils/textUtils.js';
import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { mkdirSync, writeFileSync } from 'node:fs';

const BOARD_GROUP_JID = process.env.BOARD_GROUP_JID;

// Cada vez que se genere un código de vinculación se guarda aquí para poder
// leerlo desde fuera sin depender de la consola.
const PAIRING_CODE_FILE = './pairing_code.txt';

// Lista blanca en memoria: JIDs (@s.whatsapp.net o @lid)
const whitelist = new Set();

function addWhitelisted(jid) {
  if (jid) whitelist.add(jid);
}

async function upsertWhitelisted(sock, jid, displayNameOrNull) {
  if (!jid) return;
  await supabase
    .from('whitelist')
    .upsert({ jid, display_name: displayNameOrNull, added_at: new Date().toISOString() }, { onConflict: 'jid' })
    .select('jid')
    .maybeSingle();
  addWhitelisted(jid);
  // Soportar ambos formas de JID en la lista blanca en memoria
  addWhitelisted(displayName(sock, jid));
}

async function removeWhitelisted(jid) {
  if (!jid) return;
  await supabase.from('whitelist').delete().eq('jid', jid);
  whitelist.delete(jid);
}

/**
 * Sincroniza la lista blanca en memoria con la tabla DB.
 */
async function syncWhitelistFromDb() {
  const { data } = await supabase.from('whitelist').select('jid');
  for (const row of data || []) addWhitelisted(row.jid);
  logger.info({ count: whitelist.size }, 'Lista blanca cargada desde DB');
}

/**
 * Carga la lista blanca desde los participantes actuales de `BOARD_GROUP_JID`
 * y sincroniza la tabla `whitelist`.
 */
async function syncWhitelistFromBoardGroup(sock) {
  if (!BOARD_GROUP_JID) {
    logger.warn('Sin BOARD_GROUP_JID: omitiendo sincronización de lista blanca (modo vinculación)');
    return;
  }
  const meta = await sock.groupMetadata(BOARD_GROUP_JID);
  const current = new Set();
  for (const p of meta.participants) {
    current.add(p.id);
    if (p.lid) current.add(p.lid);
    await upsertWhitelisted(sock, p.id, displayName(sock, p.id));
    if (p.lid) await upsertWhitelisted(sock, p.lid, displayName(sock, p.lid));
  }
  // Quitar de la lista DB a los que ya no están en el grupo (ej. left while offline)
  const { data } = await supabase.from('whitelist').select('jid');
  for (const row of data || []) {
    if (!current.has(row.jid)) await removeWhitelisted(row.jid);
  }
  logger.info({ count: whitelist.size }, 'Lista blanca sincronizada con Grupo Tablero');
}

/**
 * Flujo de los mensajes de BOARD_GROUP_JID: cambio de estado por respuestas
 * que citan (`stanzaId`) un mensaje publicado anteriormente.
 */
async function handleBoardMessage(sock, msg, remoteJid) {
  const stanzaId = msg?.message?.contextInfo?.stanzaId;
  if (!stanzaId) return;

  const text = normalizeText(extractText(msg.message));

  const { data: incident } = await supabase
    .from('incidents')
    .select('id, code, board_message_id')
    .eq('board_message_id', stanzaId)
    .maybeSingle();
  if (!incident) return;

  const by = displayName(sock, msg?.key?.participant || remoteJid);
  const quoted = {
    key: {
      id: msg?.key?.id,
      remoteJid: msg?.key?.remoteJid || remoteJid,
      participant: msg?.key?.participant,
      fromMe: msg?.key?.fromMe,
    },
    remoteJid: msg?.key?.remoteJid || remoteJid,
    participants: msg?.key?.participant,
  };

  if (text.includes('cerrado') || text.includes('listo') || text.includes('resuelto')) {
    await supabase
      .from('incidents')
      .update({ status: 'CERRADO', closed_at: new Date().toISOString(), updated_by: by })
      .eq('id', incident.id);
    await sock.sendMessage(BOARD_GROUP_JID, {
      text: `🟢 *[${incident.code}]* actualizado a *CERRADO* por ${by}.`,
      quoted,
    });
    logger.info({ code: incident.code, status: 'CERRADO', by }, 'Pendiente actualizado');
    return;
  }

  if (text.includes('reabierto') || text.includes('reabrir')) {
    await supabase.from('incidents').update({ status: 'REABIERTO', closed_at: null, updated_by: by }).eq('id', incident.id);
    await sock.sendMessage(BOARD_GROUP_JID, {
      text: `🟡 *[${incident.code}]* actualizado a *REABIERTO* por ${by}.`,
      quoted,
    });
    logger.info({ code: incident.code, status: 'REABIERTO', by }, 'Pendiente actualizado');
  }
}

/**
 * Flujo de grupos monitoreados: filtro por IA -> crear incidente -> publicar en
 * el Grupo Tablero.
 */
async function handleGroupMessage(sock, msg, remoteJid) {
  const key = msg?.key || {};
  if (!key.participant) return; // mensaje sin participante (ej. sistema)

  const mentionedJids = msg?.message?.contextInfo?.mentionedJid || [];
  const mentionedWhitelisted = mentionedJids.some((mjid) => whitelist.has(mjid));
  const senderWhitelisted = whitelist.has(key.participant);

  if (!senderWhitelisted && !mentionedWhitelisted) {
    logger.debug({ remoteJid }, 'Descartado: remitente no está en la lista blanca');
    return;
  }

  const ctx = {
    source_group_name: displayName(sock, remoteJid),
    sender_name: displayName(sock, key.participant),
    is_sender_whitelisted: senderWhitelisted,
    has_whitelisted_mention: mentionedWhitelisted,
  };

  const filter = await filterMessage(extractText(msg.message), ctx);
  if (!filter.es_problema) {
    logger.debug({ remoteJid, motivo: filter.motivo_descarte }, 'Descartado por filtro de IA');
    return;
  }

  const code = `INC-${Date.now()}`; // reemplazado por el código real (INC-<id serial>) tras insertar
  const { data: incident, error: dbErr } = await supabase
    .from('incidents')
    .insert({
      code,
      source_group_jid: remoteJid,
      source_group_name: ctx.source_group_name,
      involved_user: ctx.sender_name,
      raw_message: extractText(msg.message),
      problem_summary: filter.problema_resumen,
      status: 'ABIERTO',
    })
    .select('id')
    .maybeSingle();

  if (dbErr || !incident) {
    logger.error({ err: dbErr, remoteJid }, 'Error insertando incidente en Supabase');
    return;
  }

  // Código legible basado en el id serial: INC-101, INC-102, ...
  const realCode = `INC-${incident.id}`;
  await supabase.from('incidents').update({ code: realCode }).eq('id', incident.id);

  const boardText = [
    `🔴 *[${realCode}]* | *Estado:* ABIERTO`,
    `*Grupo:* ${ctx.source_group_name}`,
    `*Involucrado:* ${ctx.sender_name}`,
    `*Problema:* ${filter.problema_resumen}`,
  ].join('\n');

  const { data: sent } = await sock.sendMessage(BOARD_GROUP_JID, { text: boardText });
  const boardMessageId = sent?.key?.id;
  if (boardMessageId) {
    await supabase.from('incidents').update({ board_message_id: boardMessageId }).eq('id', incident.id);
  }
  logger.info({ code: realCode, remoteJid }, 'Pendiente creado y publicado en el Grupo Tablero');
}

/**
 * Comando auxiliar `!id`: responde el `remoteJid` exacto del grupo (consola + PM).
 */
async function handleIdCommand(sock, msg, remoteJid) {
  const sender = msg?.key?.participant || msg?.key?.remoteJid;
  const text = normalizeText(extractText(msg.message));
  if (text !== '!id') return;

  const response = `🆔 RemoteJid del grupo: ${remoteJid}`;
  await sock.sendMessage(sender, { text: response });
  logger.info({ remoteJid }, 'Comando !id ejecutado');
}

async function handleMessage(sock, msg) {
  const key = msg?.key || {};
  const remoteJid = key.remoteJid;
  if (!remoteJid) return;

  // Ignorar privados
  if (!isGroupJid(remoteJid)) return;

  // El Grupo Tablero tiene su propio flujo de cambio de estado
  if (remoteJid === BOARD_GROUP_JID) {
    await handleBoardMessage(sock, msg, remoteJid);
    return;
  }

  // Comando auxiliar !id en grupos
  await handleIdCommand(sock, msg, remoteJid);

  // Grupos monitoreados
  await handleGroupMessage(sock, msg, remoteJid);
}

async function connect() {
  mkdirSync(SESSION_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'error' }),
    browser: Browsers.ubuntu('Chrome'),
  });

  // Código de vinculación (más fácil que escanear QR): PAIRING_PHONE en .env.
  // Baileys necesita que el socket esté listo: se pide ~1.5s tras crearlo
  // (en 'connecting' falla con 428, justo al crearlo con 401).
  if (process.env.PAIRING_PHONE && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(process.env.PAIRING_PHONE);
        writeFileSync(PAIRING_CODE_FILE, code);
        logger.info({ code }, '=== CÓDIGO DE VINCULACIÓN ===');
        console.log(`\n  CÓDIGO DE VINCULACIÓN: ${code}\n`);
      } catch (err) {
        logger.error({ err }, 'Error solicitando código de vinculación');
      }
    }, 1500);
  }

  sock.ev.on('connection.update', async (update) => {
    if (update.qr && !process.env.PAIRING_PHONE) {
      qrcode.generate(update.qr, { small: true });
      logger.info('Escanea el QR desde WhatsApp → Dispositivos vinculados');
    }

    if (update.connection === 'authenticated') {
      logger.info({ me: sock.user?.id }, 'Sesión autenticada');
      await syncWhitelistFromDb();
    }

    if (update.connection === 'open') {
      try {
        await syncWhitelistFromBoardGroup(sock);
      } catch (err) {
        logger.error({ err }, 'Error sincronizando lista blanca con Grupo Tablero');
      }

      sock.ev.on('messages.upsert', ({ messages }) => {
        for (const msg of messages) {
          if (msg.key?.remoteJid) {
            handleMessage(sock, msg).catch((err) => logger.error({ err }, 'Error manejando mensaje'));
          }
        }
      });

      sock.ev.on('group-participants.update', async (update2) => {
        if (update2.groupJid !== BOARD_GROUP_JID) return;
        for (const pjid of update2.participants) {
          if (update2.action === 'add') {
            await upsertWhitelisted(sock, pjid, displayName(sock, pjid));
            if (sock.getContact?.(pjid)?.lid) {
              await upsertWhitelisted(sock, sock.getContact(pjid).lid, displayName(sock, pjid));
            }
          } else if (update2.action === 'remove' || update2.action === 'leave') {
            await removeWhitelisted(pjid);
          }
        }
        logger.info({ action: update2.action }, 'Lista blanca sincronizada (Grupo Tablero)');
      });

      logger.info({ me: sock.user?.id }, 'Bot conectado');
    }

    if (update.connection === 'close') {
      const reason = update.lastDisconnect?.error?.output?.statusCode;
      logger.warn({ reason }, 'Conexión cerrada');
      if (reason !== DisconnectReason.restart) {
        setTimeout(connect, 3000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
  return sock;
}

await connect();

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
