// src/models/seed.js
require('dotenv').config();
const { pool } = require('./db');
const bcrypt = require('bcryptjs');

async function seed() {
  const client = await pool.connect();
  try {
    console.log('🌱 Cargando datos de prueba...');

    // Agentes
    const passAdmin = await bcrypt.hash('Admin1234!', 12);
    const passAgente = await bcrypt.hash('Agente1234!', 12);

    await client.query(`
      INSERT INTO agentes (nombre, email, password, rol) VALUES
        ('Administrador',  'admin@corpease.com',  $1, 'admin'),
        ('Agente Demo',    'agente@corpease.com', $2, 'agente')
      ON CONFLICT (email) DO NOTHING
    `, [passAdmin, passAgente]);

    // Cliente demo con portal activo
    const passCliente = await bcrypt.hash('Cliente1234!', 12);
    const { rows: agentes } = await client.query(`SELECT id FROM agentes WHERE rol='agente' LIMIT 1`);
    const agenteId = agentes[0]?.id;

    const { rows: clientes } = await client.query(`
      INSERT INTO clientes (nombre, apellido, email, telefono, pais, origen, estado, password, portal_activo, agente_id)
      VALUES ('Carlos', 'Romero', 'carlos@demo.com', '+17869004412', 'Venezuela', 'wordpress', 'activo', $1, TRUE, $2)
      ON CONFLICT (email) DO UPDATE SET telefono = EXCLUDED.telefono
      RETURNING id
    `, [passCliente, agenteId]);

    const clienteId = clientes[0]?.id;

    if (clienteId) {
      // Vincular contacto WhatsApp
      await client.query(`
        INSERT INTO contactos (telefono, nombre, email, cliente_id)
        VALUES ('+17869004412', 'Carlos Romero', 'carlos@demo.com', $1)
        ON CONFLICT (telefono) DO UPDATE SET cliente_id = EXCLUDED.cliente_id
      `, [clienteId]);

      // Servicio demo
      const { rows: svcRows } = await client.query(`
        INSERT INTO servicios (cliente_id, tipo, nombre, estado, precio, es_recurrente)
        VALUES ($1, 'llc_formation', 'LLC Formation — Wyoming', 'en_proceso', 500.00, FALSE)
        RETURNING id
      `, [clienteId]);

      // Pago demo
      await client.query(`
        INSERT INTO pagos (cliente_id, servicio_id, monto, moneda, estado, descripcion, fecha_vencimiento)
        VALUES ($1, $2, 350.00, 'USD', 'pendiente', 'Tax Filing 2025', NOW() + INTERVAL '30 days')
      `, [clienteId, svcRows[0]?.id]);

      // Solicitud de archivo demo
      await client.query(`
        INSERT INTO solicitudes_archivos (cliente_id, agente_id, titulo, descripcion, estado)
        VALUES ($1, $2, 'Pasaporte o documento de identidad', 'Por favor envíe su pasaporte vigente para completar el proceso.', 'pendiente')
      `, [clienteId, agenteId]);
    }

    console.log('✅ Datos de prueba cargados');
    console.log('\n👤 Credenciales de prueba:');
    console.log('   Agente admin  → admin@corpease.com  / Admin1234!');
    console.log('   Agente normal → agente@corpease.com / Agente1234!');
    console.log('   Portal cliente → carlos@demo.com    / Cliente1234!');

  } catch (err) {
    console.error('❌ Error en seed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
