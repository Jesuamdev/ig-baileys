// src/services/whatsappService.js
// Adaptado para usar Baileys — usa el JID guardado en BD para responder correctamente
const { query } = require('../models/db');
const logger = require('../utils/logger');
const baileysService = require('./baileysService');

async function enviarTexto(telefono, texto, conversacionId, agenteId) {
  try {
    // Buscar el JID real guardado en la BD para este contacto
    let jidDestino = telefono;
    try {
      const { rows } = await query(
        `SELECT jid FROM contactos WHERE telefono = $1 OR telefono = $2 LIMIT 1`,
        [telefono, telefono.replace(/^\+/, '')]
      );
      if (rows[0]?.jid) {
        jidDestino = rows[0].jid;
        logger.info(`JID encontrado en BD: ${jidDestino}`);
      }
    } catch (e) {
      logger.warn(`No se pudo buscar JID para ${telefono}, usando teléfono directo`);
    }

    await baileysService.enviarTexto(jidDestino, texto);

    if (conversacionId) {
      await query(
        `INSERT INTO mensajes (conversacion_id, agente_id, direccion, tipo, contenido, estado)
         VALUES ($1, $2, 'saliente', 'text', $3, 'enviado')`,
        [conversacionId, agenteId || null, texto]
      );
      await query(
        `UPDATE conversaciones SET ultimo_mensaje = $1, ultima_actividad = NOW() WHERE id = $2`,
        [texto.substring(0, 100), conversacionId]
      );
    }

    return { success: true };
  } catch (err) {
    logger.error(`Error enviando mensaje: ${err.message}`);

    if (conversacionId) {
      await query(
        `INSERT INTO mensajes (conversacion_id, agente_id, direccion, tipo, contenido, estado)
         VALUES ($1, $2, 'saliente', 'text', $3, 'fallido')`,
        [conversacionId, agenteId || null, texto]
      ).catch(() => {});
    }

    throw new Error(err.message);
  }
}

async function enviarPlantilla(telefono, nombre, idioma = 'es', componentes = []) {
  logger.warn(`Plantilla '${nombre}' no disponible en Baileys — enviando como texto`);
  const texto = componentes?.[0]?.parameters?.[0]?.text || `Mensaje automático: ${nombre}`;
  return enviarTexto(telefono, texto, null, null);
}

async function enviarArchivo(telefono, urlArchivo, tipoMime, nombreArchivo, conversacionId, agenteId) {
  try {
    // Buscar JID real
    let jidDestino = telefono;
    try {
      const { rows } = await query(
        `SELECT jid FROM contactos WHERE telefono = $1 OR telefono = $2 LIMIT 1`,
        [telefono, telefono.replace(/^\+/, '')]
      );
      if (rows[0]?.jid) jidDestino = rows[0].jid;
    } catch (e) {}

    const axios = require('axios');
    const res = await axios.get(urlArchivo, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(res.data);

    await baileysService.enviarArchivo(jidDestino, buffer, tipoMime, nombreArchivo);

    const contenido = `[${nombreArchivo}]`;
    if (conversacionId) {
      await query(
        `INSERT INTO mensajes (conversacion_id, agente_id, direccion, tipo, contenido, estado)
         VALUES ($1, $2, 'saliente', 'document', $3, 'enviado')`,
        [conversacionId, agenteId || null, contenido]
      );
      await query(
        `UPDATE conversaciones SET ultimo_mensaje = $1, ultima_actividad = NOW() WHERE id = $2`,
        [contenido, conversacionId]
      );
    }

    return { success: true };
  } catch (err) {
    logger.error(`Error enviando archivo: ${err.message}`);
    throw new Error(err.message);
  }
}

module.exports = { enviarTexto, enviarPlantilla, enviarArchivo };