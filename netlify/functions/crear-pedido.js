// Crea un pedido y descuenta el stock. El pago es SIMULADO por ahora.
const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

const H = { apikey: KEY, "Content-Type": "application/json" };
const rest = (ruta, opts = {}) =>
  fetch(`${URL_BASE}/rest/v1/${ruta}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });

const resp = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return resp(405, { error: "Método no permitido" });
  if (!URL_BASE || !KEY) return resp(500, { error: "Falta configurar las variables en Netlify" });

  let datos;
  try { datos = JSON.parse(event.body); } catch { return resp(400, { error: "Datos inválidos" }); }

  const c = datos.cliente || {};
  const nombre = String(c.nombre || "").trim().slice(0, 120);
  const telefono = String(c.telefono || "").trim().slice(0, 30);
  const direccion = String(c.direccion || "").trim().slice(0, 300);
  if (!nombre || !telefono || !direccion) return resp(400, { error: "Completa tus datos" });

  const items = (Array.isArray(datos.items) ? datos.items : [])
    .map((i) => ({ id: Number(i.id), cantidad: Number(i.cantidad) }))
    .filter((i) => Number.isInteger(i.id) && Number.isInteger(i.cantidad) && i.cantidad >= 1 && i.cantidad <= 10);
  if (!items.length) return resp(400, { error: "El carrito está vacío" });

  // 1. Revisar existencias (precio y stock salen de la base, no de la página)
  const ids = items.map((i) => i.id).join(",");
  const r = await rest(`piezas?select=id,nombre,precio,stock,activa&id=in.(${ids})`);
  const piezas = await r.json();
  const mapa = Object.fromEntries(piezas.map((p) => [p.id, p]));
  for (const i of items) {
    const p = mapa[i.id];
    if (!p || !p.activa) return resp(409, { error: "Una pieza ya no está disponible" });
    if (p.stock < i.cantidad) return resp(409, { error: `No hay suficiente stock de ${p.nombre}` });
  }

  // 2. Descontar stock (solo si sigue habiendo suficiente); si algo falla, se revierte
  const hechos = [];
  for (const i of items) {
    const p = mapa[i.id];
    const q = await rest(`piezas?id=eq.${i.id}&stock=gte.${i.cantidad}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ stock: p.stock - i.cantidad }),
    });
    const filas = await q.json();
    if (!Array.isArray(filas) || !filas.length) {
      for (const h of hechos) {
        await rest(`piezas?id=eq.${h.id}`, { method: "PATCH", body: JSON.stringify({ stock: h.stock }) });
      }
      return resp(409, { error: `No hay suficiente stock de ${p.nombre}` });
    }
    hechos.push({ id: i.id, stock: p.stock });
  }

  // 3. Guardar el pedido
  const filas = items.map((i) => ({
    pieza_id: i.id,
    cantidad: i.cantidad,
    cliente_nombre: nombre,
    cliente_telefono: telefono,
    cliente_direccion: direccion,
    estado: "pagado_simulado",
    pago_id: "SIMULADO",
  }));
  const g = await rest("pedidos", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(filas),
  });
  if (!g.ok) return resp(500, { error: "No se pudo guardar el pedido" });
  const guardados = await g.json();

  return resp(200, { ok: true, pedidos: guardados.map((x) => x.id) });
};
