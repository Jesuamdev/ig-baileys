// src/controllers/archivosController.js
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../models/db');
const storageService = require('../services/storageService');
const waService      = require('../services/whatsappService');
const emailService   = require('../services/emailService');
const logger = require('../utils/logger');

// Multer — memoria para procesar antes de subir
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf','image/jpeg','image/png','image/webp',
      'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain'].includes(file.mimetype);
    cb(ok ? null : new Error(`Tipo no permitido: ${file.mimetype}`), ok);
  },
});

// GET /api/archivos
async function listar(req, res) {
  try {
    const { clienteId, tipo_documento, origen } = req.query;
    const params = []; const conds = [];
    if (clienteId)       { params.push(clienteId);      conds.push(`a.cliente_id=$${params.length}`); }
    if (tipo_documento)  { params.push(tipo_documento);  conds.push(`a.tipo_documento=$${params.length}`); }
    if (origen)          { params.push(origen);          conds.push(`a.origen=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await query(`
      SELECT a.*, c.nombre||' '||COALESCE(c.apellido,'') AS cliente_nombre
      FROM archivos a
      LEFT JOIN clientes c ON a.cliente_id = c.id
      ${where} ORDER BY a.created_at DESC LIMIT 100
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
}

// PATCH /api/archivos/:id — clasificar documento
async function clasificar(req, res) {
  try {
    const { tipo_documento, servicio_id, verificado, cliente_id } = req.body;
    const sets = []; const vals = [];
    if (tipo_documento !== undefined) { sets.push(`tipo_documento=$${sets.length+1}`); vals.push(tipo_documento); }
    if (servicio_id    !== undefined) { sets.push(`servicio_id=$${sets.length+1}`);    vals.push(servicio_id); }
    if (verificado     !== undefined) { sets.push(`verificado=$${sets.length+1}`);     vals.push(verificado); }
    if (cliente_id     !== undefined) { sets.push(`cliente_id=$${sets.length+1}`);     vals.push(cliente_id); }
    if (!sets.length) return res.status(400).json({ message: 'Sin campos' });
    vals.push(req.params.id);
    const { rows } = await query(`UPDATE archivos SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
}

// POST /api/archivos/upload  — subida manual por el agente
const uploadManual = [
  upload.single('archivo'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: 'Archivo requerido' });
      const { cliente_id, servicio_id, tipo_documento } = req.body;
      if (!cliente_id) return res.status(400).json({ message: 'cliente_id requerido' });

      const ext   = path.extname(req.file.originalname).replace('.','');
      const fname = `${uuidv4()}.${ext}`;
      const url   = await storageService.upload({
        buffer: req.file.buffer, filename: fname,
        mimeType: req.file.mimetype, folder: `clientes/${cliente_id}`,
      });

      const { rows } = await query(`
        INSERT INTO archivos (cliente_id,servicio_id,nombre_original,nombre_almacenado,tipo_mime,extension,tamanio_bytes,url_almacenamiento,tipo_documento,origen)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual') RETURNING *
      `, [cliente_id,servicio_id||null,req.file.originalname,fname,req.file.mimetype,ext,req.file.size,url,tipo_documento||null]);

      await query(`INSERT INTO actividad (agente_id,cliente_id,accion,detalles) VALUES ($1,$2,$3,$4)`,
        [req.user.id, cliente_id, 'archivo.subido_manual', JSON.stringify({ nombre: req.file.originalname })]);

      res.status(201).json(rows[0]);
    } catch (err) { res.status(500).json({ message: err.message }); }
  }
];

// GET /api/archivos/:id/descargar
async function descargar(req, res) {
  try {
    const { rows } = await query(`SELECT * FROM archivos WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });

    const archivo = rows[0];

    // Almacenamiento local — servir el archivo directamente como stream
    if (process.env.STORAGE_TYPE !== 's3') {
      const fs       = require('fs');
      const uploadsBase = path.resolve(process.env.UPLOADS_PATH || './uploads');
      // url_almacenamiento puede ser "/uploads/carpeta/archivo.ext" o "carpeta/archivo.ext"
      const relative = archivo.url_almacenamiento.replace(/^\/uploads\//, '');
      const filePath = path.join(uploadsBase, relative);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: 'Archivo no encontrado en disco' });
      }

      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(archivo.nombre_original)}"`);
      res.setHeader('Content-Type', archivo.tipo_mime || 'application/octet-stream');
      return fs.createReadStream(filePath).pipe(res);
    }

    // Almacenamiento S3 — devolver URL firmada
    const url = await storageService.getSignedUrl(archivo.url_almacenamiento);
    res.json({ url, nombre: archivo.nombre_original });
  } catch (err) { res.status(500).json({ message: err.message }); }
}

