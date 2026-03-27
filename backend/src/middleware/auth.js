// src/middleware/auth.js
const jwt  = require('jsonwebtoken');
const { query } = require('../models/db');

// Middleware general — verifica token y carga usuario (agente o cliente)
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
      return res.status(401).json({ message: 'Token requerido' });

    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.tipo === 'cliente') {
      const { rows } = await query(
        `SELECT id, nombre, apellido, email, telefono, estado, portal_activo FROM clientes WHERE id = $1`,
        [decoded.id]
      );
      if (!rows.length || rows[0].estado !== 'activo')
        return res.status(401).json({ message: 'Cliente no encontrado o inactivo' });
      req.user   = { ...rows[0], rol: 'cliente', tipo: 'cliente' };
      req.esCliente = true;
    } else {
      const { rows } = await query(
        `SELECT id, nombre, email, rol, estado FROM agentes WHERE id = $1`,
        [decoded.id]
      );
      if (!rows.length || rows[0].estado !== 'activo')
        return res.status(401).json({ message: 'Agente no encontrado o inactivo' });
      req.user   = { ...rows[0], tipo: 'agente' };
      req.esAgente = true;
    }

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ message: 'Token expirado' });
    return res.status(401).json({ message: 'Token inválido' });
  }
};

// Solo agentes
const soloAgente = (req, res, next) => {
  if (!req.esAgente)
    return res.status(403).json({ message: 'Solo agentes pueden acceder a esta ruta' });
  next();
};

// Solo clientes (portal)
const soloCliente = (req, res, next) => {
  if (!req.esCliente)
    return res.status(403).json({ message: 'Solo clientes pueden acceder a esta ruta' });
  next();
};

// Solo admin
const soloAdmin = (req, res, next) => {
  if (req.user?.rol !== 'admin')
    return res.status(403).json({ message: 'Solo administradores' });
  next();
};

module.exports = { authenticate, soloAgente, soloCliente, soloAdmin };
