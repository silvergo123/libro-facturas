import express from "express";
import cors from "cors";
import crypto from "crypto";
import db from "./db.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.static("../app"));

const PORT = process.env.PORT || 3000;
const DEV = process.env.NODE_ENV !== "production";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin-dev";

/* ------------------------------------------------------------------ */
/*  Utilidades                                                         */
/* ------------------------------------------------------------------ */
const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
const hoy = () => new Date().toISOString().slice(0, 10);
const mesActual = () => new Date().toISOString().slice(0, 7);
const token = () => crypto.randomBytes(24).toString("hex");

function sumarMes(fechaISO) {
  const d = new Date(fechaISO + "T00:00:00");
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/** Estado real de la cuenta, calculado por fecha — no por un flag suelto. */
function estadoCuenta(cuenta) {
  if (cuenta.plan_id === "prueba") return "prueba";
  if (!cuenta.periodo_fin) return "suspendida";
  const dias = Math.floor((new Date(cuenta.periodo_fin) - new Date(hoy())) / 86400000);
  if (dias >= 0) return "activa";
  if (dias >= -7) return "vencida";      // gracia: lee pero no procesa
  return "suspendida";                    // solo lectura; NUNCA se borran datos
}

function facturasEsteMes(cuentaId) {
  return db.prepare(
    "SELECT COUNT(*) c FROM facturas WHERE cuenta_id=? AND substr(creado_en,1,7)=?"
  ).get(cuentaId, mesActual()).c;
}

/* ------------------------------------------------------------------ */
/*  Middleware de autenticación (una sesión activa por usuario)        */
/* ------------------------------------------------------------------ */
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: "Falta el token de sesión." });

  const usuario = db.prepare("SELECT * FROM usuarios WHERE session_id=?").get(t);
  if (!usuario) {
    return res.status(401).json({
      error: "Su sesión se cerró porque entraron desde otro dispositivo.",
      codigo: "SESION_INVALIDA",
    });
  }

  const cuenta = db.prepare("SELECT * FROM cuentas WHERE id=?").get(usuario.cuenta_id);
  const plan = db.prepare("SELECT * FROM planes WHERE id=?").get(cuenta.plan_id);

  db.prepare("UPDATE usuarios SET ultimo_acceso=datetime('now') WHERE id=?").run(usuario.id);

  req.usuario = usuario;
  req.cuenta = cuenta;
  req.plan = plan;
  req.estado = estadoCuenta(cuenta);
  next();
}

/** Bloquea escrituras cuando la cuenta no está al día o agotó su límite. */
function puedeProcesar(req, res, next) {
  if (req.estado === "vencida")
    return res.status(402).json({ error: "Su suscripción venció. Puede consultar su historial, pero para registrar facturas nuevas debe reactivar.", codigo: "VENCIDA" });
  if (req.estado === "suspendida")
    return res.status(402).json({ error: "Su cuenta está suspendida. Su historial sigue intacto; reactive para continuar.", codigo: "SUSPENDIDA" });

  if (req.estado === "prueba") {
    if (req.cuenta.facturas_prueba_usadas >= req.plan.max_facturas_mes)
      return res.status(402).json({ error: `Se acabaron sus ${req.plan.max_facturas_mes} facturas de prueba.`, codigo: "PRUEBA_AGOTADA" });
  } else if (facturasEsteMes(req.cuenta.id) >= req.plan.max_facturas_mes) {
    return res.status(402).json({ error: `Llegó al límite de ${req.plan.max_facturas_mes} facturas de su plan este mes.`, codigo: "LIMITE_MES" });
  }
  next();
}

/* ------------------------------------------------------------------ */
/*  FASE 1 — Autenticación por teléfono con código                     */
/* ------------------------------------------------------------------ */
app.post("/api/auth/solicitar", (req, res) => {
  const telefono = (req.body.telefono || "").replace(/\D/g, "");
  if (telefono.length < 10) return res.status(400).json({ error: "Número de teléfono inválido." });

  const codigo = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare(
    `INSERT INTO codigos_otp (telefono,codigo,expira_en,intentos) VALUES (?,?,?,0)
     ON CONFLICT(telefono) DO UPDATE SET codigo=excluded.codigo, expira_en=excluded.expira_en, intentos=0`
  ).run(telefono, codigo, Date.now() + 10 * 60 * 1000);

  // PRODUCCIÓN: enviar por WhatsApp Business API / SMS.
  console.log(`[OTP] ${telefono} → ${codigo}`);

  // Se muestra en pantalla si está en desarrollo o si se activa MOSTRAR_CODIGO.
  // Úselo solo mientras usted sea el único usuario.
  const mostrar = DEV || process.env.MOSTRAR_CODIGO === "true";
  res.json({ ok: true, ...(mostrar ? { codigo_dev: codigo } : {}) });
});

