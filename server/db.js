import Database from "better-sqlite3";
import { PROVEEDORES, PRESENTACIONES, PLANES } from "./catalogo.js";

const db = new Database(process.env.DB_PATH || "libro.db");
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS planes (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  precio REAL NOT NULL,
  max_facturas_mes INTEGER NOT NULL,
  max_sesiones INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cuentas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono TEXT UNIQUE NOT NULL,
  nombre_negocio TEXT,
  plan_id TEXT NOT NULL DEFAULT 'prueba' REFERENCES planes(id),
  estado TEXT NOT NULL DEFAULT 'prueba',        -- prueba|activa|vencida|suspendida
  periodo_fin TEXT,                              -- ISO date; null en prueba
  facturas_prueba_usadas INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cuenta_id INTEGER NOT NULL REFERENCES cuentas(id),
  telefono TEXT NOT NULL,
  nombre TEXT,
  rol TEXT NOT NULL DEFAULT 'dueño',
  session_id TEXT,
  ultimo_acceso TEXT
);

CREATE TABLE IF NOT EXISTS codigos_otp (
  telefono TEXT PRIMARY KEY,
  codigo TEXT NOT NULL,
  expira_en INTEGER NOT NULL,
  intentos INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS proveedores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cuenta_id INTEGER REFERENCES cuentas(id),   -- null = global
  nombre TEXT NOT NULL,
  rnc TEXT,
  regla TEXT
);

CREATE TABLE IF NOT EXISTS presentaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cuenta_id INTEGER REFERENCES cuentas(id),   -- null = global
  proveedor TEXT NOT NULL,
  producto TEXT NOT NULL,
  unidades INTEGER NOT NULL,
  UNIQUE(cuenta_id, proveedor, producto)
);

CREATE TABLE IF NOT EXISTS facturas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cuenta_id INTEGER NOT NULL REFERENCES cuentas(id),
  proveedor TEXT NOT NULL,
  fecha TEXT NOT NULL,
  ncf TEXT,
  total REAL NOT NULL DEFAULT 0,
  deposito_envases REAL NOT NULL DEFAULT 0,
  origen TEXT NOT NULL DEFAULT 'manual',
  creado_por INTEGER,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS renglones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  factura_id INTEGER NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
  cuenta_id INTEGER NOT NULL REFERENCES cuentas(id),
  proveedor TEXT NOT NULL,
  fecha TEXT NOT NULL,
  producto TEXT NOT NULL,
  categoria TEXT,
  cantidad REAL NOT NULL DEFAULT 1,
  unidad_compra TEXT,
  precio_unidad_compra REAL NOT NULL,
  itbis_unidad_compra REAL,
  unidades INTEGER NOT NULL DEFAULT 1,
  precio_por_unidad REAL NOT NULL,
  precio_por_unidad_sin REAL,
  exento INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS consumo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cuenta_id INTEGER NOT NULL REFERENCES cuentas(id),
  tipo TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pagos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cuenta_id INTEGER NOT NULL REFERENCES cuentas(id),
  monto REAL NOT NULL,
  metodo TEXT NOT NULL,
  referencia TEXT,
  periodo_inicio TEXT NOT NULL,
  periodo_fin TEXT NOT NULL,
  registrado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_renglones_cuenta ON renglones(cuenta_id);
CREATE INDEX IF NOT EXISTS idx_renglones_producto ON renglones(cuenta_id, producto);
CREATE INDEX IF NOT EXISTS idx_facturas_cuenta ON facturas(cuenta_id);
`);

// --- Semilla del catálogo global ---
const insPlan = db.prepare(
  `INSERT INTO planes (id,nombre,precio,max_facturas_mes,max_sesiones)
   VALUES (?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET nombre=excluded.nombre, precio=excluded.precio,
     max_facturas_mes=excluded.max_facturas_mes, max_sesiones=excluded.max_sesiones`
);
for (const p of PLANES) insPlan.run(p.id, p.nombre, p.precio, p.max_facturas_mes, p.max_sesiones);

const hayProv = db.prepare("SELECT COUNT(*) c FROM proveedores WHERE cuenta_id IS NULL").get().c;
if (!hayProv) {
  const ins = db.prepare("INSERT INTO proveedores (cuenta_id,nombre,rnc,regla) VALUES (NULL,?,?,?)");
  const tx = db.transaction(() => { for (const p of PROVEEDORES) ins.run(p.nombre, p.rnc, p.regla); });
  tx();
}

const hayPres = db.prepare("SELECT COUNT(*) c FROM presentaciones WHERE cuenta_id IS NULL").get().c;
if (!hayPres) {
  const ins = db.prepare("INSERT OR IGNORE INTO presentaciones (cuenta_id,proveedor,producto,unidades) VALUES (NULL,?,?,?)");
  const tx = db.transaction(() => { for (const [prov, prod, u] of PRESENTACIONES) ins.run(prov, prod, u); });
  tx();
}

export default db;
