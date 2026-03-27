// src/controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { query } = require('../models/db');
const logger = require('../utils/logger');

function generarToken(id, tipo, rol) {
  return jwt.sign(
    { id, tipo, rol },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// POST /api/auth/login  — agentes del panel
async function loginAgente(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email y contraseña requeridos' });

    const { rows } = await query(
      `SELECT id, nombre, email, password, rol, estado, avatar_url FROM agentes WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    const agente = rows[0];

    if (!agente || agente.estado !== 'activo')
      return res.status(401).json({ message: 'Credenciales inválidas' });

    const ok = await bcrypt.compare(password, agente.password);
    if (!ok) return res.status(401).json({ message: 'Credenciales inválidas' });

    const token = generarToken(agente.id, 'agente', agente.rol);
    logger.info(`Login agente: ${agente.email}`);

    res.json({
      token,
      usuario: { id: agente.id, nombre: agente.nombre, email: agente.email, rol: agente.rol, avatar_url: agente.avatar_url },
    });
  } catch (err) {
    logger.error('loginAgente:', err.message);
    res.status(500).json({ message: 'Error del servidor' });
  }
}

// POST /api/auth/cliente/login  — clientes del portal
async function loginCliente(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email y contraseña requeridos' });

    const { rows } = await query(
      `SELECT id, nombre, apellido, email, password, estado, portal_activo FROM clientes WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    const cliente = rows[0];

    if (!cliente || cliente.estado !== 'activo')
      return res.status(401).json({ message: 'Credenciales inválidas' });

    if (!cliente.portal_activo)
      return res.status(403).json({ message: 'Tu acceso al portal no está activado. Contacta a tu asesor.' });

    if (!cliente.password)
      return res.status(401).json({ message: 'No tienes contraseña configurada. Contacta a tu asesor.' });

    const ok = await bcrypt.compare(password, cliente.password);
    if (!ok) return res.status(401).json({ message: 'Credenciales inválidas' });

    // Registrar primer login
    await query(
      `UPDATE clientes SET primer_login = COALESCE(primer_login, NOW()) WHERE id = $1`,
      [cliente.id]
    );

    const token = generarToken(cliente.id, 'cliente', 'cliente');
    logger.info(`Login cliente: ${cliente.email}`);

    res.json({
      token,
      usuario: { id: cliente.id, nombre: cliente.nombre, apellido: cliente.apellido, email: cliente.email, tipo: 'cliente' },
    });
  } catch (err) {
    logger.error('loginCliente:', err.message);
    res.status(500).json({ message: 'Error del servidor' });
  }
}

// GET /api/auth/perfil
async function perfil(req, res) {
  res.json({ usuario: req.user });
}

// PUT /api/auth/cambiar-password
async function cambiarPassword(req, res) {
  try {
    const { password_actual, password_nuevo } = req.body;
    if (!password_actual || !password_nuevo)
      return res.status(400).json({ message: 'Faltan campos' });

    const tabla = req.esCliente ? 'clientes' : 'agentes';
    const { rows } = await query(`SELECT password FROM ${tabla} WHERE id = $1`, [req.user.id]);

    const ok = await bcrypt.compare(password_actual, rows[0]?.password || '');
    if (!ok) return res.status(400).json({ message: 'Contraseña actual incorrecta' });

    const hash = await bcrypt.hash(password_nuevo, 12);
    await query(`UPDATE ${tabla} SET password = $1 WHERE id = $2`, [hash, req.user.id]);

    res.json({ message: 'Contraseña actualizada' });
  } catch (err) {
    logger.error('cambiarPassword:', err.message);
    res.status(500).json({ message: 'Error del servidor' });
  }
}

module.exports = { loginAgente, loginCliente, perfil, cambiarPassword };
