// src/services/baileysService.js
// Maneja la conexión WhatsApp via Baileys (QR)
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path  = require('path');
const fs    = require('fs');
const logger = require('../utils/logger');

let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected'; // disconnected | connecting | connected
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
        // Credenciales inválidas, limpiar
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        logger.info('🧹 Credenciales inválidas limpiadas — generando nuevo QR');
      }
    } catch(e) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
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

  // Manejar mensajes entrantes
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue; // ignorar mensajes propios
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
  // Importar aquí para evitar dependencia circular
  const { procesarMensajeBaileys } = require('../controllers/webhookController');
  await procesarMensajeBaileys(msg, sock, ioInstance);
}

async function enviarTexto(telefono, texto) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp no está conectado');
  }
  
  let jid;
  if (telefono.includes('@')) {
    jid = telefono;
  } else {
    // Intentar encontrar el JID correcto en los chats activos
    const limpio = telefono.replace(/\D/g, '');
    jid = `${limpio}@s.whatsapp.net`;
  }
  
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
  // Si ya tiene @, devolverlo tal cual
  if (telefono.includes('@')) return telefono;
  
  // Limpiar y formatear
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