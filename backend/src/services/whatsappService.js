// src/services/whatsappService.js
const axios  = require('axios');
const { query } = require('../models/db');
const logger = require('../utils/logger');

const WA_URL = () => `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
const HEADERS = () => ({ Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' });

async function enviarTexto(telefono, texto, conversacionId, agenteId) {
  return _enviar({ messaging_product:'whatsapp', to: telefono, type:'text', text:{ body: texto } }, 'texto', texto, conversacionId, agenteId);
}

async function enviarPlantilla(telefono, nombre, idioma = 'es', componentes = []) {
  const payload = { messaging_product:'whatsapp', to: telefono, type:'template', template:{ name: nombre, language:{ code: idioma }, components: componentes }};
  const res = await axios.post(WA_URL(), payload, { headers: HEADERS() });
  logger.info(`Plantilla '${nombre}' → ${telefono}`);
  return res.data;
}

async function enviarArchivo(telefono, urlArchivo, tipoMime, nombreArchivo, conversacionId, agenteId) {
  const tipo    = tipoMime.startsWith('image/') ? 'image' : 'document';
  const payload = { messaging_product:'whatsapp', to: telefono, type: tipo, [tipo]:{ link: urlArchivo, ...(tipo==='document' && { filename: nombreArchivo }) }};
  return _enviar(payload, tipo, `[${nombreArchivo}]`, conversacionId, agenteId);
}

async function _enviar(payload, tipo, contenido, conversacionId, agenteId) {
  try {
    const res = await axios.post(WA_URL(), payload, { headers: HEADERS() });
    const waId = res.data.messages?.[0]?.id;
    if (conversacionId) {
      await query(`INSERT INTO mensajes (conversacion_id,agente_id,direccion,tipo,contenido,whatsapp_message_id,estado) VALUES ($1,$2,'saliente',$3,$4,$5,'enviado')`,
        [conversacionId, agenteId||null, tipo, contenido, waId]);
      await query(`UPDATE conversaciones SET ultimo_mensaje=$1, ultima_actividad=NOW() WHERE id=$2`, [contenido.substring(0,100), conversacionId]);
    }
    return { success: true, messageId: waId };
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    logger.error(`WA error: ${msg}`);
    if (conversacionId) {
      await query(`INSERT INTO mensajes (conversacion_id,agente_id,direccion,tipo,contenido,estado) VALUES ($1,$2,'saliente',$3,$4,'fallido')`,
        [conversacionId, agenteId||null, tipo, contenido]);
    }
    throw new Error(msg);
  }
}

module.exports = { enviarTexto, enviarPlantilla, enviarArchivo };
