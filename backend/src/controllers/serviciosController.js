// src/controllers/serviciosController.js
const { query } = require('../models/db');
const logger = require('../utils/logger');

async function listar(req, res) {
  try {
    const { clienteId, estado, tipo } = req.query;
    const params = []; const conds = [];
    if (clienteId) { params.push(clienteId); conds.push(`s.cliente_id = $${params.length}`); }
    if (estado)    { params.push(estado);    conds.push(`s.estado = $${params.length}`); }
    if (tipo)      { params.push(tipo);      conds.push(`s.tipo = $${params.length}`); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await query(`
      SELECT s.*, c.nombre || ' ' || COALESCE(c.apellido,'') AS cliente_nombre
      FROM servicios s
      LEFT JOIN clientes c ON s.cliente_id = c.id
      ${where} ORDER BY s.created_at DESC
    `, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
}

async function crear(req, res) {
  try {
    const { cliente_id, tipo, nombre, descripcion, precio, fecha_vencimiento, es_recurrente, intervalo_recurrente, proxima_renovacion, notas } = req.body;
    if (!cliente_id || !tipo || !nombre) return res.status(400).json({ message: 'Faltan campos obligatorios' });

    const { rows } = await query(`
      INSERT INTO servicios (cliente_id,tipo,nombre,descripcion,precio,fecha_vencimiento,es_recurrente,intervalo_recurrente,proxima_renovacion,notas)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [cliente_id,tipo,nombre,descripcion||null,precio||null,fecha_vencimiento||null,es_recurrente||false,intervalo_recurrente||null,proxima_renovacion||null,notas||null]);

    await query(`INSERT INTO actividad (agente_id,cliente_id,accion,detalles) VALUES ($1,$2,$3,$4)`,
      [req.user.id, cliente_id, 'servicio.creado', JSON.stringify({ tipo, nombre })]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
}

async function actualizar(req, res) {
  try {
    const allowed = ['nombre','descripcion','estado','precio','fecha_vencimiento','es_recurrente','intervalo_recurrente','proxima_renovacion','notas'];
    const fields = []; const values = [];
    allowed.forEach(k => { if (req.body[k] !== undefined) { fields.push(`${k}=$${fields.length+1}`); values.push(req.body[k]); } });
    if (!fields.length) return res.status(400).json({ message: 'Sin campos' });
    if (req.body.estado === 'completado') { fields.push(`fecha_completado=NOW()`); }
    values.push(req.params.id);
    const { rows } = await query(`UPDATE servicios SET ${fields.join(',')} WHERE id=$${values.length} RETURNING *`, values);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    await query(`INSERT INTO actividad (agente_id,cliente_id,accion,detalles) VALUES ($1,$2,$3,$4)`,
      [req.user.id, rows[0].cliente_id, 'servicio.actualizado', JSON.stringify({ estado: req.body.estado })]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
}

module.exports = { listar, crear, actualizar };