app.post("/api/auth/verificar", (req, res) => {
  const telefono = (req.body.telefono || "").replace(/\D/g, "");
  const codigo = (req.body.codigo || "").trim();

  // Código maestro: le permite entrar siempre, mientras no esté conectado el
  // envío por WhatsApp. Defínalo con la variable CODIGO_MAESTRO.
  // ⚠️ Quítelo en cuanto le dé acceso a otra persona.
  const maestro = process.env.CODIGO_MAESTRO;
  const esMaestro = maestro && codigo === maestro;

  if (!esMaestro) {
    const fila = db.prepare("SELECT * FROM codigos_otp WHERE telefono=?").get(telefono);
    if (!fila) return res.status(400).json({ error: "Solicite un código primero." });
    if (Date.now() > fila.expira_en) return res.status(400).json({ error: "El código venció. Solicite uno nuevo." });
    if (fila.intentos >= 5) return res.status(429).json({ error: "Demasiados intentos. Solicite un código nuevo." });
    if (fila.codigo !== codigo) {
      db.prepare("UPDATE codigos_otp SET intentos=intentos+1 WHERE telefono=?").run(telefono);
      return res.status(400).json({ error: "Código incorrecto." });
    }
  }
  db.prepare("DELETE FROM codigos_otp WHERE telefono=?").run(telefono);

  let cuenta = db.prepare("SELECT * FROM cuentas WHERE telefono=?").get(telefono);
  if (!cuenta) {
    const r = db.prepare("INSERT INTO cuentas (telefono,plan_id,estado) VALUES (?,'prueba','prueba')").run(telefono);
    cuenta = db.prepare("SELECT * FROM cuentas WHERE id=?").get(r.lastInsertRowid);
    db.prepare("INSERT INTO usuarios (cuenta_id,telefono,rol) VALUES (?,?,'dueño')").run(cuenta.id, telefono);
  }

  let usuario = db.prepare("SELECT * FROM usuarios WHERE cuenta_id=? AND telefono=?").get(cuenta.id, telefono);
  if (!usuario) {
    const r = db.prepare("INSERT INTO usuarios (cuenta_id,telefono,rol) VALUES (?,?,'encargado')").run(cuenta.id, telefono);
    usuario = db.prepare("SELECT * FROM usuarios WHERE id=?").get(r.lastInsertRowid);
  }

  // Una sesión activa: el token nuevo invalida el anterior.
  const t = token();
  db.prepare("UPDATE usuarios SET session_id=?, ultimo_acceso=datetime('now') WHERE id=?").run(t, usuario.id);

  res.json({ token: t, cuenta: { id: cuenta.id, nombre_negocio: cuenta.nombre_negocio, plan: cuenta.plan_id, estado: estadoCuenta(cuenta) } });
});

app.get("/api/me", auth, (req, res) => {
  const usadas = req.estado === "prueba" ? req.cuenta.facturas_prueba_usadas : facturasEsteMes(req.cuenta.id);
  res.json({
    telefono: req.usuario.telefono,
    rol: req.usuario.rol,
    nombre_negocio: req.cuenta.nombre_negocio,
    plan: { id: req.plan.id, nombre: req.plan.nombre, max_facturas_mes: req.plan.max_facturas_mes },
    estado: req.estado,
    periodo_fin: req.cuenta.periodo_fin,
    facturas_usadas: usadas,
    facturas_restantes: Math.max(0, req.plan.max_facturas_mes - usadas),
  });
});

app.post("/api/me", auth, (req, res) => {
  const nombre = (req.body.nombre_negocio || "").trim().slice(0, 80);
  db.prepare("UPDATE cuentas SET nombre_negocio=? WHERE id=?").run(nombre, req.cuenta.id);
  res.json({ ok: true });
});

