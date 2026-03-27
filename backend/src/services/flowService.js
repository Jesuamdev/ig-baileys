// src/services/flowService.js
// Motor de flujos automáticos para IG Accounting Services
// Se ejecuta cada vez que llega un archivo por WhatsApp

const { query } = require('../models/db');
const logger    = require('../utils/logger');

// Tipos de archivo que reconocemos
const TIPOS_MIME = {
  pdf:   ['application/pdf'],
  word:  ['application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  excel: ['application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  imagen:['image/jpeg','image/png','image/webp','image/gif'],
  audio: ['audio/ogg','audio/mpeg','audio/mp4'],
  video: ['video/mp4','video/mpeg'],
};

function detectarTipoArchivo(mimeType) {
  for (const [tipo, mimes] of Object.entries(TIPOS_MIME)) {
    if (mimes.some(m => mimeType?.startsWith(m.split('/')[0]) && mimeType === m || mimeType?.includes(m.split('/')[1]))) {
      return tipo;
    }
  }
  if (mimeType?.includes('pdf')) return 'pdf';
  if (mimeType?.includes('image')) return 'imagen';
  if (mimeType?.includes('audio')) return 'audio';
  if (mimeType?.includes('video')) return 'video';
  if (mimeType?.includes('word') || mimeType?.includes('doc')) return 'word';
  if (mimeType?.includes('excel') || mimeType?.includes('sheet')) return 'excel';
  return 'otro';
}

// Detectar tipo de documento contable por nombre de archivo
function detectarTipoDocumentoContable(nombreArchivo) {
  const nombre = (nombreArchivo || '').toLowerCase();
  if (nombre.includes('w9') || nombre.includes('w-9'))              return 'w9';
  if (nombre.includes('w8') || nombre.includes('w-8'))              return 'w8';
  if (nombre.includes('ein') || nombre.includes('tax_id'))          return 'ein';
  if (nombre.includes('pasaporte') || nombre.includes('passport'))  return 'pasaporte';
  if (nombre.includes('cedula') || nombre.includes('id'))           return 'identificacion';
  if (nombre.includes('contrato') || nombre.includes('contract'))   return 'contrato';
  if (nombre.includes('factura') || nombre.includes('invoice'))     return 'factura';
  if (nombre.includes('declaracion') || nombre.includes('tax_return')) return 'declaracion';
  if (nombre.includes('llc') || nombre.includes('articles'))        return 'formacion_llc';
  if (nombre.includes('nomina') || nombre.includes('payroll'))      return 'nomina';
  if (nombre.includes('estado') || nombre.includes('bank_statement')) return 'estado_cuenta';
  return null;
}

/**
 * procesarFlujos — punto de entrada principal
 * Se llama después de guardar un archivo recibido por WhatsApp
 */
async function procesarFlujos({ archivo, cliente, contacto, conversacion, io }) {
  if (!archivo) return;

  try {
    const tipoArchivo = detectarTipoArchivo(archivo.tipo_mime);
    const tipoDoc     = detectarTipoDocumentoContable(archivo.nombre_original);

    logger.info(`🔄 Flujos: procesando archivo [${tipoArchivo}] "${archivo.nombre_original}"${cliente ? ` para cliente ${cliente.nombre}` : ''}`);

    const acciones = [];

    // ── 1. AUTO-CLASIFICAR el documento ────────────────────────────────────────
    if (tipoDoc) {
      await query(
        `UPDATE archivos SET tipo_documento = $1 WHERE id = $2`,
        [tipoDoc, archivo.id]
      );
      acciones.push(`Clasificado como: ${tipoDoc}`);
      logger.info(`📁 Flujo: archivo clasificado como "${tipoDoc}"`);
    }

    // ── 2. VINCULAR a solicitud pendiente si el nombre coincide ────────────────
    if (cliente) {
      const { rows: solicitudes } = await query(`
        SELECT * FROM solicitudes_archivos
        WHERE cliente_id = $1
          AND estado = 'pendiente'
          AND archivo_id IS NULL
        ORDER BY created_at ASC
      `, [cliente.id]);

      let solicitudVinculada = null;

      // Buscar coincidencia por tipo de documento o título similar
      for (const sol of solicitudes) {
        const tituloLower = sol.titulo.toLowerCase();
        const nombreLower = (archivo.nombre_original || '').toLowerCase();
        const coincide =
          (tipoDoc && tituloLower.includes(tipoDoc.replace('_',' '))) ||
          (tipoDoc && tituloLower.includes(tipoDoc)) ||
          nombreLower.includes(tituloLower.split(' ')[0]) ||
          (tipoArchivo === 'pdf' && tituloLower.includes('pdf')) ||
          (tipoArchivo === 'imagen' && (tituloLower.includes('foto') || tituloLower.includes('imagen') || tituloLower.includes('id') || tituloLower.includes('pasaporte')));

        if (coincide) {
          await query(
            `UPDATE solicitudes_archivos SET archivo_id = $1, estado = 'recibido' WHERE id = $2`,
            [archivo.id, sol.id]
          );
          solicitudVinculada = sol;
          acciones.push(`Vinculado a solicitud: "${sol.titulo}"`);
          logger.info(`🔗 Flujo: archivo vinculado a solicitud "${sol.titulo}"`);
          break;
        }
      }

      // ── 3. NOTIFICAR al agente asignado ────────────────────────────────────
      const agenteId = conversacion?.agente_id || cliente?.agente_id;

      if (agenteId && io) {
        const tituloNotif = solicitudVinculada
          ? `📎 Documento recibido para "${solicitudVinculada.titulo}"`
          : `📎 Nuevo ${tipoArchivo.toUpperCase()} de ${cliente.nombre}`;

        const cuerpoNotif = solicitudVinculada
          ? `${archivo.nombre_original} — solicitud completada automáticamente`
          : `${archivo.nombre_original}${tipoDoc ? ` (${tipoDoc.replace('_',' ')})` : ''}`;

        // Notificación en tiempo real por Socket.IO
        io.to(`agent_${agenteId}`).emit('notificacion_archivo', {
          tipo:             'archivo_recibido',
          titulo:           tituloNotif,
          cuerpo:           cuerpoNotif,
          archivo_id:       archivo.id,
          cliente_id:       cliente.id,
          cliente_nombre:   cliente.nombre,
          conversacion_id:  conversacion?.id,
          solicitud_id:     solicitudVinculada?.id || null,
          solicitud_titulo: solicitudVinculada?.titulo || null,
          timestamp:        new Date().toISOString(),
        });

        // También emitir a todos los agentes conectados si no hay asignado específico
        io.emit('notificacion_archivo_global', {
          tipo:           'archivo_recibido',
          titulo:         tituloNotif,
          cuerpo:         cuerpoNotif,
          cliente_nombre: cliente.nombre,
          archivo_id:     archivo.id,
          timestamp:      new Date().toISOString(),
        });

        acciones.push(`Notificado agente ${agenteId}`);
      }

      // ── 4. GUARDAR notificación persistente en BD ──────────────────────────
      await query(`
        INSERT INTO notificaciones (cliente_id, agente_id, tipo, titulo, mensaje, canal, enviada)
        VALUES ($1, $2, $3, $4, $5, 'sistema', TRUE)
      `, [
        cliente.id,
        agenteId || null,
        'archivo_recibido',
        solicitudVinculada
          ? `Documento recibido: ${solicitudVinculada.titulo}`
          : `Nuevo archivo de ${cliente.nombre}`,
        `${archivo.nombre_original}${tipoDoc ? ` · ${tipoDoc.replace('_',' ')}` : ''}`,
      ]);
    } else {
      // Sin cliente vinculado — notificar a todos los agentes
      if (io) {
        io.emit('notificacion_archivo_global', {
          tipo:      'archivo_sin_cliente',
          titulo:    `📎 Archivo sin cliente asignado`,
          cuerpo:    `${archivo.nombre_original} de ${contacto?.telefono || 'desconocido'} — asigna este contacto a un cliente`,
          archivo_id: archivo.id,
          timestamp:  new Date().toISOString(),
        });
      }
    }

    // ── 5. LOG FINAL ──────────────────────────────────────────────────────────
    if (acciones.length) {
      logger.info(`✅ Flujos completados: ${acciones.join(' | ')}`);
    }

    return { acciones, tipoArchivo, tipoDoc };

  } catch (err) {
    logger.error(`❌ Error en flujos automáticos: ${err.message}`);
    return null;
  }
}

module.exports = { procesarFlujos, detectarTipoArchivo, detectarTipoDocumentoContable };