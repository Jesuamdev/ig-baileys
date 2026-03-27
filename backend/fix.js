require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});
pool.query(`
  ALTER TABLE conversaciones ADD COLUMN IF NOT EXISTS etiquetas TEXT[] DEFAULT '{}';
  ALTER TABLE archivos ADD COLUMN IF NOT EXISTS origen VARCHAR(20) DEFAULT 'manual';
`).then(() => {
  console.log('✅ Columnas agregadas correctamente');
  process.exit(0);
}).catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});