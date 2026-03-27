// src/models/migrate.js
require('dotenv').config();
const { pool } = require('./db');

const sql = `

-- ============================================================
-- EXTENSIONES
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TABLA: agentes  (staff interno del sistema)
-- roles: admin | agente | supervisor
-- ============================================================
CREATE TABLE IF NOT EXISTS agentes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      VARCHAR(100) NOT NULL,
  email       VARCHAR(150) UNIQUE NOT NULL,
  password    VARCHAR(255) NOT NULL,
  rol         VARCHAR(20)  DEFAULT 'agente' CHECK (rol IN ('admin','agente','supervisor')),
  estado      VARCHAR(20)  DEFAULT 'activo' CHECK (estado IN ('activo','inactivo')),
  avatar_url  TEXT,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: clientes  (rol CLIENTE — portal de auto-servicio)
-- ============================================================
CREATE TABLE IF NOT EXISTS clientes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre          VARCHAR(150) NOT NULL,
  apellido        VARCHAR(150),
  email           VARCHAR(150) UNIQUE NOT NULL,
  telefono        VARCHAR(30),            -- número WhatsApp
  pais            VARCHAR(80),
  empresa         VARCHAR(150),
  password        VARCHAR(255),           -- para login en portal
  estado          VARCHAR(20) DEFAULT 'activo' CHECK (estado IN ('activo','inactivo','archivado')),
  origen          VARCHAR(30) DEFAULT 'manual' CHECK (origen IN ('manual','wordpress','whatsapp','referido','otro')),
  agente_id       UUID REFERENCES agentes(id) ON DELETE SET NULL,
  stripe_id       TEXT,                  -- Customer ID de Stripe
  notas_internas  TEXT,
  portal_activo   BOOLEAN DEFAULT FALSE, -- ¿puede acceder al portal?
  primer_login    TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: servicios  (LLC, Tax, Registered Agent, etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS servicios (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id          UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  tipo                VARCHAR(50) NOT NULL CHECK (tipo IN (
    'llc_formation','tax_filing','registered_agent',
    'ein_application','bookkeeping','payroll','annual_report','otro'
  )),
  nombre              VARCHAR(200) NOT NULL,
  descripcion         TEXT,
  estado              VARCHAR(30) DEFAULT 'pendiente' CHECK (estado IN (
    'pendiente','en_proceso','esperando_cliente','completado','recurrente','vencido','cancelado'
  )),
  precio              NUMERIC(10,2),
  fecha_vencimiento   DATE,
  fecha_completado    TIMESTAMP,
  es_recurrente       BOOLEAN DEFAULT FALSE,
  intervalo_recurrente VARCHAR(20) CHECK (intervalo_recurrente IN ('mensual','trimestral','anual')),
  proxima_renovacion  DATE,
  notas               TEXT,
  created_at          TIMESTAMP DEFAULT NOW(),
  updated_at          TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: pagos
-- ============================================================
CREATE TABLE IF NOT EXISTS pagos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id      UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  servicio_id     UUID REFERENCES servicios(id) ON DELETE SET NULL,
  stripe_id       TEXT,
  monto           NUMERIC(10,2) NOT NULL,
  moneda          VARCHAR(5) DEFAULT 'USD',
  estado          VARCHAR(20) DEFAULT 'pendiente' CHECK (estado IN (
    'pendiente','enviado','pagado','vencido','cancelado','devuelto'
  )),
  descripcion     TEXT,
  fecha_vencimiento DATE,
  fecha_pago      TIMESTAMP,
  link_pago       TEXT,
  url_factura     TEXT,
  recordatorio_enviado BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: contactos (WhatsApp — puede o no ser un cliente)
-- ============================================================
CREATE TABLE IF NOT EXISTS contactos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telefono         VARCHAR(30) UNIQUE NOT NULL,
  nombre           VARCHAR(150),
  email            VARCHAR(150),
  empresa          VARCHAR(150),
  notas            TEXT,
  etiquetas        TEXT[],
  cliente_id       UUID REFERENCES clientes(id) ON DELETE SET NULL,
  primer_contacto  TIMESTAMP DEFAULT NOW(),
  ultimo_mensaje   TIMESTAMP DEFAULT NOW(),
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: conversaciones  (hilo de chat WhatsApp)
-- ============================================================
CREATE TABLE IF NOT EXISTS conversaciones (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contacto_id      UUID NOT NULL REFERENCES contactos(id) ON DELETE CASCADE,
  agente_id        UUID REFERENCES agentes(id) ON DELETE SET NULL,
  estado           VARCHAR(20) DEFAULT 'abierto' CHECK (estado IN ('abierto','en_proceso','resuelto','cerrado')),
  numero_caso      SERIAL,
  titulo           VARCHAR(200),
  mensajes_sin_leer INTEGER DEFAULT 0,
  ultimo_mensaje   TEXT,
  ultima_actividad TIMESTAMP DEFAULT NOW(),
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: mensajes
-- ============================================================
CREATE TABLE IF NOT EXISTS mensajes (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversacion_id     UUID NOT NULL REFERENCES conversaciones(id) ON DELETE CASCADE,
  contacto_id         UUID REFERENCES contactos(id),
  agente_id           UUID REFERENCES agentes(id),
  direccion           VARCHAR(10) NOT NULL CHECK (direccion IN ('entrante','saliente')),
  tipo                VARCHAR(20) DEFAULT 'texto' CHECK (tipo IN ('texto','text','image','document','audio','video','ubicacion')),
  contenido           TEXT,
  whatsapp_message_id VARCHAR(100) UNIQUE,
  estado              VARCHAR(20) DEFAULT 'enviado',
  created_at          TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: archivos  (documentos recibidos por WhatsApp u otras fuentes)
-- ============================================================
CREATE TABLE IF NOT EXISTS archivos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mensaje_id          UUID REFERENCES mensajes(id) ON DELETE SET NULL,
  conversacion_id     UUID REFERENCES conversaciones(id) ON DELETE CASCADE,
  contacto_id         UUID REFERENCES contactos(id) ON DELETE CASCADE,
  cliente_id          UUID REFERENCES clientes(id) ON DELETE SET NULL,
  servicio_id         UUID REFERENCES servicios(id) ON DELETE SET NULL,
  agente_asignado_id  UUID REFERENCES agentes(id) ON DELETE SET NULL,
  nombre_original     VARCHAR(255) NOT NULL,
  nombre_almacenado   VARCHAR(255) NOT NULL,
  tipo_mime           VARCHAR(100),
  extension           VARCHAR(20),
  tamanio_bytes       BIGINT,
  url_almacenamiento  TEXT NOT NULL,
  whatsapp_media_id   VARCHAR(100),
  tipo_documento      VARCHAR(100),   -- 'pasaporte', 'w9', 'ein_letter', etc.
  verificado          BOOLEAN DEFAULT FALSE,
  origen              VARCHAR(20) DEFAULT 'whatsapp' CHECK (origen IN ('whatsapp','manual','wordpress','email')),
  etiquetas           TEXT[],
  created_at          TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: solicitudes_archivos  (el agente le pide un doc al cliente)
-- ============================================================
CREATE TABLE IF NOT EXISTS solicitudes_archivos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id      UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  servicio_id     UUID REFERENCES servicios(id) ON DELETE SET NULL,
  agente_id       UUID REFERENCES agentes(id) ON DELETE SET NULL,
  titulo          VARCHAR(200) NOT NULL,
  descripcion     TEXT,
  estado          VARCHAR(20) DEFAULT 'pendiente' CHECK (estado IN ('pendiente','recibido','rechazado')),
  fecha_limite    DATE,
  archivo_id      UUID REFERENCES archivos(id) ON DELETE SET NULL,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: notificaciones
-- ============================================================
CREATE TABLE IF NOT EXISTS notificaciones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID REFERENCES clientes(id) ON DELETE CASCADE,
  agente_id   UUID REFERENCES agentes(id) ON DELETE CASCADE,
  tipo        VARCHAR(50) NOT NULL,   -- 'pago_recordatorio', 'archivo_recibido', 'servicio_actualizado', etc.
  titulo      VARCHAR(200),
  mensaje     TEXT,
  canal       VARCHAR(20) DEFAULT 'sistema' CHECK (canal IN ('sistema','email','whatsapp','todos')),
  leida       BOOLEAN DEFAULT FALSE,
  enviada     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TABLA: actividad  (audit log)
-- ============================================================
CREATE TABLE IF NOT EXISTS actividad (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id  UUID REFERENCES clientes(id) ON DELETE SET NULL,
  agente_id   UUID REFERENCES agentes(id) ON DELETE SET NULL,
  accion      VARCHAR(100) NOT NULL,
  detalles    JSONB,
  ip          VARCHAR(45),
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- ÍNDICES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_clientes_telefono     ON clientes(telefono);
CREATE INDEX IF NOT EXISTS idx_clientes_email        ON clientes(email);
CREATE INDEX IF NOT EXISTS idx_contactos_telefono    ON contactos(telefono);
CREATE INDEX IF NOT EXISTS idx_contactos_cliente     ON contactos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_conversaciones_contacto ON conversaciones(contacto_id);
CREATE INDEX IF NOT EXISTS idx_mensajes_conversacion  ON mensajes(conversacion_id);
CREATE INDEX IF NOT EXISTS idx_mensajes_waid          ON mensajes(whatsapp_message_id);
CREATE INDEX IF NOT EXISTS idx_archivos_cliente       ON archivos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_archivos_conversacion  ON archivos(conversacion_id);
CREATE INDEX IF NOT EXISTS idx_servicios_cliente      ON servicios(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pagos_cliente          ON pagos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_actividad_cliente      ON actividad(cliente_id);

-- ============================================================
-- TRIGGER updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION fn_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_agentes_upd     BEFORE UPDATE ON agentes     FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_clientes_upd    BEFORE UPDATE ON clientes    FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_servicios_upd   BEFORE UPDATE ON servicios   FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_pagos_upd       BEFORE UPDATE ON pagos       FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_contactos_upd   BEFORE UPDATE ON contactos   FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_conversaciones_upd BEFORE UPDATE ON conversaciones FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Ejecutando migraciones del sistema unificado...');
    await client.query(sql);
    console.log('✅ Base de datos lista');
  } catch (err) {
    console.error('❌ Error en migración:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
