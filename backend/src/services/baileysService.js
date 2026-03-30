// src/services/baileysService.js
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path  = require('path');
const fs    = require('fs');
const logger = require('../utils/logger');

let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected';
let ioInstance = null;

const AUTH_FOLDER = path.resolve('./baileys_auth');

async function iniciarBaileys(io) {
  ioInstance = io;
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

  // Si existe creds.json pero la sesión está cerrada, limpiar para forzar nuevo QR
  const credsPath = path.join(AUTH_FOLDER, 'creds.json');
  if (fs.existsSync(credsPath)) {
    try {
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
      if (!creds?.me?.id) {
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        logger.info('🧹 Credenciales inválidas limpiadas — generando nuevo QR');
      }
    } catch(e) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: require('pino')({ level: 'silent' }),
    browser: ['IG Accounting', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = qr;
      connectionStatus = 'connecting';
      logger.info('📱 QR generado — escanea desde el panel');

      const qrTerminal = require('qrcode-terminal');
      qrTerminal.generate(qr, { small: true });

      if (ioInstance) {
        ioInstance.emit('wa_qr', { qr });
        ioInstance.emit('wa_status', { status: 'connecting', qr });
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;

      connectionStatus = 'disconnected';
      qrCode = null;
      logger.warn(`⚠️ Conexión cerrada — reconectar: ${shouldReconnect}`);

      if (ioInstance) {
        ioInstance.emit('wa_status', { status: 'disconnected' });
      }

      if (shouldReconnect) {
        setTimeout(() => iniciarBaileys(ioInstance), 3000);
      } else {
        // loggedOut — limpiar credenciales para permitir nuevo QR
        try {
          fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          fs.mkdirSync(AUTH_FOLDER, { recursive: true });
          logger.info('🧹 Sesión cerrada — credenciales limpiadas');
        } catch(e) {}
        setTimeout(() => iniciarBaileys(ioInstance), 3000);
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      qrCode = null;
      logger.info('✅ WhatsApp conectado via Baileys');
      if (ioInstance) {
        ioInstance.emit('wa_status', { status: 'connected' });
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;
      try {
        await procesarMensajeEntrante(msg);
      } catch (err) {
        logger.error('Error procesando mensaje Baileys:', err.message);
      }
    }
  });

  return sock;
}

async function procesarMensajeEntrante(msg) {
  const { procesarMensajeBaileys } = require('../controllers/webhookController');
  await procesarMensajeBaileys(msg, sock, ioInstance);
}

async function enviarTexto(telefono, texto) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp no está conectado');
  }
  const jid = telefono.includes('@') ? telefono : formatearJID(telefono);
  logger.info(`Enviando a JID: ${jid}`);
  await sock.sendMessage(jid, { text: texto });
  logger.info(`✅ Mensaje enviado a ${jid}`);
  return { success: true };
}

async function enviarArchivo(telefono, buffer, mimeType, nombreArchivo, caption = '') {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp no está conectado');
  }
  const jid = formatearJID(telefono);
  const esImagen = mimeType.startsWith('image/');
  if (esImagen) {
    await sock.sendMessage(jid, { image: buffer, caption, mimetype: mimeType });
  } else {
    await sock.sendMessage(jid, { document: buffer, mimetype: mimeType, fileName: nombreArchivo, caption });
  }
  return { success: true };
}

async function descargarMedia(msg) {
  const { downloadMediaMessage } = require('@whiskeysockets/baileys');
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    return buffer;
  } catch (err) {
    logger.error('Error descargando media Baileys:', err.message);
    return null;
  }
}

function formatearJID(telefono) {
  if (telefono.includes('@')) return telefono;
  const limpio = telefono.replace(/\D/g, '');
  return `${limpio}@s.whatsapp.net`;
}

function getStatus() {
  return { status: connectionStatus, qr: qrCode };
}

function getSocket() {
  return sock;
}

module.exports = { iniciarBaileys, enviarTexto, enviarArchivo, descargarMedia, getStatus, getSocket, formatearJID };