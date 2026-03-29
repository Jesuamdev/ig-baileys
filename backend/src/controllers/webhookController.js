// src/controllers/webhookController.js
const { v4: uuidv4 } = require('uuid');
const { query, withTransaction } = require('../models/db');
const storageService = require('../services/storageService');
const { procesarFlujos } = require('../services/flowService');
const logger = require('../utils/logger');

function verificarWebhook(req, res) {
  res.json({ status: 'baileys', message: 'Usando Baileys — webhook Meta no requerido' });
}

async function recibirMensaje(req, res) {
  res.json({ status: 'baileys', message: 'Usando Baileys — webhook Meta no requerido' });
}

// Resolver número de teléfono real desde el JID
async function resolverTelefono(jid, msg, sock) {
  if (jid.endsWith('@g.us')) return null;

  if (jid.endsWith('@s.whatsapp.net')) {
    return jid.replace('@s.whatsapp.net', '');
  }

  if (jid.endsWith('@lid')) {
    const participant = msg.key.participant || msg.participant;
    if (participant && participant.includes('@s.whatsapp.net')) {
      return participant.replace('@s.whatsapp.net', '');
    }
    if (sock) {
      try {
        const result = await sock.onWhatsApp(jid);
        if (result?.[0]?.jid) {
          return result[0].jid.replace('@s.whatsapp.net', '');
        }
      } catch (e) {
        logger.warn(`No se pudo resolver @lid: ${jid}`);
      }
    }
    return jid.replace('@lid', '');
  }

  return jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
}

async function procesarMensajeBaileys(msg, sock, io) {
  try {
    const jid     = msg.key.remoteJid;
    const msgId   = msg.key.id;
    const message = msg.message;

    if (!message || jid.endsWith('@g.us')) return;

    const telefono = await resolverTelefono(jid, msg, sock);
    if (!telefono) return;

    const dup = await query('SELECT id FROM mensajes WHERE whatsapp_message_id = $1', [msgId]);
    if (dup.rows.length) return;

    const tipo           = detectarTipo(message);
    const contenido      = extraerContenido(message, tipo);
    const preview        = tipo !== 'text' ? `📎 ${contenido}` : contenido.substring(0, 100);
    const nombreContacto = msg.pushName || null;

    await withTransaction(async (client) => {

      // 1. Upsert contacto — guardar JID original para poder responder
      const { rows: cRows } = await client.query(`
        INSERT INTO contactos (telefono, nombre, ultimo_mensaje, jid)
        VALUES ($1, $2, NOW(), $3)
        ON CONFLICT (telefono) DO UPDATE
          SET ultimo_mensaje = NOW(),
              nombre = COALESCE(contactos.nombre, $2),
              jid = EXCLUDED.jid
        RETURNING *
      `, [telefono, nombreContacto, jid]);
      const contacto = cRows[0];

      // 2. Buscar cliente vinculado
      const clienteLink = await client.query(
        `SELECT id, nombre FROM clientes WHERE telefono = $1 AND estado = 'activo' LIMIT 1`,
        ['+' + telefono.replace(/^\+/, '')]
      );
      const clienteId = clienteLink.rows[0]?.id || contacto.cliente_id || null;

      if (clienteId && !contacto.cliente_id) {
        await client.query(`UPDATE contactos SET cliente_id = $1 WHERE id = $2`, [clienteId, contacto.id]);
      }

      // 3. Conversación activa
      let { rows: convRows } = await client.query(`
        SELECT * FROM conversaciones
        WHERE contacto_id = $1 AND estado NOT IN ('cerrado')
        ORDER BY ultima_actividad DESC LIMIT 1
      `, [contacto.id]);

      let conversacion;
      if (!convRows.length) {
        const { rows: nueva } = await client.query(`
          INSERT INTO conversaciones (contacto_id, estado, ultimo_mensaje, ultima_actividad)
          VALUES ($1, 'abierto', $2, NOW()) RETURNING *
        `, [contacto.id, preview]);
        conversacion = nueva[0];
      } else {
        conversacion = convRows[0];
        await client.query(`
          UPDATE conversaciones
          SET ultimo_mensaje = $1, ultima_actividad = NOW(),
              mensajes_sin_leer = mensajes_sin_leer + 1
          WHERE id = $2
        `, [preview, conversacion.id]);
      }

      // 4. Guardar mensaje
      const { rows: msgRows } = await client.query(`
        INSERT INTO mensajes (conversacion_id, contacto_id, direccion, tipo, contenido, whatsapp_message_id)
        VALUES ($1, $2, 'entrante', $3, $4, $5) RETURNING *
      `, [conversacion.id, contacto.id, tipo, contenido, msgId]);
      const mensajeGuardado = msgRows[0];

      // 5. Archivo si aplica
      let archivoGuardado = null;
      if (['image', 'document', 'audio', 'video'].includes(tipo)) {
        archivoGuardado = await descargarYGuardarArchivo(
          msg, message, tipo, mensajeGuardado.id,
          conversacion.id, contacto.id, clienteId, client, sock
        );
      }

      // 6. Actividad del cliente
      if (clienteId) {
        await client.query(`
          INSERT INTO actividad (cliente_id, accion, detalles)
          VALUES ($1, $2, $3)
        `, [clienteId,
          archivoGuardado ? 'archivo.recibido_whatsapp' : 'mensaje.recibido_whatsapp',
          JSON.stringify({ tipo, preview: preview.substring(0, 80) })
        ]);
      }

      // 7. Socket.IO
      if (io) {
        io.emit('nuevo_mensaje', {
          conversacion_id: conversacion.id,
          contacto: { id: contacto.id, telefono, nombre: contacto.nombre },
          cliente_id: clienteId,
          mensaje: mensajeGuardado,
          archivo: archivoGuardado,
          timestamp: new Date().toISOString(),
        });

        if (conversacion.agente_id) {
          io.to(`agent_${conversacion.agente_id}`).emit('notificacion', {
            tipo: 'nuevo_mensaje',
            titulo: `Mensaje de ${contacto.nombre || telefono}`,
            conversacion_id: conversacion.id,
          });
        }
      }

      // 8. Flujos automáticos
      if (archivoGuardado) {
        let clienteData = null;
        if (clienteId) {
          const { rows: cInfo } = await client.query(
            `SELECT id, nombre, apellido, agente_id FROM clientes WHERE id = $1`, [clienteId]
          );
          clienteData = cInfo[0] || null;
        }
        setImmediate(() => {
          procesarFlujos({
            archivo: archivoGuardado,
            cliente: clienteData,
            contacto: { id: contacto.id, telefono, nombre: contacto.nombre },
            conversacion: { id: conversacion.id, agente_id: conversacion.agente_id },
            io,
          }).catch(err => logger.error('flowService error:', err.message));
        });
      }

      logger.info(`✅ Mensaje Baileys: ${tipo} de ${telefono} [jid: ${jid}]${clienteId ? ` [cliente ${clienteId}]` : ''}`);
    });
} catch (err) {
  logger.error('procesarMensajeBaileys error:', err.message, err.stack);
}
}