// ── SOLICITUDES DE ARCHIVOS ──────────────────────────────────────────────────

// GET /api/solicitudes-archivos
async function listarSolicitudes(req, res) {
  try {
    const { clienteId, estado } = req.query;
    const params = []; const conds = [];
    if (clienteId) { params.push(clienteId); conds.push(`sa.cliente_id=$${params.length}`); }
    if (estado)    { params.push(estado);    conds.push(`sa.estado=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await query(`
      SELECT sa.*, c.nombre||' '||COALESCE(c.apellido,'') AS cliente_nombre,
             c.email AS cliente_email, c.telefono AS cliente_telefono,
             a.nombre AS agente_nombre,
             ar.nombre_original AS archivo_recibido
      FROM solicitudes_archivos sa
      LEFT JOIN clientes c ON sa.cliente_id = c.id
      LEFT JOIN agentes a ON sa.agente_id = a.id
      LEFT JOIN archivos ar ON sa.archivo_id = ar.id
      ${where} ORDER BY sa.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
}

// POST /api/solicitudes-archivos — crear solicitud y notificar al cliente
async function crearSolicitud(req, res) {
  try {
    const { cliente_id, servicio_id, titulo, descripcion, fecha_limite, canales = ['email','whatsapp'] } = req.body;
    if (!cliente_id || !titulo) return res.status(400).json({ message: 'cliente_id y titulo son requeridos' });

    const { rows } = await query(`
      INSERT INTO solicitudes_archivos (cliente_id,servicio_id,agente_id,titulo,descripcion,fecha_limite)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [cliente_id, servicio_id||null, req.user.id, titulo, descripcion||null, fecha_limite||null]);

    // Obtener datos del cliente
    const { rows: cRows } = await query(
      `SELECT nombre, apellido, email, telefono FROM clientes WHERE id=$1`, [cliente_id]
    );
    const cliente = cRows[0];

    // Notificar al cliente
    if (cliente) {
      if (canales.includes('email') && cliente.email) {
        await emailService.enviarSolicitudArchivo({ cliente, solicitud: rows[0] });
      }
      if (canales.includes('whatsapp') && cliente.telefono) {
        const msg = `📄 *Documento solicitado — CorpEase*\n\nHola ${cliente.nombre}, necesitamos el siguiente documento para continuar con su proceso:\n\n📋 *${titulo}*${descripcion ? `\n\n${descripcion}` : ''}${fecha_limite ? `\n\n⏰ *Fecha límite:* ${new Date(fecha_limite).toLocaleDateString('es')}` : ''}\n\nPuede enviarlo directamente por este WhatsApp y lo registraremos automáticamente. ¡Gracias!`;
        await waService.enviarTexto(cliente.telefono.replace(/\D/g,''), msg);
      }
    }

    // Notificación interna
    await query(`INSERT INTO notificaciones (cliente_id,agente_id,tipo,titulo,mensaje,canal,enviada) VALUES ($1,$2,$3,$4,$5,'sistema',TRUE)`,
      [cliente_id, req.user.id, 'solicitud_archivo', `Documento solicitado: ${titulo}`, descripcion||'']);

    await query(`INSERT INTO actividad (agente_id,cliente_id,accion,detalles) VALUES ($1,$2,$3,$4)`,
      [req.user.id, cliente_id, 'solicitud.creada', JSON.stringify({ titulo })]);

    res.status(201).json(rows[0]);
  } catch (err) {
    logger.error('crearSolicitud:', err.message);
    res.status(500).json({ message: err.message });
  }
}

// PUT /api/solicitudes-archivos/:id/vincular-archivo
async function vincularArchivo(req, res) {
  try {
    const { archivo_id } = req.body;
    const { rows } = await query(
      `UPDATE solicitudes_archivos SET archivo_id=$1, estado='recibido' WHERE id=$2 RETURNING *`,
      [archivo_id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
}

module.exports = { listar, clasificar, uploadManual, descargar, listarSolicitudes, crearSolicitud, vincularArchivo };