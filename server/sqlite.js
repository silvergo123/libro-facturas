// Abre la base SQLite. Usa better-sqlite3 si está instalado (p. ej. en Render);
// si no (p. ej. Windows sin compilador), usa el SQLite incluido en Node 22+ (node:sqlite).
export async function abrirBase(ruta) {
  try {
    const { default: Database } = await import("better-sqlite3");
    return new Database(ruta);
  } catch {
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(ruta);
    let nivel = 0;
    return {
      raw,
      exec: (sql) => raw.exec(sql),
      pragma: (txt) => raw.exec(`PRAGMA ${txt}`),
      prepare: (sql) => raw.prepare(sql),
      transaction: (fn) => (...args) => {
        if (nivel > 0) return fn(...args);
        raw.exec("BEGIN");
        nivel++;
        try { const r = fn(...args); raw.exec("COMMIT"); return r; }
        catch (e) { try { raw.exec("ROLLBACK"); } catch {} throw e; }
        finally { nivel--; }
      },
      close: () => raw.close(),
    };
  }
}
