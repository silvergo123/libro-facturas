// Copia segura de libro.db (usa la API de respaldo de SQLite, válida aunque la app esté en uso).
// Uso: node respaldo.mjs "C:\ruta\a\carpeta\de\Drive"
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const aqui = path.dirname(fileURLToPath(import.meta.url));
const Database = createRequire(path.join(aqui, "..", "server", "package.json"))("better-sqlite3");
const origen = process.env.DB_PATH || path.join(aqui, "..", "datos", "libro.db");
const destinoDir = process.argv[2];
const MANTENER = 30;

if (!destinoDir) { console.error('Falta la carpeta destino. Ej: node respaldo.mjs "G:\\Mi unidad\\Libro Facturas - Datos\\respaldos"'); process.exit(1); }
if (!fs.existsSync(origen)) { console.error("No existe la base: " + origen); process.exit(1); }
fs.mkdirSync(destinoDir, { recursive: true });

const sello = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const destino = path.join(destinoDir, `libro-${sello}.db`);
const db = new Database(origen, { readonly: true, fileMustExist: true });
await db.backup(destino);
db.close();
console.log("Respaldo creado:", destino);

const viejos = fs.readdirSync(destinoDir).filter(f => /^libro-.*\.db$/.test(f)).sort().slice(0, -MANTENER);
for (const f of viejos) fs.unlinkSync(path.join(destinoDir, f));
