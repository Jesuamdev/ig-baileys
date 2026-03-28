// src/services/whatsappService.js
// Adaptado para usar Baileys en lugar de Meta Cloud API
const { query } = require('../models/db');
const logger = require('../utils/logger');
const baileysService = require('./baileysService');

async function enviarTexto(telefono, texto, conversacionId, agenteId) {
  try {
    await baileysService.enviarTexto(telefono, texto);

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
  // Con Baileys no hay plantillas oficiales — enviamos texto plano
  logger.warn(`Plantilla '${nombre}' no disponible en Baileys — enviando como texto`);
  const texto = componentes?.[0]?.parameters?.[0]?.text || `Mensaje automático: ${nombre}`;
  return enviarTexto(telefono, texto, null, null);
}

async function enviarArchivo(telefono, urlArchivo, tipoMime, nombreArchivo, conversacionId, agenteId) {
  try {
    // Descargar el archivo desde la URL para obtener el buffer
    const axios = require('axios');
    const res = await axios.get(urlArchivo, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(res.data);

    await baileysService.enviarArchivo(telefono, buffer, tipoMime, nombreArchivo);

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