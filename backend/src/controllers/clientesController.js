// src/controllers/clientesController.js
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../models/db');
const logger = require('../utils/logger');
const emailService = require('../services/emailService');

// GET /api/clientes
async function listar(req, res) {
  try {
    const { estado, origen, buscar, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conds  = [];

    if (estado) { params.push(estado); conds.push(`c.estado = $${params.length}`); }
    if (origen) { params.push(origen); conds.push(`c.origen = $${params.length}`); }
    if (buscar) {
      params.push(`%${buscar}%`);
      conds.push(`(c.nombre ILIKE $${params.length} OR c.apellido ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.telefono ILIKE $${params.length})`);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows: clientes } = await query(`
      SELECT c.id, c.nombre, c.apellido, c.email, c.telefono, c.pais,
             c.estado, c.origen, c.portal_activo, c.created_at,
             a.nombre AS agente_nombre,
             COUNT(DISTINCT s.id) AS total_servicios,
             COUNT(DISTINCT p.id) FILTER (WHERE p.estado IN ('pendiente','enviado')) AS pagos_pendientes,
             COUNT(DISTINCT ar.id) AS total_archivos
      FROM clientes c
      LEFT JOIN agentes a ON c.agente_id = a.id
      LEFT JOIN servicios s ON s.cliente_id = c.id
      LEFT JOIN pagos p ON p.cliente_id = c.id
      LEFT JOIN archivos ar ON ar.cliente_id = c.id
      ${where}
      GROUP BY c.id, a.nombre
      ORDER BY c.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, parseInt(limit), offset]);

    const { rows: total } = await query(`SELECT COUNT(*) FROM clientes c ${where}`, params);

    res.json({ data: clientes, total: parseInt(total[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    logger.error('listarClientes:', err.message);
    res.status(500).json({ message: 'Error del servidor' });
  }
}

// GET /api/clientes/:id
async function obtener(req, res) {
  try {
    const { rows } = await query(`
      SELECT c.*, a.nombre AS agente_nombre
      FROM clientes c
      LEFT JOIN agentes a ON c.agente_id = a.id
      WHERE c.id = $1
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ message: 'Cliente no encontrado' });

    const cliente = rows[0];
    delete cliente.password;

    // Servicios
    const { rows: servicios } = await query(
      `SELECT * FROM servicios WHERE cliente_id = $1 ORDER BY created_at DESC`, [cliente.id]
    );
    // Pagos
    const { rows: pagos } = await query(
      `SELECT p.*, s.nombre AS servicio_nombre FROM pagos p LEFT JOIN servicios s ON p.servicio_id = s.id WHERE p.cliente_id = $1 ORDER BY p.created_at DESC`, [cliente.id]
    );
    // Archivos
    const { rows: archivos } = await query(
      `SELECT * FROM archivos WHERE cliente_id = $1 ORDER BY created_at DESC`, [cliente.id]
    );
    // Solicitudes de archivos
    const { rows: solicitudes } = await query(
      `SELECT sa.*, a.nombre AS agente_nombre FROM solicitudes_archivos sa LEFT JOIN agentes a ON sa.agente_id = a.id WHERE sa.cliente_id = $1 ORDER BY sa.created_at DESC`, [cliente.id]
    );

    res.json({ ...cliente, servicios, pagos, archivos, solicitudes });
  } catch (err) {
    logger.error('obtenerCliente:', err.message);
    res.status(500).json({ message: 'Error del servidor' });
  }
}

// POST /api/clientes
async function crear(req, res) {
  try {
    const { nombre, apellido, email, telefono, pais, empresa, origen, notas_internas, agente_id } = req.body;

    if (!nombre || !email) return res.status(400).json({ message: 'Nombre y email son requeridos' });

    const { rows } = await query(`
      INSERT INTO clientes (nombre, apellido, email, telefono, pais, empresa, origen, notas_internas, agente_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [nombre, apellido || '', email.toLowerCase().trim(), telefono || null, pais || null, empresa || null, origen || 'manual', notas_internas || null, agente_id || null]);

    // Vincular contacto WhatsApp si tiene teléfono
    if (telefono) {
      await query(`
        INSERT INTO contactos (telefono, nombre, email, cliente_id)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (telefono) DO UPDATE SET cliente_id = EXCLUDED.cliente_id, nombre = EXCLUDED.nombre
      `, [telefono, `${nombre} ${apellido || ''}`.trim(), email, rows[0].id]);
    }

    await _logActividad(req.user.id, rows[0].id, 'cliente.creado', { email, origen });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'Ya existe un cliente con ese email' });
    logger.error('crearCliente:', err.message);
    res.status(500).json({ message: 'Error del servidor' });
  }
}

// PUT /api/clientes/:id
async function actualizar(req, res) {
  try {
    const allowed = ['nombre','apellido','telefono','pais','empresa','estado','origen','notas_internas','agente_id'];
    const fields  = [];
    const values  = [];

    allowed.forEach(k => {
      if (req.body[k] !== undefined) {
        fields.push(`${k} = $${fields.length + 1}`);
        values.push(req.body[k]);
      }
    });

    if (!fields.length) return res.status(400).json({ message: 'Sin campos para actualizar' });
    values.push(req.params.id);

    const { rows } = await query(
      `UPDATE clientes SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );

    if (!rows.length) return res.status(404).json({ message: 'Cliente no encontrado' });
    await _logActividad(req.user.id, req.params.id, 'cliente.actualizado', req.body);
    res.json(rows[0]);
  } catch (err) {
    logger.error('actualizarCliente:', err.message);
    res.status(500).json({ message: 'Error del servidor' });
  }
}