async function descargarYGuardarArchivo(msg, message, tipo, mensajeId, conversacionId, contactoId, clienteId, client, sock) {
  try {
    const { descargarMedia } = require('../services/baileysService');
    const buffer = await descargarMedia(msg);
    if (!buffer) return null;

    const mediaInfo        = message[`${tipo}Message`] || {};
    const mimeType         = mediaInfo.mimetype || 'application/octet-stream';
    const extension        = obtenerExtension(mimeType, tipo);
    const nombreOriginal   = mediaInfo.fileName || mediaInfo.filename || `${tipo}_${Date.now()}.${extension}`;
    const nombreAlmacenado = `${uuidv4()}.${extension}`;

    const urlAlmacenamiento = await storageService.upload({
      buffer,
      filename: nombreAlmacenado,
      mimeType,
      folder: `archivos/${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, '0')}`,
    });

    const { rows } = await client.query(`
      INSERT INTO archivos (
        mensaje_id, conversacion_id, contacto_id, cliente_id,
        nombre_original, nombre_almacenado, tipo_mime, extension,
        tamanio_bytes, url_almacenamiento, origen
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'whatsapp')
      RETURNING *
    `, [mensajeId, conversacionId, contactoId, clienteId,
        nombreOriginal, nombreAlmacenado, mimeType, extension,
        buffer.length, urlAlmacenamiento]);

    logger.info(`📎 Archivo guardado: ${nombreOriginal} (${(buffer.length / 1024).toFixed(1)} KB)`);
    return rows[0];
  } catch (err) {
    logger.error(`Error guardando archivo Baileys: ${err.message}`);
    return null;
  }
}

function detectarTipo(message) {
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.imageMessage)    return 'image';
  if (message.documentMessage) return 'document';
  if (message.audioMessage)    return 'audio';
  if (message.videoMessage)    return 'video';
  if (message.stickerMessage)  return 'sticker';
  return 'text';
}

function extraerContenido(message, tipo) {
  switch (tipo) {
    case 'text':     return message.conversation || message.extendedTextMessage?.text || '';
    case 'image':    return message.imageMessage?.caption || '[Imagen]';
    case 'document': return message.documentMessage?.fileName || '[Documento]';
    case 'audio':    return '[Audio]';
    case 'video':    return message.videoMessage?.caption || '[Video]';
    default:         return `[${tipo}]`;
  }
}

function obtenerExtension(mimeType, tipo) {
  const mapa = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4',
  };
  return mapa[mimeType] || tipo || 'bin';
}

module.exports = { verificarWebhook, recibirMensaje, procesarMensajeBaileys };