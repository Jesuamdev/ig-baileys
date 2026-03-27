// src/controllers/pagosController.js
const { query } = require('../models/db');
const emailService  = require('../services/emailService');
const waService     = require('../services/whatsappService');
const logger = require('../utils/logger');

async function listar(req, res) {
  try {
    const { clienteId, estado } = req.query;
    const params = []; const conds = [];
    if (clienteId) { params.push(clienteId); conds.push(`p.cliente_id=$${params.length}`); }
    if (estado)    { params.push(estado);    conds.push(`p.estado=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await query(`
      SELECT p.*, c.nombre||' '||COALESCE(c.apellido,'') AS cliente_nombre, c.email AS cliente_email, c.telefono AS cliente_telefono,
             s.nombre AS servicio_nombre
      FROM pagos p
      LEFT JOIN clientes c ON p.cliente_id = c.id
      LEFT JOIN servicios s ON p.servicio_id = s.id
      ${where}
      ORDER BY p.fecha_vencimiento ASC NULLS LAST, p.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
}

async function crear(req, res) {
  try {
    const { cliente_id, servicio_id, monto, moneda, descripcion, fecha_vencimiento } = req.body;
    if (!cliente_id || !monto) return res.status(400).json({ message: 'cliente_id y monto son requeridos' });

    const { rows } = await query(`
      INSERT INTO pagos (cliente_id,servicio_id,monto,moneda,descripcion,fecha_vencimiento)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [cliente_id,servicio_id||null,parseFloat(monto),moneda||'USD',descripcion||null,fecha_vencimiento||null]);

    await query(`INSERT INTO actividad (agente_id,cliente_id,accion,detalles) VALUES ($1,$2,$3,$4)`,
      [req.user.id, cliente_id, 'pago.creado', JSON.stringify({ monto, descripcion })]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
}

async function marcarPagado(req, res) {
  try {
    const { rows } = await query(
      `UPDATE pagos SET estado='pagado', fecha_pago=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Pago no encontrado' });
    await query(`INSERT INTO actividad (agente_id,cliente_id,accion,detalles) VALUES ($1,$2,$3,$4)`,
      [req.user.id, rows[0].cliente_id, 'pago.confirmado', JSON.stringify({ monto: rows[0].monto })]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
}

// POST /api/pagos/:id/enviar-recordatorio
async function enviarRecordatorio(req, res) {
  try {
    const { canales = ['email', 'whatsapp'] } = req.body;

    const { rows } = await query(`
      SELECT p.*, c.nombre, c.apellido, c.email, c.telefono,
             s.nombre AS servicio_nombre
      FROM pagos p
      JOIN clientes c ON p.cliente_id = c.id
      LEFT JOIN servicios s ON p.servicio_id = s.id
      WHERE p.id = $1
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ message: 'Pago no encontrado' });
    const pago = rows[0];

    const diasRestantes = pago.fecha_vencimiento
      ? Math.ceil((new Date(pago.fecha_vencimiento) - new Date()) / 86400000)
      : null;

    const enviados = [];

    if (canales.includes('email') && pago.email) {
      await emailService.enviarRecordatorioPago({ pago, diasRestantes });
      enviados.push('email');
    }

    if (canales.includes('whatsapp') && pago.telefono) {
      const msg = `💳 *Recordatorio de pago — CorpEase*\n\nHola ${pago.nombre}, le recordamos un pago pendiente:\n\n📋 *Servicio:* ${pago.servicio_nombre || pago.descripcion || 'Servicios'}\n💵 *Monto:* $${pago.monto} ${pago.moneda}${diasRestantes !== null ? `\n📅 *Vence:* ${diasRestantes < 0 ? 'VENCIDO' : `en ${diasRestantes} días`}` : ''}${pago.link_pago ? `\n\n🔗 *Pagar:* ${pago.link_pago}` : ''}\n\n¿Dudas? Escríbanos. 🙏`;
      await waService.enviarTexto(pago.telefono.replace(/\D/g,''), msg);
      enviados.push('whatsapp');
    }

    await query(`UPDATE pagos SET recordatorio_enviado=TRUE WHERE id=$1`, [req.params.id]);
    await query(`INSERT INTO actividad (agente_id,cliente_id,accion,detalles) VALUES ($1,$2,$3,$4)`,
      [req.user.id, pago.cliente_id, 'pago.recordatorio_enviado', JSON.stringify({ canales: enviados })]);

    // Notificación interna
    await query(`INSERT INTO notificaciones (cliente_id,tipo,titulo,mensaje,canal,enviada) VALUES ($1,$2,$3,$4,$5,TRUE)`,
      [pago.cliente_id, 'pago_recordatorio',
        `Recordatorio enviado a ${pago.nombre}`,
        `Pago de $${pago.monto} ${pago.moneda}`, 'sistema']);

    res.json({ success: true, canales: enviados });
  } catch (err) {
    logger.error('enviarRecordatorio:', err.message);
    res.status(500).json({ message: err.message });
  }
}

// POST /api/pagos/:id/enviar-factura
async function enviarFactura(req, res) {
  try {
    const { rows } = await query(`
      SELECT p.*, c.nombre, c.email, s.nombre AS servicio_nombre
      FROM pagos p
      JOIN clientes c ON p.cliente_id = c.id
      LEFT JOIN servicios s ON p.servicio_id = s.id
      WHERE p.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });

    await emailService.enviarFactura(rows[0]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
}

module.exports = { listar, crear, marcarPagado, enviarRecordatorio, enviarFactura };