// POST /api/clientes/:id/activar-portal
// Crea o resetea el acceso al portal del cliente
async function activarPortal(req, res) {
  try {
    const { password, enviar_email = true } = req.body;
    const pass = password || generarPasswordSeguro();
    const hash = await bcrypt.hash(pass, 12);

    const { rows } = await query(`
      UPDATE clientes SET password = $1, portal_activo = TRUE
      WHERE id = $2
      RETURNING id, nombre, apellido, email
    `, [hash, req.params.id]);

    if (!rows.length) return res.status(404).json({ message: 'Cliente no encontrado' });
    const cliente = rows[0];

    if (enviar_email) {
      await emailService.enviarAccesPortal(cliente, pass);
    }

    await _logActividad(req.user.id, req.params.id, 'cliente.portal_activado', { email: cliente.email });
    res.json({ message: 'Portal activado', email: cliente.email, password_temporal: pass });
  } catch (err) {
    logger.error('activarPortal:', err.message);
    res.status(500).json({ message: 'Error del servidor' });
  }
}

// GET /api/clientes/:id/timeline
async function timeline(req, res) {
  try {
    const { rows } = await query(`
      SELECT accion AS tipo, detalles, created_at
      FROM actividad
      WHERE cliente_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Error del servidor' });
  }
}

// ── PORTAL DEL CLIENTE ──────────────────────────────────────
// GET /api/portal/perfil  — el cliente ve su propia info
async function portalPerfil(req, res) {
  try {
    const { rows } = await query(`
      SELECT id, nombre, apellido, email, telefono, pais, empresa, created_at FROM clientes WHERE id = $1
    `, [req.user.id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Error' });
  }
}

// GET /api/portal/servicios
async function portalServicios(req, res) {
  try {
    const { rows } = await query(
      `SELECT * FROM servicios WHERE cliente_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Error' });
  }
}

// GET /api/portal/pagos
async function portalPagos(req, res) {
  try {
    const { rows } = await query(`
      SELECT p.*, s.nombre AS servicio_nombre
      FROM pagos p
      LEFT JOIN servicios s ON p.servicio_id = s.id
      WHERE p.cliente_id = $1
      ORDER BY p.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Error' });
  }
}

// GET /api/portal/archivos
async function portalArchivos(req, res) {
  try {
    const { rows } = await query(
      `SELECT id, nombre_original, tipo_mime, extension, tamanio_bytes, tipo_documento, verificado, origen, created_at FROM archivos WHERE cliente_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Error' });
  }
}

// GET /api/portal/solicitudes
async function portalSolicitudes(req, res) {
  try {
    const { rows } = await query(`
      SELECT sa.*, ar.nombre_original AS archivo_nombre, ar.url_almacenamiento
      FROM solicitudes_archivos sa
      LEFT JOIN archivos ar ON sa.archivo_id = ar.id
      WHERE sa.cliente_id = $1
      ORDER BY sa.created_at DESC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Error' });
  }
}

// GET /api/portal/notificaciones
async function portalNotificaciones(req, res) {
  try {
    const { rows } = await query(
      `SELECT * FROM notificaciones WHERE cliente_id = $1 ORDER BY created_at DESC LIMIT 30`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Error' });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function _logActividad(agenteId, clienteId, accion, detalles = {}) {
  try {
    await query(
      `INSERT INTO actividad (agente_id, cliente_id, accion, detalles) VALUES ($1,$2,$3,$4)`,
      [agenteId, clienteId, accion, JSON.stringify(detalles)]
    );
  } catch (e) { /* no crashear por esto */ }
}

function generarPasswordSeguro() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

module.exports = {
  listar, obtener, crear, actualizar, activarPortal, timeline,
  portalPerfil, portalServicios, portalPagos, portalArchivos, portalSolicitudes, portalNotificaciones,
};