app.post("/api/auth/salir", auth, (req, res) => {
  db.prepare("UPDATE usuarios SET session_id=NULL WHERE id=?").run(req.usuario.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/*  Catálogo (global + propio de la cuenta)                            */
/* ------------------------------------------------------------------ */
app.get("/api/catalogo", auth, (req, res) => {
  const proveedores = db.prepare(
    "SELECT nombre, rnc FROM proveedores WHERE cuenta_id IS NULL OR cuenta_id=? ORDER BY nombre"
  ).all(req.cuenta.id);
  const presentaciones = db.prepare(
    "SELECT proveedor, producto, unidades FROM presentaciones WHERE cuenta_id IS NULL OR cuenta_id=?"
  ).all(req.cuenta.id);
  res.json({ proveedores, presentaciones });
});

/* ------------------------------------------------------------------ */
/*  Extracción de factura por foto — SIEMPRE en el servidor            */
/*  (es la función costosa: sin cuenta activa, no corre)               */
/* ------------------------------------------------------------------ */
app.post("/api/facturas/extraer", auth, puedeProcesar, async (req, res) => {
  const { imagen_base64, media_type } = req.body;
  if (!imagen_base64) return res.status(400).json({ error: "Falta la imagen." });
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(503).json({ error: "El servidor no tiene configurada la clave de IA (ANTHROPIC_API_KEY)." });

  const proveedores = db.prepare("SELECT nombre, rnc, regla FROM proveedores WHERE cuenta_id IS NULL OR cuenta_id=?").all(req.cuenta.id);
  const presentaciones = db.prepare("SELECT proveedor, producto, unidades FROM presentaciones WHERE cuenta_id IS NULL OR cuenta_id=?").all(req.cuenta.id);

  const refProv = proveedores
    .map((p) => `- "${p.nombre}"${p.rnc ? ` (RNC ${p.rnc})` : ""}: ${p.regla || ""}`)
    .join("\n");
  const refPres = presentaciones
    .map((p) => `- ${p.proveedor} | ${p.producto} = ${p.unidades} un.`)
    .join("\n");

  const system = `Extraes datos de facturas dominicanas. Devuelve SOLO JSON válido, sin backticks ni texto extra.

PROVEEDORES CONOCIDOS Y DE QUÉ COLUMNA SALE EL PRECIO (crítico: usar la columna equivocada corrompe todo):
${refProv}

PRESENTACIONES CONFIRMADAS (proveedor | producto = unidades por empaque):
${refPres}

Reglas:
1. Identifica el proveedor por nombre, RNC o formato de columnas. Usa EXACTAMENTE el nombre de la lista aunque en la imagen esté escrito distinto o borroso. Si no coincide con ninguno, usa el nombre tal cual aparece.
2. Aplica la regla de columna de ESE proveedor para "precio_unidad_compra". No asumas que siempre es la columna "Precio".
3. Para "unidades": busca primero en las presentaciones confirmadas por proveedor+producto. Si no está, úsalo solo si la descripción lo indica explícitamente (ej. "x 20 Un", "24/9"). Si no es claro, pon null — NO inventes.
4. Marca "exento": true si el renglón no tiene ITBIS.
5. Si un renglón está en 0.00, ponlo igual con nota_revisar explicando si parece bonificación o rechazo.
6. Depósitos de envases retornables van en "deposito_envases", NO como renglón de producto.

Formato:
{"proveedor":"string","fecha":"YYYY-MM-DD","ncf":"string|null","deposito_envases":number,
 "renglones":[{"producto":"string","categoria":"string|null","cantidad":number,"unidad_compra":"string",
 "precio_unidad_compra":number,"itbis_unidad_compra":number|null,"unidades":number|null,
 "exento":boolean,"nota_revisar":"string|null"}]}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.MODELO || "claude-sonnet-4-6",
        max_tokens: 4000,
        system,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: media_type || "image/jpeg", data: imagen_base64 } },
            { type: "text", text: "Extrae los datos de esta factura." },
          ],
        }],
      }),
    });

    if (!r.ok) {
      const detalle = await r.text();
      console.error("Error de la API de IA:", detalle.slice(0, 500));
      return res.status(502).json({ error: "No se pudo procesar la imagen en este momento." });
    }

    const data = await r.json();
    const texto = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const limpio = texto.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(limpio);

    db.prepare("INSERT INTO consumo (cuenta_id,tipo) VALUES (?, 'ocr')").run(req.cuenta.id);

    // Completa unidades desde el catálogo cuando la IA no las determinó
    const mapa = new Map(presentaciones.map((p) => [norm(p.proveedor) + "::" + norm(p.producto), p.unidades]));
    for (const g of parsed.renglones || []) {
      if (!g.unidades) {
        const u = mapa.get(norm(parsed.proveedor) + "::" + norm(g.producto));
        if (u) g.unidades = u;
      }
    }
    res.json(parsed);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo leer la factura. Intente con otra foto o regístrela a mano." });
  }
});

/* ------------------------------------------------------------------ */
/*  Facturas — el cálculo del precio por unidad ocurre AQUÍ            */
/* ------------------------------------------------------------------ */
app.post("/api/facturas", auth, puedeProcesar, (req, res) => {
  const { proveedor, fecha, ncf, renglones, deposito_envases, origen } = req.body;
  if (!proveedor || !fecha || !Array.isArray(renglones) || !renglones.length)
    return res.status(400).json({ error: "Faltan datos de la factura." });

  if (ncf) {
    const dup = db.prepare("SELECT id FROM facturas WHERE cuenta_id=? AND proveedor=? AND ncf=?")
      .get(req.cuenta.id, proveedor, ncf);
    if (dup) return res.status(409).json({ error: "Esa factura ya está registrada.", factura_id: dup.id });
  }

  const tx = db.transaction(() => {
    const f = db.prepare(
      "INSERT INTO facturas (cuenta_id,proveedor,fecha,ncf,total,deposito_envases,origen,creado_por) VALUES (?,?,?,?,0,?,?,?)"
    ).run(req.cuenta.id, proveedor, fecha, ncf || null, Number(deposito_envases) || 0, origen || "manual", req.usuario.id);

    const insR = db.prepare(`INSERT INTO renglones
      (factura_id,cuenta_id,proveedor,fecha,producto,categoria,cantidad,unidad_compra,
       precio_unidad_compra,itbis_unidad_compra,unidades,precio_por_unidad,precio_por_unidad_sin,exento)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insP = db.prepare(
      `INSERT INTO presentaciones (cuenta_id,proveedor,producto,unidades) VALUES (?,?,?,?)
       ON CONFLICT(cuenta_id,proveedor,producto) DO UPDATE SET unidades=excluded.unidades`
    );

    let total = 0;
    for (const g of renglones) {
      const cantidad = Number(g.cantidad) || 1;
      const precioUC = Number(g.precio_unidad_compra) || 0;
      const unidades = Math.max(1, parseInt(g.unidades) || 1);
      const exento = g.exento ? 1 : 0;
      const itbis = g.itbis_unidad_compra != null && g.itbis_unidad_compra !== "" ? Number(g.itbis_unidad_compra) : null;

      const porUnidad = precioUC / unidades;
      const porUnidadSin = itbis != null ? (precioUC - itbis) / unidades : (exento ? porUnidad : null);

      insR.run(f.lastInsertRowid, req.cuenta.id, proveedor, fecha, String(g.producto).trim(),
        g.categoria || null, cantidad, g.unidad_compra || null, precioUC, itbis, unidades,
        porUnidad, porUnidadSin, exento);

      total += precioUC * cantidad;
      // La cuenta aprende sus propias presentaciones
      insP.run(req.cuenta.id, proveedor, String(g.producto).trim(), unidades);
    }

    db.prepare("UPDATE facturas SET total=? WHERE id=?").run(total, f.lastInsertRowid);
    if (req.estado === "prueba")
      db.prepare("UPDATE cuentas SET facturas_prueba_usadas=facturas_prueba_usadas+1 WHERE id=?").run(req.cuenta.id);

    return f.lastInsertRowid;
  });

  const id = tx();
  res.json({ ok: true, factura_id: id });
});

app.get("/api/facturas", auth, (req, res) => {
  const filas = db.prepare(
    "SELECT id,proveedor,fecha,ncf,total,deposito_envases FROM facturas WHERE cuenta_id=? ORDER BY fecha DESC, id DESC LIMIT 300"
  ).all(req.cuenta.id);
  res.json(filas);
});

app.get("/api/facturas/:id", auth, (req, res) => {
  const f = db.prepare("SELECT * FROM facturas WHERE id=? AND cuenta_id=?").get(req.params.id, req.cuenta.id);
  if (!f) return res.status(404).json({ error: "Factura no encontrada." });
  f.renglones = db.prepare("SELECT * FROM renglones WHERE factura_id=?").all(f.id);
  res.json(f);
});

app.delete("/api/facturas/:id", auth, (req, res) => {
  const r = db.prepare("DELETE FROM facturas WHERE id=? AND cuenta_id=?").run(req.params.id, req.cuenta.id);
  if (!r.changes) return res.status(404).json({ error: "Factura no encontrada." });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/*  Comparaciones — calculadas en el servidor, viajan ya resueltas     */
/* ------------------------------------------------------------------ */
app.get("/api/productos", auth, (req, res) => {
  const filas = db.prepare(`
    SELECT producto,
           COUNT(DISTINCT proveedor) suplidores,
           COUNT(*) compras,
           MIN(precio_por_unidad) minimo,
           MAX(precio_por_unidad) maximo
    FROM renglones WHERE cuenta_id=?
    GROUP BY producto ORDER BY producto`).all(req.cuenta.id);

  for (const f of filas) {
    if (f.suplidores > 1) {
      f.mejor_proveedor = db.prepare(
        "SELECT proveedor FROM renglones WHERE cuenta_id=? AND producto=? ORDER BY precio_por_unidad ASC LIMIT 1"
      ).get(req.cuenta.id, f.producto)?.proveedor;
    }
  }
  res.json(filas);
});

app.get("/api/comparar", auth, (req, res) => {
  const producto = req.query.producto;
  if (!producto) return res.status(400).json({ error: "Falta el producto." });
  const filas = db.prepare(`
    SELECT proveedor, fecha, precio_unidad_compra, unidades,
           precio_por_unidad, precio_por_unidad_sin, cantidad, unidad_compra
    FROM renglones WHERE cuenta_id=? AND producto=? ORDER BY fecha ASC`).all(req.cuenta.id, producto);
  res.json(filas);
});

app.get("/api/suplidores", auth, (req, res) => {
  const filas = db.prepare("SELECT proveedor, producto, precio_por_unidad, precio_unidad_compra, cantidad, unidades FROM renglones WHERE cuenta_id=?").all(req.cuenta.id);
  if (!filas.length) return res.json({ suplidores: [], oportunidades: [] });

  const gastoTotal = filas.reduce((s, f) => s + f.precio_unidad_compra * f.cantidad, 0);
  const productosTotales = new Set(filas.map((f) => norm(f.producto)));

  const gasto = {}, prods = {}, porProducto = {};
  for (const f of filas) {
    gasto[f.proveedor] = (gasto[f.proveedor] || 0) + f.precio_unidad_compra * f.cantidad;
    (prods[f.proveedor] ||= new Set()).add(norm(f.producto));
    ((porProducto[norm(f.producto)] ||= {})[f.proveedor] ||= []).push(f);
  }

  const ratios = {}, ganados = {}, comparados = {}, oportunidades = [];
  for (const [, mapa] of Object.entries(porProducto)) {
    const provs = Object.keys(mapa);
    if (provs.length < 2) continue;
    const prom = {};
    for (const p of provs) prom[p] = mapa[p].reduce((s, r) => s + r.precio_por_unidad, 0) / mapa[p].length;
    const mejor = Math.min(...Object.values(prom));
    const mejorProv = provs.find((p) => prom[p] === mejor);

    for (const p of provs) {
      comparados[p] = (comparados[p] || 0) + 1;
      if (mejor > 0) (ratios[p] ||= []).push(prom[p] / mejor);
      if (prom[p] === mejor) ganados[p] = (ganados[p] || 0) + 1;
      else {
        const ult = mapa[p][mapa[p].length - 1];
        oportunidades.push({
          producto: ult.producto, proveedor_caro: p, proveedor_barato: mejorProv,
          precio_caro: prom[p], precio_barato: mejor,
          ahorro_unidad: prom[p] - mejor,
          ahorro_compra: (prom[p] - mejor) * ult.unidades * (ult.cantidad || 1),
        });
      }
    }
  }

  const suplidores = Object.keys(gasto).map((p) => {
    const rs = ratios[p];
    const score = rs?.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
    return {
      proveedor: p,
      gasto: gasto[p],
      pct_gasto: gastoTotal ? (gasto[p] / gastoTotal) * 100 : 0,
      productos: prods[p].size,
      pct_productos: (prods[p].size / productosTotales.size) * 100,
      comparados: comparados[p] || 0,
      ganados: ganados[p] || 0,
      score,
      sobreprecio_pct: score != null ? (score - 1) * 100 : null,
    };
  }).sort((a, b) => (a.score ?? 99) - (b.score ?? 99) || b.gasto - a.gasto);

  oportunidades.sort((a, b) => b.ahorro_compra - a.ahorro_compra);
  res.json({ suplidores, oportunidades: oportunidades.slice(0, 20), gasto_total: gastoTotal });
});

app.get("/api/resumen", auth, (req, res) => {
  const r = db.prepare(`SELECT COUNT(*) facturas,
      (SELECT COUNT(DISTINCT proveedor) FROM facturas WHERE cuenta_id=?) suplidores,
      (SELECT COUNT(DISTINCT producto) FROM renglones WHERE cuenta_id=?) productos,
      COALESCE(SUM(total),0) gasto
    FROM facturas WHERE cuenta_id=?`).get(req.cuenta.id, req.cuenta.id, req.cuenta.id);
  res.json(r);
});

/* ------------------------------------------------------------------ */
/*  FASE 3 — Cobro: panel administrativo                               */
/*  Sirve igual para tarjeta, transferencia o efectivo: todo termina   */
/*  extendiendo periodo_fin.                                           */
/* ------------------------------------------------------------------ */
function admin(req, res, next) {
  if ((req.headers["x-admin-token"] || "") !== ADMIN_TOKEN)
    return res.status(403).json({ error: "No autorizado." });
  next();
}

app.get("/api/admin/cuentas", admin, (req, res) => {
  const filas = db.prepare("SELECT * FROM cuentas ORDER BY creado_en DESC").all();
  res.json(filas.map((c) => {
    const u = db.prepare("SELECT telefono, rol, ultimo_acceso, session_id FROM usuarios WHERE cuenta_id=?").all(c.id);
    return {
      ...c,
      estado_real: estadoCuenta(c),
      facturas_mes: facturasEsteMes(c.id),
      facturas_total: db.prepare("SELECT COUNT(*) c FROM facturas WHERE cuenta_id=?").get(c.id).c,
      ocr_usados: db.prepare("SELECT COUNT(*) c FROM consumo WHERE cuenta_id=? AND tipo='ocr'").get(c.id).c,
      usuarios: u.map((x) => ({ telefono: x.telefono, rol: x.rol, ultimo_acceso: x.ultimo_acceso, conectado: !!x.session_id })),
    };
  }));
});

/** Códigos de acceso pendientes — resuelve el caso de "no me llegó el código". */
app.get("/api/admin/codigos", admin, (req, res) => {
  const filas = db.prepare("SELECT telefono, codigo, expira_en, intentos FROM codigos_otp").all();
  res.json(filas.map((f) => ({
    telefono: f.telefono,
    codigo: f.codigo,
    intentos: f.intentos,
    vencido: Date.now() > f.expira_en,
    minutos_restantes: Math.max(0, Math.round((f.expira_en - Date.now()) / 60000)),
  })));
});

/** Cambiar de plan sin registrar un pago (para pruebas o cortesías). */
app.post("/api/admin/plan", admin, (req, res) => {
  const { cuenta_id, plan_id, meses } = req.body;
  const cuenta = db.prepare("SELECT * FROM cuentas WHERE id=?").get(cuenta_id);
  if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada." });
  const plan = db.prepare("SELECT * FROM planes WHERE id=?").get(plan_id);
  if (!plan) return res.status(400).json({ error: "Plan inválido." });

  if (plan_id === "prueba") {
    db.prepare("UPDATE cuentas SET plan_id='prueba', estado='prueba', periodo_fin=NULL WHERE id=?").run(cuenta_id);
    return res.json({ ok: true, plan: "prueba" });
  }
  let fin = cuenta.periodo_fin && cuenta.periodo_fin > hoy() ? cuenta.periodo_fin : hoy();
  for (let i = 0; i < (parseInt(meses) || 1); i++) fin = sumarMes(fin);
  db.prepare("UPDATE cuentas SET plan_id=?, periodo_fin=?, estado='activa' WHERE id=?").run(plan_id, fin, cuenta_id);
  res.json({ ok: true, plan: plan_id, periodo_fin: fin });
});

/** Cerrar la sesión activa de una cuenta (soporte). */
app.post("/api/admin/cerrar-sesion", admin, (req, res) => {
  db.prepare("UPDATE usuarios SET session_id=NULL WHERE cuenta_id=?").run(req.body.cuenta_id);
  res.json({ ok: true });
});

app.get("/api/admin/resumen", admin, (req, res) => {
  const cuentas = db.prepare("SELECT * FROM cuentas").all();
  const activas = cuentas.filter((c) => estadoCuenta(c) === "activa").length;
  const prueba = cuentas.filter((c) => estadoCuenta(c) === "prueba").length;
  res.json({
    cuentas: cuentas.length,
    activas,
    prueba,
    vencidas: cuentas.length - activas - prueba,
    facturas: db.prepare("SELECT COUNT(*) c FROM facturas").get().c,
    ocr_mes: db.prepare("SELECT COUNT(*) c FROM consumo WHERE tipo='ocr' AND substr(creado_en,1,7)=?").get(mesActual()).c,
    ingreso_mes: db.prepare("SELECT COALESCE(SUM(monto),0) s FROM pagos WHERE substr(registrado_en,1,7)=?").get(mesActual()).s,
    envio_codigos: DEV || process.env.MOSTRAR_CODIGO === "true" ? "visible en pantalla" : "requiere WhatsApp/SMS",
    codigo_maestro: process.env.CODIGO_MAESTRO ? "activo" : "no configurado",
  });
});

app.post("/api/admin/pago", admin, (req, res) => {
  const { cuenta_id, plan_id, monto, metodo, referencia, meses } = req.body;
  const cuenta = db.prepare("SELECT * FROM cuentas WHERE id=?").get(cuenta_id);
  if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada." });

  const base = cuenta.periodo_fin && cuenta.periodo_fin > hoy() ? cuenta.periodo_fin : hoy();
  let fin = base;
  for (let i = 0; i < (parseInt(meses) || 1); i++) fin = sumarMes(fin);

  db.prepare("INSERT INTO pagos (cuenta_id,monto,metodo,referencia,periodo_inicio,periodo_fin) VALUES (?,?,?,?,?,?)")
    .run(cuenta_id, Number(monto) || 0, metodo || "efectivo", referencia || null, base, fin);
  db.prepare("UPDATE cuentas SET plan_id=?, periodo_fin=?, estado='activa' WHERE id=?")
    .run(plan_id || cuenta.plan_id, fin, cuenta_id);

  res.json({ ok: true, periodo_fin: fin });
});

app.get("/api/planes", (req, res) => {
  res.json(db.prepare("SELECT * FROM planes ORDER BY precio").all());
});

/* ------------------------------------------------------------------ */
/*  Verificación del APK (Trusted Web Activity)                        */
/*  Sin esto, la app instalada muestra la barra del navegador arriba.  */
/*  Pega aquí el JSON que te da PWABuilder al generar el paquete.      */
/* ------------------------------------------------------------------ */
app.get("/.well-known/assetlinks.json", (req, res) => {
  const huella = process.env.APK_FINGERPRINT;   // SHA-256 del keystore
  const paquete = process.env.APK_PACKAGE_ID;   // ej. com.tunegocio.libro
  if (!huella || !paquete) {
    return res.status(404).json({
      error: "Aún no configurado. Defina APK_PACKAGE_ID y APK_FINGERPRINT como variables de entorno.",
    });
  }
  res.type("application/json").json([{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: paquete,
      sha256_cert_fingerprints: [huella],
    },
  }]);
});

app.listen(PORT, () => {
  console.log(`Libro de Facturas — servidor en http://localhost:${PORT}`);
  if (DEV) console.log("Modo desarrollo: los códigos OTP se muestran en consola y en la respuesta.");
  if (!process.env.ANTHROPIC_API_KEY) console.log("⚠️  Sin ANTHROPIC_API_KEY: el registro por foto estará deshabilitado (el manual sí funciona).");
});
