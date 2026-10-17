'use strict';
/* =========================================================
   Bodega · Inventario
   Aplicación 100% en el navegador (HTML + CSS + JS, sin servidor).
   Los datos se guardan en el localStorage del navegador.
   ========================================================= */

/* ---------------- Conexión con la nube (Supabase) ----------------
   La URL y la "publishable key" son públicas a propósito: los datos
   están protegidos por las reglas de seguridad (RLS) de la base de datos,
   que solo dejan leer/escribir a quien entró con la clave de la bodega. */
const SUPA_URL = 'https://njmqeyeadxdqdgtjrhec.supabase.co';
const SUPA_KEY = 'sb_publishable_7jQYU_efxjnPAzvPzMienw_-im0wsZa';

const LEGACY_KEY = 'bodega.data.v1';   // datos de la versión anterior (solo navegador)
const CART_KEY = 'bodega.cart.v1';     // el carrito es de cada equipo
const USER_KEY = 'bodega.usuario';
const EMAIL_KEY = 'bodega.email';
const COLS = ['productos', 'proveedores', 'movimientos', 'devoluciones', 'pedidos', 'ventas'];
const supa = window.supabase
  ? window.supabase.createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };
const lsDel = k => { try { localStorage.removeItem(k); } catch { /* */ } };

function defaultData() {
  return {
    version: 1,
    config: {
      nombre: 'Mi Bodega',
      moneda: 'S/',
      stockMinGlobal: 5,
      rotDias: 30,
      rotRapida: 20,
      rotNormal: 5,
      categorias: ['Abarrotes', 'Bebidas', 'Lácteos', 'Limpieza', 'Cuidado personal', 'Snacks'],
    },
    counters: { prod: 0, prov: 0, dev: 0, ped: 0, venta: 0 },
    productos: [], proveedores: [], movimientos: [], devoluciones: [], pedidos: [], ventas: [],
  };
}
function normalizeData(d) {
  const base = defaultData();
  if (!d || typeof d !== 'object') return base;
  d.config = Object.assign(base.config, d.config || {});
  if (!Array.isArray(d.config.categorias)) d.config.categorias = [];
  d.counters = Object.assign(base.counters, d.counters || {});
  for (const k of ['productos', 'proveedores', 'movimientos', 'devoluciones', 'pedidos', 'ventas']) {
    if (!Array.isArray(d[k])) d[k] = [];
  }
  return d;
}
let S = defaultData();
let CART = (() => {
  try { const c = JSON.parse(lsGet(CART_KEY) || '[]'); return Array.isArray(c) ? c : []; }
  catch { return []; }
})();
let USUARIO = lsGet(USER_KEY) || '';

function save() { scheduleSync(); }
function saveCart() { lsSet(CART_KEY, JSON.stringify(CART)); }
function commit() { save(); renderAll(); }

/* ---------------- Utilidades ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(4, '0');
const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const r2 = n => Math.round(n * 100) / 100;
const r3 = n => Math.round(n * 1000) / 1000;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const fmtMoneyNum = n => num(n).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = n => `${esc(S.config.moneda)} ${fmtMoneyNum(n)}`;          // para HTML
const moneyTxt = n => `${S.config.moneda} ${fmtMoneyNum(n)}`;             // para texto plano
const fmtNum = n => num(n).toLocaleString('es-PE', { maximumFractionDigits: 3 });
function today() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
function parseDate(s) { if (!s) return null; const d = s.length === 10 ? new Date(s + 'T00:00:00') : new Date(s); return isNaN(d) ? null : d; }
function fmtDate(s) { const d = parseDate(s); return d ? d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'; }
function fmtDT(s) { const d = parseDate(s); return d ? d.toLocaleString('es-PE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; }
function fmtTime(s) { const d = parseDate(s); return d ? d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) : ''; }
function daysFromToday(s) { const d = parseDate(s); return d ? Math.round((d - parseDate(today())) / 864e5) : null; }
const isToday = iso => { const d = new Date(iso); return d.toDateString() === new Date().toDateString(); };
// El siguiente código se calcula con el mayor código existente, así dos equipos no repiten números.
const COLL_OF = { prod: 'productos', prov: 'proveedores', dev: 'devoluciones', ped: 'pedidos', venta: 'ventas' };
const codeNum = c => parseInt(String(c || '').split('-').pop(), 10) || 0;
const nextNum = k => Math.max(num(S.counters[k]), ...(S[COLL_OF[k]] || []).map(x => codeNum(x.codigo)), 0) + 1;
const peekCode = (k, p) => `${p}-${pad(nextNum(k))}`;
const nextCode = (k, p) => { S.counters[k] = nextNum(k); return `${p}-${pad(S.counters[k])}`; };
const validColor = c => (/^#[0-9a-f]{6}$/i.test(c || '') ? c : null);
const cmp = (x, y) => (typeof x === 'string' ? x.localeCompare(y, 'es', { numeric: true }) : x - y);
const plural = (n, a, b) => `${fmtNum(n)} ${n === 1 ? a : b}`;

/* ---------------- Íconos ---------------- */
const sv = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  search: sv('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  plus: sv('<path d="M12 5v14M5 12h14"/>'),
  filter: sv('<path d="M4 6h16M7 12h10M10 18h4"/>'),
  x: sv('<path d="M6 6l12 12M18 6 6 18"/>'),
  edit: sv('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m14 6 4 4"/>'),
  trash: sv('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  check: sv('<path d="m5 12 5 5 9-10"/>'),
  clock: sv('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  cart: sv('<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.2h11.6L21.5 7H6.2"/>'),
  truck: sv('<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>'),
  copy: sv('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
  phone: sv('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>'),
  undo: sv('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
};

/* ---------------- Dominio ---------------- */
const prodById = id => S.productos.find(p => p.id === id);
const provById = id => S.proveedores.find(p => p.id === id);
const hasOwnMin = p => p.stockMin !== null && p.stockMin !== undefined && p.stockMin !== '';
const minDe = p => (hasOwnMin(p) ? num(p.stockMin) : num(S.config.stockMinGlobal));
const esBajo = p => num(p.cantidad) <= minDe(p);
const margen = p => (num(p.precioVenta) > 0 ? ((num(p.precioVenta) - num(p.precioCompra)) / num(p.precioVenta)) * 100 : null);
const sugerido = p => Math.max(1, Math.ceil(minDe(p) * 2 - num(p.cantidad)));
const provName = (id, fallback) => provById(id)?.empresa || fallback || '';

function nameHTML(p, fallback) {
  if (!p) return `<span class="muted">${esc(fallback || '(producto eliminado)')}</span>`;
  const f = p.fmt || {};
  const st = [];
  if (f.b) st.push('font-weight:800');
  if (f.i) st.push('font-style:italic');
  if (f.u) st.push('text-transform:uppercase');
  const c = validColor(f.color);
  if (c) st.push('color:' + c);
  return `<span class="pname"${st.length ? ` style="${st.join(';')}"` : ''}>${esc(p.nombre)}</span>`;
}
function qtyHTML(p) {
  const cls = num(p.cantidad) <= 0 ? 'out' : esBajo(p) ? 'low' : '';
  return `<span class="qty ${cls}" title="Mínimo: ${fmtNum(minDe(p))}">${fmtNum(p.cantidad)}</span>${p.unidad ? ` <small class="muted">${esc(p.unidad)}</small>` : ''}`;
}
function margenHTML(p) {
  const m = margen(p);
  if (m === null) return '<span class="muted">—</span>';
  return `<span class="${m < 0 ? 'neg' : ''}">${m.toFixed(1)}%</span><span class="sub-line">${money(num(p.precioVenta) - num(p.precioCompra))}</span>`;
}

const ROT = {
  rapida: { label: 'Rápida', cls: 'b-green', rank: 5 },
  normal: { label: 'Normal', cls: 'b-blue', rank: 4 },
  lenta: { label: 'Lenta', cls: 'b-amber', rank: 3 },
  nuevo: { label: 'Nuevo', cls: 'b-violet', rank: 2 },
  sinmov: { label: 'Sin movimiento', cls: 'b-grey', rank: 1 },
};
const rotBadge = key => `<span class="badge ${ROT[key].cls}">${ROT[key].label}</span>`;
/** Calcula el nivel de rotación según las salidas y ventas de los últimos N días. */
function rotMap() {
  const dias = Math.max(1, num(S.config.rotDias) || 30);
  const desde = Date.now() - dias * 864e5;
  const sal = new Map();
  for (const m of S.movimientos) {
    if ((m.tipo === 'salida' || m.tipo === 'venta') && Date.parse(m.fecha) >= desde) {
      sal.set(m.productoId, (sal.get(m.productoId) || 0) + num(m.cantidad));
    }
  }
  const out = new Map();
  for (const p of S.productos) {
    const s = r3(sal.get(p.id) || 0);
    let key;
    if (s <= 0) key = Date.now() - Date.parse(p.creado) < 7 * 864e5 ? 'nuevo' : 'sinmov';
    else if (s >= num(S.config.rotRapida)) key = 'rapida';
    else if (s >= num(S.config.rotNormal)) key = 'normal';
    else key = 'lenta';
    out.set(p.id, { key, sal: s });
  }
  return out;
}

const MOV = {
  entrada: 'Entrada', salida: 'Salida', venta: 'Venta', devolucion: 'Devolución', ajuste: 'Ajuste',
};
/** Registra un movimiento de stock. tipo: entrada | salida | venta | devolucion | ajuste (cantidad con signo). */
function mover(p, tipo, cantidad, nota = '', ref = '') {
  if (!p) return;
  const signo = tipo === 'entrada' ? 1 : tipo === 'ajuste' ? (num(cantidad) < 0 ? -1 : 1) : -1;
  const q = Math.abs(num(cantidad));
  if (!q) return;
  p.cantidad = r3(num(p.cantidad) + signo * q);
  // el cambio de stock se manda a la nube como suma/resta, así dos personas no se pisan
  pendDelta.set(p.id, r3((pendDelta.get(p.id) || 0) + signo * q));
  S.movimientos.push({ id: uid(), productoId: p.id, tipo, cantidad: q, signo, fecha: new Date().toISOString(), nota, ref, saldo: p.cantidad, usuario: USUARIO });
}
function cambiarPrecioCompra(p, nuevo, ref) {
  if (!p.historialPrecios) p.historialPrecios = [];
  p.historialPrecios.push({ fecha: new Date().toISOString(), anterior: num(p.precioCompra), nuevo, ref });
  p.precioCompra = nuevo;
}

/* ---------------- Interfaz: avisos y ventanas ---------------- */
function toast(msg, type = 'ok') {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  box.appendChild(t);
  try { if (box.matches(':popover-open')) box.hidePopover(); box.showPopover(); } catch { /* navegador sin popover */ }
  setTimeout(() => {
    t.remove();
    if (!box.children.length) { try { box.hidePopover(); } catch { /* */ } }
  }, 2800);
}

function modal({ title, body = '', foot = '', size = '', backdropClose = false }) {
  const d = document.createElement('dialog');
  d.className = 'modal ' + size;
  d.innerHTML = `<div class="m-head"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Cerrar">${I.x}</button></div>
    <div class="m-body">${body}</div>${foot ? `<div class="m-foot">${foot}</div>` : ''}`;
  document.body.appendChild(d);
  d.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) d.close();
    else if (backdropClose && e.target === d) d.close();
  });
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}
function confirmBox(msg, { ok = 'Aceptar', danger = false, title = 'Confirmar' } = {}) {
  return new Promise(res => {
    const d = modal({
      title, size: 'sm', body: `<p class="confirm-msg">${msg}</p>`,
      foot: `<button class="btn" data-close>Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${ok}</button>`,
    });
    let v = false;
    $('[data-ok]', d).addEventListener('click', () => { v = true; d.close(); });
    d.addEventListener('close', () => res(v));
    $('[data-ok]', d).focus();
  });
}
function askText(title, label, value = '') {
  return new Promise(res => {
    const fid = 'f-ask-' + uid();
    const d = modal({
      title, size: 'sm',
      body: `<form id="${fid}"><label class="field"><span>${label}</span><input name="v" required maxlength="80" value="${esc(value)}"></label></form>`,
      foot: `<button class="btn" data-close>Cancelar</button><button class="btn primary" type="submit" form="${fid}">Guardar</button>`,
    });
    let v = null;
    $('form', d).addEventListener('submit', e => { e.preventDefault(); v = $('[name=v]', d).value.trim(); d.close(); });
    d.addEventListener('close', () => res(v || null));
    setTimeout(() => $('[name=v]', d).select(), 30);
  });
}
function fillSelect(el, opts, value) {
  el.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  el.value = value ?? '';
  if (el.value !== (value ?? '')) el.value = '';
}
function catOptionsHTML(sel) {
  const cats = [...S.config.categorias];
  if (sel && !cats.includes(sel)) cats.push(sel);
  return `<option value="">— Sin categoría —</option>` + cats.map(c => `<option ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join('');
}
function provOptionsHTML(sel, emptyLabel = '— Sin proveedor —') {
  const list = [...S.proveedores].sort((a, b) => cmp(a.empresa, b.empresa));
  return `<option value="">${emptyLabel}</option>` + list.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.empresa)}</option>`).join('');
}
function prodOptionsHTML(sel) {
  const list = [...S.productos].sort((a, b) => cmp(a.nombre, b.nombre));
  return `<option value="">— Elige un producto —</option>` + list.map(p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.nombre)} · ${esc(p.codigo)} (stock ${fmtNum(p.cantidad)})</option>`).join('');
}
function togglePop(id) {
  const pop = $(id);
  pop.hidden = !pop.hidden;
}
document.addEventListener('click', e => {
  $$('.pop').forEach(pop => { if (!pop.hidden && !e.target.closest('.pop-wrap')) pop.hidden = true; });
});

/* ---------------- Pestañas ---------------- */
const ui = {
  tab: 'inventario',
  inv: { q: '', campo: 'todo', cat: '', prov: '', stock: '', rot: '', orden: 'codigo', dir: 1 },
  dev: { q: '', estado: '', prov: '' },
  ped: { sub: 'pedidos', q: '', estado: 'activos', prov: '' },
  prv: { q: '' },
  pos: { q: '', cat: '' },
};
const TABS = ['inventario', 'devoluciones', 'proveedores', 'ventas', 'historial', 'config'];
function setTab(t) {
  if (!TABS.includes(t)) t = 'inventario';
  ui.tab = t;
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t));
  if (location.hash !== '#' + t) history.replaceState(null, '', '#' + t);
  renderCartBar();
}

/* =========================================================
   1. INVENTARIO
   ========================================================= */
function buildInventario() {
  $('#tab-inventario').innerHTML = `
    <div class="ph"><div><h2>Inventario</h2><p>Stock, precios, margen y rotación de cada producto. Haz clic en un producto para ver su detalle.</p></div></div>
    <div class="toolbar">
      <label class="search">${I.search}<input id="inv-q" type="search" placeholder="Buscar producto, código, proveedor…" autocomplete="off"></label>
      <select id="inv-campo" title="Buscar en">
        <option value="todo">Buscar en todo</option><option value="nombre">Solo nombre</option><option value="codigo">Solo código</option>
        <option value="categoria">Solo categoría</option><option value="proveedor">Solo proveedor</option>
      </select>
      <div class="pop-wrap">
        <button class="btn" id="inv-fbtn" type="button">${I.filter} Filtros <span class="count" id="inv-fcount"></span></button>
        <div class="pop" id="inv-pop" hidden>
          <label class="field"><span>Categoría</span><select id="inv-cat"></select></label>
          <label class="field"><span>Proveedor</span><select id="inv-prov"></select></label>
          <label class="field"><span>Stock</span><select id="inv-stock">
            <option value="">Todos</option><option value="bajo">En o bajo el mínimo (rojo)</option><option value="agotado">Agotados</option><option value="ok">Stock suficiente</option></select></label>
          <label class="field"><span>Rotación</span><select id="inv-rot">
            <option value="">Todas</option>${Object.entries(ROT).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></label>
          <label class="field"><span>Ordenar por</span><select id="inv-orden">
            <option value="codigo">Código</option><option value="nombre">Nombre</option><option value="categoria">Categoría</option>
            <option value="cantidad">Cantidad</option><option value="precioCompra">Precio de compra</option><option value="precioVenta">Precio de venta</option>
            <option value="margen">Margen</option><option value="proveedor">Proveedor</option><option value="rotacion">Rotación</option></select></label>
          <button class="btn sm" id="inv-clear" type="button">Limpiar filtros</button>
        </div>
      </div>
      <div class="spacer"></div>
      <button class="btn primary" id="inv-add" type="button">${I.plus} Agregar producto</button>
    </div>
    <div class="stats" id="inv-stats"></div>
    <div class="meta" id="inv-meta"></div>
    <div class="table-wrap" id="inv-wrap"></div>`;

  $('#inv-q').addEventListener('input', e => { ui.inv.q = e.target.value; renderInventario(); });
  ['campo', 'cat', 'prov', 'stock', 'rot', 'orden'].forEach(k =>
    $('#inv-' + k).addEventListener('change', e => { ui.inv[k] = e.target.value; if (k === 'orden') ui.inv.dir = 1; renderInventario(); }));
  $('#inv-fbtn').addEventListener('click', () => togglePop('#inv-pop'));
  $('#inv-clear').addEventListener('click', () => { Object.assign(ui.inv, { cat: '', prov: '', stock: '', rot: '' }); renderInventario(); });
  $('#inv-add').addEventListener('click', () => formProducto());
  $('#inv-stats').addEventListener('click', e => {
    const c = e.target.closest('[data-stock],[data-goto]');
    if (!c) return;
    if (c.dataset.goto) { ui.ped.sub = 'pedidos'; ui.ped.estado = 'activos'; renderProveedores(); setTab('proveedores'); return; }
    ui.inv.stock = ui.inv.stock === c.dataset.stock ? '' : c.dataset.stock;
    renderInventario();
  });
  const wrap = $('#inv-wrap');
  wrap.addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const k = th.dataset.sort;
      if (ui.inv.orden === k) ui.inv.dir *= -1; else { ui.inv.orden = k; ui.inv.dir = 1; }
      renderInventario();
      return;
    }
    const b = e.target.closest('[data-act]');
    if (b) { if (b.dataset.act === 'add') formProducto(); if (b.dataset.act === 'seed') cargarEjemplo(); return; }
    const tr = e.target.closest('tr[data-id]');
    if (tr) verProducto(tr.dataset.id);
  });
  wrap.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const tr = e.target.closest('tr[data-id]'); if (tr) verProducto(tr.dataset.id); }
  });
}

function renderInventario() {
  const f = ui.inv;
  const rot = rotMap();
  // controles
  $('#inv-campo').value = f.campo;
  fillSelect($('#inv-cat'), [['', 'Todas'], ...S.config.categorias.map(c => [c, c])], f.cat);
  fillSelect($('#inv-prov'), [['', 'Todos'], ...[...S.proveedores].sort((a, b) => cmp(a.empresa, b.empresa)).map(p => [p.id, p.empresa])], f.prov);
  f.cat = $('#inv-cat').value; f.prov = $('#inv-prov').value;
  $('#inv-stock').value = f.stock; $('#inv-rot').value = f.rot; $('#inv-orden').value = f.orden;
  const nf = ['cat', 'prov', 'stock', 'rot'].filter(k => f[k]).length;
  $('#inv-fcount').textContent = nf || '';

  // resumen
  const all = S.productos;
  const bajos = all.filter(esBajo).length;
  const agot = all.filter(p => num(p.cantidad) <= 0).length;
  const vCosto = all.reduce((s, p) => s + Math.max(0, num(p.cantidad)) * num(p.precioCompra), 0);
  const vVenta = all.reduce((s, p) => s + Math.max(0, num(p.cantidad)) * num(p.precioVenta), 0);
  const pedAct = S.pedidos.filter(x => x.estado === 'pendiente' || x.estado === 'camino');
  const pedHoy = pedAct.filter(x => x.fechaLlegada && daysFromToday(x.fechaLlegada) <= 0).length;
  $('#inv-stats').innerHTML = `
    <div class="stat"><span>Productos</span><b>${fmtNum(all.length)}</b><small>${S.config.categorias.length} categorías</small></div>
    <button class="stat danger ${f.stock === 'bajo' ? 'on' : ''}" data-stock="bajo" type="button"><span>En o bajo el mínimo</span><b>${bajos}</b><small>Clic para filtrar</small></button>
    <button class="stat danger ${f.stock === 'agotado' ? 'on' : ''}" data-stock="agotado" type="button"><span>Agotados</span><b>${agot}</b><small>Clic para filtrar</small></button>
    <div class="stat"><span>Valor del stock (costo)</span><b>${money(vCosto)}</b><small>A precio de venta: ${money(vVenta)}</small></div>
    <button class="stat ${pedHoy ? 'warn' : ''}" data-goto="pedidos" type="button"><span>Pedidos en curso</span><b>${pedAct.length}</b><small>${pedHoy ? pedHoy + ' llegan hoy o están atrasados' : 'Ver pedidos'}</small></button>`;

  // filtrar
  const q = norm(f.q.trim());
  let list = all.filter(p => {
    if (q) {
      const campos = { nombre: p.nombre, codigo: p.codigo, categoria: p.categoria, proveedor: provName(p.proveedorId) };
      const hay = f.campo === 'todo' ? Object.values(campos).join(' ') + ' ' + (p.ubicacion || '') : campos[f.campo];
      if (!norm(hay).includes(q)) return false;
    }
    if (f.cat && p.categoria !== f.cat) return false;
    if (f.prov && p.proveedorId !== f.prov) return false;
    if (f.stock === 'bajo' && !esBajo(p)) return false;
    if (f.stock === 'agotado' && num(p.cantidad) > 0) return false;
    if (f.stock === 'ok' && esBajo(p)) return false;
    if (f.rot && rot.get(p.id).key !== f.rot) return false;
    return true;
  });
  // ordenar
  const val = p => {
    switch (f.orden) {
      case 'codigo': return p.codigo;
      case 'nombre': return norm(p.nombre);
      case 'categoria': return norm(p.categoria || '~');
      case 'cantidad': return num(p.cantidad);
      case 'precioCompra': return num(p.precioCompra);
      case 'precioVenta': return num(p.precioVenta);
      case 'margen': return margen(p) ?? -1e9;
      case 'proveedor': return norm(provName(p.proveedorId) || '~');
      case 'rotacion': return -ROT[rot.get(p.id).key].rank;
      default: return p.codigo;
    }
  };
  list.sort((a, b) => cmp(val(a), val(b)) * f.dir);

  $('#inv-meta').textContent = all.length ? `Mostrando ${list.length} de ${all.length} productos` : '';
  const wrap = $('#inv-wrap');
  if (!all.length) {
    wrap.innerHTML = `<div class="empty"><h3>Aún no hay productos</h3><p>Agrega tu primer producto o carga datos de ejemplo para probar la página.</p>
      <div class="btn-row"><button class="btn primary" data-act="add">${I.plus} Agregar producto</button><button class="btn" data-act="seed">Cargar datos de ejemplo</button></div></div>`;
    return;
  }
  if (!list.length) { wrap.innerHTML = `<div class="empty"><h3>Sin resultados</h3><p>Prueba con otra búsqueda o limpia los filtros.</p></div>`; return; }
  const cols = [['codigo', 'Código'], ['categoria', 'Categoría'], ['nombre', 'Nombre'], ['cantidad', 'Cantidad', 1], ['precioCompra', 'P. compra', 1],
    ['precioVenta', 'P. venta', 1], ['margen', 'Margen', 1], ['proveedor', 'Proveedor'], ['rotacion', 'Rotación']];
  wrap.innerHTML = `<table class="tbl click"><thead><tr>${cols.map(([k, l, n]) =>
    `<th data-sort="${k}" class="${n ? 'num' : ''}">${l}${f.orden === k ? `<span class="arr">${f.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr></thead>
    <tbody>${list.map(p => {
      const r = rot.get(p.id);
      return `<tr data-id="${p.id}" tabindex="0">
        <td class="mono muted">${esc(p.codigo)}</td>
        <td>${p.categoria ? `<span class="chip">${esc(p.categoria)}</span>` : '<span class="muted">—</span>'}</td>
        <td class="name-cell">${nameHTML(p)}</td>
        <td class="num">${qtyHTML(p)}</td>
        <td class="num">${money(p.precioCompra)}</td>
        <td class="num">${money(p.precioVenta)}</td>
        <td class="num">${margenHTML(p)}</td>
        <td>${p.proveedorId ? esc(provName(p.proveedorId, '—')) : '<span class="muted">—</span>'}</td>
        <td title="${fmtNum(r.sal)} salidas en ${S.config.rotDias} días">${rotBadge(r.key)}</td></tr>`;
    }).join('')}</tbody></table>`;
}

/* ---------- Formulario de producto ---------- */
function formProducto(id) {
  const p = id ? prodById(id) : null;
  const isNew = !p;
  const fmt = Object.assign({ b: false, i: false, u: false, color: null }, p?.fmt);
  const body = `<form id="f-prod" autocomplete="off">
    <p class="hint">${isNew ? `Código asignado automáticamente: <b class="mono">${peekCode('prod', 'P')}</b>` : `Código: <b class="mono">${esc(p.codigo)}</b>`}</p>
    <div class="grid2">
      <div class="field span2"><span>Nombre del producto *</span>
        <div class="name-row">
          <input name="nombre" required maxlength="120" value="${esc(p?.nombre || '')}" placeholder="Ej. Arroz extra 5 kg">
          <div class="fmt">
            <button type="button" class="fmt-btn ${fmt.b ? 'on' : ''}" data-f="b" title="Negrita" aria-pressed="${fmt.b}"><b>B</b></button>
            <button type="button" class="fmt-btn ${fmt.i ? 'on' : ''}" data-f="i" title="Cursiva" aria-pressed="${fmt.i}"><i>I</i></button>
            <button type="button" class="fmt-btn ${fmt.u ? 'on' : ''}" data-f="u" title="Mayúsculas" aria-pressed="${fmt.u}">AA</button>
            <label class="fmt-color ${fmt.color ? 'on' : ''}" title="Color del nombre"><input type="color" name="color" value="${validColor(fmt.color) || '#c42b2b'}">Color</label>
            <button type="button" class="fmt-btn" data-f="reset" title="Quitar formato">↺</button>
          </div>
        </div>
        <div class="preview">Así se verá: <span id="f-prev"></span></div>
      </div>
      <div class="field"><span>Categoría</span>
        <div class="with-add"><select name="categoria">${catOptionsHTML(p?.categoria)}</select><button type="button" class="btn" data-quick="cat" title="Nueva categoría">${I.plus}</button></div></div>
      <div class="field"><span>Proveedor</span>
        <div class="with-add"><select name="proveedorId">${provOptionsHTML(p?.proveedorId)}</select><button type="button" class="btn" data-quick="prov" title="Nuevo proveedor">${I.plus}</button></div></div>
      <label class="field"><span>${isNew ? 'Cantidad inicial' : 'Cantidad actual'}</span><input name="cantidad" type="number" step="any" inputmode="decimal" value="${p ? p.cantidad : ''}" placeholder="0">
        ${isNew ? '' : '<small>Si la cambias se registra como ajuste de inventario.</small>'}</label>
      <label class="field"><span>Unidad</span><input name="unidad" list="unidades" maxlength="20" value="${esc(p?.unidad || 'und')}"></label>
      <label class="field"><span>Precio de compra (${esc(S.config.moneda)})</span><input name="precioCompra" type="number" min="0" step="0.01" inputmode="decimal" value="${p ? p.precioCompra : ''}" placeholder="0.00"></label>
      <label class="field"><span>Precio de venta (${esc(S.config.moneda)})</span><input name="precioVenta" type="number" min="0" step="0.01" inputmode="decimal" value="${p ? p.precioVenta : ''}" placeholder="0.00"></label>
      <label class="field"><span>Stock mínimo de este producto</span><input name="stockMin" type="number" min="0" step="any" inputmode="decimal" value="${p && hasOwnMin(p) ? p.stockMin : ''}" placeholder="Vacío = universal (${fmtNum(S.config.stockMinGlobal)})">
        <small>Debajo o igual a este número la cantidad se pinta en rojo.</small></label>
      <div class="live" id="f-marg"></div>
      <label class="field"><span>Ubicación en bodega</span><input name="ubicacion" maxlength="60" value="${esc(p?.ubicacion || '')}" placeholder="Ej. Estante 3, nivel 2"></label>
      <label class="field span2"><span>Notas</span><textarea name="notas" rows="2">${esc(p?.notas || '')}</textarea></label>
    </div></form>`;
  const d = modal({
    title: isNew ? 'Agregar producto' : 'Editar producto', body, size: 'wide',
    foot: `<button class="btn" data-close>Cancelar</button><button class="btn primary" type="submit" form="f-prod">${isNew ? 'Guardar producto' : 'Guardar cambios'}</button>`,
  });
  const f = $('#f-prod', d), E = f.elements;
  const preview = () => {
    const tmp = { nombre: E.nombre.value || 'Nombre del producto', fmt };
    $('#f-prev', d).innerHTML = nameHTML(tmp);
    const pc = num(E.precioCompra.value), pv = num(E.precioVenta.value);
    $('#f-marg', d).innerHTML = pv > 0
      ? `Margen: <b class="${pv < pc ? 'neg' : ''}">${(((pv - pc) / pv) * 100).toFixed(1)}%</b> · Ganancia por unidad: <b>${money(pv - pc)}</b>`
      : 'Ingresa el precio de venta para ver el margen.';
  };
  f.addEventListener('input', preview);
  $('.fmt', d).addEventListener('click', e => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    const k = b.dataset.f;
    if (k === 'reset') {
      fmt.b = fmt.i = fmt.u = false; fmt.color = null;
      $$('.fmt-btn', d).forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
      $('.fmt-color', d).classList.remove('on');
    } else {
      fmt[k] = !fmt[k];
      b.classList.toggle('on', fmt[k]);
      b.setAttribute('aria-pressed', String(fmt[k]));
    }
    preview();
  });
  E.color.addEventListener('input', () => { fmt.color = E.color.value; $('.fmt-color', d).classList.add('on'); preview(); });
  f.addEventListener('click', async e => {
    const b = e.target.closest('[data-quick]');
    if (!b) return;
    if (b.dataset.quick === 'cat') {
      const v = await askText('Nueva categoría', 'Nombre de la categoría');
      if (!v) return;
      if (!S.config.categorias.some(c => norm(c) === norm(v))) { S.config.categorias.push(v); logH('Categoría agregada', v); }
      const real = S.config.categorias.find(c => norm(c) === norm(v));
      E.categoria.innerHTML = catOptionsHTML(real);
      save(); renderAll();
    } else {
      const v = await askText('Nuevo proveedor', 'Empresa / razón social');
      if (!v) return;
      const pv = { id: uid(), codigo: nextCode('prov', 'PRV'), empresa: v, contacto: '', telefono: '', email: '', ruc: '', direccion: '', notas: '', creado: new Date().toISOString() };
      S.proveedores.push(pv);
      logH('Proveedor agregado', `${pv.codigo} ${v}`);
      E.proveedorId.innerHTML = provOptionsHTML(pv.id);
      save(); renderAll();
      toast('Proveedor creado. Completa sus datos en la pestaña Proveedores.');
    }
  });
  f.addEventListener('submit', e => {
    e.preventDefault();
    const nombre = E.nombre.value.trim();
    if (!nombre) return toast('Escribe el nombre del producto', 'error');
    const datos = {
      nombre,
      fmt: { b: fmt.b, i: fmt.i, u: fmt.u, color: validColor(fmt.color) },
      categoria: E.categoria.value,
      proveedorId: E.proveedorId.value || null,
      unidad: E.unidad.value.trim(),
      precioCompra: r2(Math.max(0, num(E.precioCompra.value))),
      precioVenta: r2(Math.max(0, num(E.precioVenta.value))),
      stockMin: E.stockMin.value === '' ? null : Math.max(0, num(E.stockMin.value)),
      ubicacion: E.ubicacion.value.trim(),
      notas: E.notas.value.trim(),
    };
    const cant = r3(num(E.cantidad.value));
    if (isNew) {
      const np = { id: uid(), codigo: nextCode('prod', 'P'), creado: new Date().toISOString(), cantidad: 0, ...datos };
      S.productos.push(np);
      if (cant) mover(np, cant > 0 ? 'entrada' : 'ajuste', cant, 'Stock inicial');
      logH('Producto agregado', `${np.codigo} ${nombre} · stock ${fmtNum(cant)} · compra ${moneyTxt(datos.precioCompra)} · venta ${moneyTxt(datos.precioVenta)}`);
      toast(`Producto ${np.codigo} agregado`);
    } else {
      const antes = { ...p };
      if (r2(num(p.precioCompra)) !== datos.precioCompra) {
        cambiarPrecioCompra(p, datos.precioCompra, 'Edición manual');
      }
      Object.assign(p, datos);
      const diff = r3(cant - num(p.cantidad));
      if (diff) mover(p, 'ajuste', diff, 'Ajuste manual (edición)');
      const cambios = diffProducto(antes, p);
      if (cambios) logH('Producto editado', `${p.codigo} ${p.nombre} · ${cambios}`);
      toast('Producto actualizado');
    }
    d.close();
    commit();
  });
  preview();
  setTimeout(() => E.nombre.focus(), 40);
}

/* ---------- Detalle de producto ---------- */
function verProducto(id) {
  const d = modal({ title: 'Detalle del producto', body: '<div id="det"></div>', size: 'wide', backdropClose: true });
  const paint = () => {
    const p = prodById(id);
    if (!p) { d.close(); return; }
    const prov = provById(p.proveedorId);
    const r = rotMap().get(p.id);
    const movs = S.movimientos.filter(m => m.productoId === id).sort((a, b) => b.fecha.localeCompare(a.fecha));
    const ultEnt = movs.find(m => m.tipo === 'entrada');
    const ultSal = movs.find(m => m.tipo === 'salida' || m.tipo === 'venta');
    const pedAct = S.pedidos.filter(x => (x.estado === 'pendiente' || x.estado === 'camino') && x.items.some(it => it.productoId === id));
    const devPend = S.devoluciones.filter(x => x.productoId === id && x.estado === 'pendiente');
    const lastPrice = (p.historialPrecios || []).slice(-1)[0];
    const m = margen(p);
    const bajo = esBajo(p);
    $('#det', d).innerHTML = `
      <div class="det-head">
        <div>
          <div class="mono muted">${esc(p.codigo)} · ${esc(p.categoria || 'Sin categoría')}</div>
          <h3 class="det-name">${nameHTML(p)}</h3>
          ${p.ubicacion ? `<div class="muted">Ubicación: ${esc(p.ubicacion)}</div>` : ''}
        </div>
        <div class="btn-row">
          <button class="btn sm" data-act="edit">${I.edit} Editar</button>
          <button class="btn sm" data-act="pedido">${I.truck} Hacer pedido</button>
          <button class="btn sm danger-ghost" data-act="del">${I.trash} Eliminar</button>
        </div>
      </div>
      ${bajo ? `<div class="alert danger">${num(p.cantidad) <= 0 ? 'Producto agotado.' : `Stock en o bajo el mínimo (${fmtNum(minDe(p))}).`}
        ${pedAct.length ? `Hay ${pedAct.length} pedido(s) en curso con este producto.` : 'Considera hacer un pedido.'}</div>` : ''}
      ${devPend.length ? `<div class="alert warn">${plural(devPend.length, 'devolución pendiente', 'devoluciones pendientes')} de este producto.</div>` : ''}
      <div class="kpis">
        <div class="kpi ${bajo ? 'danger' : ''}"><span>Stock actual</span><b>${fmtNum(p.cantidad)} ${esc(p.unidad || '')}</b><small>Mínimo ${fmtNum(minDe(p))} ${hasOwnMin(p) ? '(propio)' : '(universal)'}</small></div>
        <div class="kpi"><span>Precio de compra</span><b>${money(p.precioCompra)}</b><small>${lastPrice ? `Antes ${money(lastPrice.anterior)} · ${fmtDate(lastPrice.fecha)}` : 'Sin cambios de precio'}</small></div>
        <div class="kpi"><span>Precio de venta</span><b>${money(p.precioVenta)}</b><small>${prov ? esc(prov.empresa) : 'Sin proveedor'}</small></div>
        <div class="kpi"><span>Margen</span><b class="${m !== null && m < 0 ? 'neg' : ''}">${m === null ? '—' : m.toFixed(1) + '%'}</b><small>Ganancia ${money(num(p.precioVenta) - num(p.precioCompra))} c/u</small></div>
        <div class="kpi"><span>Valor en stock</span><b>${money(Math.max(0, num(p.cantidad)) * num(p.precioCompra))}</b><small>A precio venta ${money(Math.max(0, num(p.cantidad)) * num(p.precioVenta))}</small></div>
        <div class="kpi"><span>Rotación</span><b>${rotBadge(r.key)}</b><small>${fmtNum(r.sal)} salidas en ${S.config.rotDias} días</small></div>
      </div>
      <div class="det-grid">
        <div class="card-sm"><h4>Última entrada</h4>${ultEnt
          ? `<b>${fmtDT(ultEnt.fecha)}</b><div>+${fmtNum(ultEnt.cantidad)} ${esc(p.unidad || '')}${ultEnt.nota ? ' · ' + esc(ultEnt.nota) : ''}</div>`
          : '<span class="muted">Sin entradas registradas</span>'}</div>
        <div class="card-sm"><h4>Última salida / venta</h4>${ultSal
          ? `<b>${fmtDT(ultSal.fecha)}</b><div>−${fmtNum(ultSal.cantidad)} ${esc(p.unidad || '')} · ${MOV[ultSal.tipo]}${ultSal.nota && ultSal.nota !== 'Venta' ? ' · ' + esc(ultSal.nota) : ''}</div>`
          : '<span class="muted">Sin salidas registradas</span>'}</div>
        <div class="card-sm"><h4>Proveedor</h4>${prov
          ? `<b>${esc(prov.empresa)}</b><div>${esc(prov.contacto || '')}${prov.telefono ? ` · <a href="tel:${esc(prov.telefono)}">${esc(prov.telefono)}</a>` : ''}</div>`
          : '<span class="muted">Sin proveedor asignado</span>'}</div>
      </div>
      <form class="mov-form" data-form="mov" autocomplete="off">
        <h4 class="sub-h">Registrar movimiento de stock</h4>
        <div class="mov-row">
          <select name="tipo"><option value="entrada">Entrada (+)</option><option value="salida">Salida (−)</option><option value="exacto">Ajustar a conteo exacto</option></select>
          <input name="cant" type="number" step="any" min="0" required placeholder="Cantidad" inputmode="decimal">
          <input name="nota" maxlength="120" placeholder="Nota (opcional): factura, motivo…">
          <button class="btn primary">Registrar</button>
        </div>
      </form>
      ${pedAct.length ? `<h4 class="sub-h">Pedidos en curso</h4><div class="table-wrap flat"><table class="tbl compact"><tbody>${pedAct.map(x => {
        const it = x.items.find(i => i.productoId === id);
        return `<tr><td class="mono">${esc(x.codigo)}</td><td>${esc(provName(x.proveedorId, x.proveedorNombre))}</td><td class="num">${fmtNum(it.cantidad)} × ${money(it.precio)}</td><td>${llegadaHTML(x)}</td></tr>`;
      }).join('')}</tbody></table></div>` : ''}
      <h4 class="sub-h">Historial de movimientos</h4>
      ${movs.length ? `<div class="table-wrap flat"><table class="tbl compact"><thead><tr><th>Fecha</th><th>Tipo</th><th class="num">Cantidad</th><th class="num">Saldo</th><th>Nota / referencia</th><th>Quién</th></tr></thead><tbody>
        ${movs.slice(0, 40).map(mv => {
          const s = mv.signo ?? (mv.tipo === 'entrada' ? 1 : -1);
          return `<tr><td>${fmtDT(mv.fecha)}</td><td>${MOV[mv.tipo] || mv.tipo}</td>
            <td class="num ${s > 0 ? 'pos-t' : 'neg'}">${s > 0 ? '+' : '−'}${fmtNum(mv.cantidad)}</td>
            <td class="num">${mv.saldo !== undefined ? fmtNum(mv.saldo) : ''}</td>
            <td>${esc(mv.nota || '')}${mv.ref ? ` <span class="mono muted">${esc(mv.ref)}</span>` : ''}</td><td class="muted">${esc(mv.usuario || '')}</td></tr>`;
        }).join('')}</tbody></table></div>${movs.length > 40 ? `<p class="hint">Mostrando los últimos 40 de ${movs.length}.</p>` : ''}`
        : '<p class="muted">Sin movimientos todavía.</p>'}
      ${p.notas ? `<h4 class="sub-h">Notas</h4><div class="notes">${esc(p.notas)}</div>` : ''}
      <p class="hint" style="margin-top:14px">Registrado el ${fmtDate(p.creado)}.</p>`;
  };
  paint();
  d.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'edit') { formProducto(id); return; }
    if (act === 'pedido') {
      const p = prodById(id);
      d.close();
      setTab('proveedores');
      formPedido(null, p?.proveedorId || '', p ? [{ productoId: p.id, cantidad: sugerido(p), precio: num(p.precioCompra) }] : null);
      return;
    }
    if (act === 'del') { if (await eliminarProducto(id)) d.close(); }
  });
  d.addEventListener('submit', e => {
    if (e.target.dataset.form !== 'mov') return;
    e.preventDefault();
    const p = prodById(id);
    const E = e.target.elements;
    const tipo = E.tipo.value, cant = num(E.cant.value), nota = E.nota.value.trim();
    if (tipo === 'exacto') {
      const diff = r3(cant - num(p.cantidad));
      if (!diff) return toast('La cantidad ya es esa');
      mover(p, 'ajuste', diff, nota || 'Ajuste por conteo');
    } else {
      if (cant <= 0) return toast('Ingresa una cantidad mayor a 0', 'error');
      mover(p, tipo, cant, nota);
    }
    const ult = S.movimientos[S.movimientos.length - 1];
    logH(MOV[ult.tipo], `${p.codigo} ${p.nombre}: ${ult.signo > 0 ? '+' : '−'}${fmtNum(ult.cantidad)} → stock ${fmtNum(p.cantidad)}${nota ? ' · ' + nota : ''}`);
    commit();
    paint();
    toast('Movimiento registrado');
  });
  // refresca si se edita el producto desde otra ventana
  d._paint = paint;
  openDetails.add(d);
  d.addEventListener('close', () => openDetails.delete(d));
}
const openDetails = new Set();

async function eliminarProducto(id) {
  const p = prodById(id);
  if (!p) return false;
  const ok = await confirmBox(`Se eliminará <b>${esc(p.nombre)}</b> (${esc(p.codigo)}) y su historial de movimientos. Los pedidos y devoluciones antiguos se conservan.`, { ok: 'Eliminar', danger: true, title: 'Eliminar producto' });
  if (!ok) return false;
  S.productos = S.productos.filter(x => x.id !== id);
  S.movimientos = S.movimientos.filter(m => m.productoId !== id);
  pendDelta.delete(id);
  CART = CART.filter(c => c.productoId !== id); saveCart();
  logH('Producto eliminado', `${p.codigo} ${p.nombre} (tenía ${fmtNum(p.cantidad)} ${p.unidad || ''})`);
  commit();
  toast('Producto eliminado');
  return true;
}

/* =========================================================
   2. DEVOLUCIONES
   ========================================================= */
const MOTIVOS = ['Vencido', 'Dañado / roto', 'Defectuoso', 'Error en el pedido', 'Producto equivocado', 'Otro'];

function buildDevoluciones() {
  $('#tab-devoluciones').innerHTML = `
    <div class="ph"><div><h2>Devoluciones</h2><p>Productos que se devuelven al proveedor. Marca cada una cuando ya se haya realizado.</p></div></div>
    <div class="toolbar">
      <label class="search">${I.search}<input id="dev-q" type="search" placeholder="Buscar producto, proveedor, persona, motivo…" autocomplete="off"></label>
      <select id="dev-estado" title="Estado"><option value="">Todas</option><option value="pendiente">Pendientes</option><option value="realizada">Realizadas</option></select>
      <select id="dev-prov" title="Proveedor"></select>
      <div class="spacer"></div>
      <button class="btn primary" id="dev-add" type="button">${I.plus} Agregar devolución</button>
    </div>
    <div class="stats" id="dev-stats"></div>
    <div class="table-wrap" id="dev-wrap"></div>`;
  $('#dev-q').addEventListener('input', e => { ui.dev.q = e.target.value; renderDevoluciones(); });
  $('#dev-estado').addEventListener('change', e => { ui.dev.estado = e.target.value; renderDevoluciones(); });
  $('#dev-prov').addEventListener('change', e => { ui.dev.prov = e.target.value; renderDevoluciones(); });
  $('#dev-add').addEventListener('click', () => {
    if (!S.productos.length) return toast('Primero registra productos en Inventario', 'error');
    formDevolucion();
  });
  $('#dev-stats').addEventListener('click', e => {
    const c = e.target.closest('[data-estado]');
    if (c) { ui.dev.estado = ui.dev.estado === c.dataset.estado ? '' : c.dataset.estado; renderDevoluciones(); }
  });
  $('#dev-wrap').addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    const tr = e.target.closest('tr[data-id]');
    if (!tr) { if (b?.dataset.act === 'add') $('#dev-add').click(); return; }
    const dv = S.devoluciones.find(x => x.id === tr.dataset.id);
    if (!dv) return;
    if (b?.dataset.act === 'toggle') {
      dv.estado = dv.estado === 'realizada' ? 'pendiente' : 'realizada';
      dv.fechaRealizada = dv.estado === 'realizada' ? today() : null;
      logH(dv.estado === 'realizada' ? 'Devolución realizada' : 'Devolución a pendiente', `${dv.codigo} ${prodById(dv.productoId)?.nombre || dv.productoNombre} × ${fmtNum(dv.cantidad)}`);
      commit();
      toast(dv.estado === 'realizada' ? `${dv.codigo} marcada como realizada` : `${dv.codigo} volvió a pendiente`);
      return;
    }
    if (b?.dataset.act === 'del') { eliminarDevolucion(dv.id); return; }
    formDevolucion(dv.id);
  });
}

function renderDevoluciones() {
  const f = ui.dev;
  $('#dev-estado').value = f.estado;
  fillSelect($('#dev-prov'), [['', 'Todos los proveedores'], ...[...S.proveedores].sort((a, b) => cmp(a.empresa, b.empresa)).map(p => [p.id, p.empresa])], f.prov);
  f.prov = $('#dev-prov').value;
  const all = S.devoluciones;
  const pend = all.filter(x => x.estado !== 'realizada');
  const valor = pend.reduce((s, x) => s + num(x.cantidad) * num(prodById(x.productoId)?.precioCompra), 0);
  $('#dev-stats').innerHTML = `
    <button class="stat warn ${f.estado === 'pendiente' ? 'on' : ''}" data-estado="pendiente" type="button"><span>Pendientes</span><b>${pend.length}</b><small>Clic para filtrar</small></button>
    <button class="stat ${f.estado === 'realizada' ? 'on' : ''}" data-estado="realizada" type="button"><span>Realizadas</span><b>${all.length - pend.length}</b><small>Clic para filtrar</small></button>
    <div class="stat"><span>Unidades por devolver</span><b>${fmtNum(pend.reduce((s, x) => s + num(x.cantidad), 0))}</b><small>De devoluciones pendientes</small></div>
    <div class="stat"><span>Valor pendiente (costo)</span><b>${money(valor)}</b><small>Según precio de compra</small></div>`;

  const q = norm(f.q.trim());
  const list = all.filter(x => {
    if (f.estado === 'pendiente' && x.estado === 'realizada') return false;
    if (f.estado === 'realizada' && x.estado !== 'realizada') return false;
    if (f.prov && x.proveedorId !== f.prov) return false;
    if (q) {
      const p = prodById(x.productoId);
      const hay = [x.codigo, p?.nombre || x.productoNombre, p?.codigo, provName(x.proveedorId), x.empresa, x.contacto, x.motivo, x.detalle].join(' ');
      if (!norm(hay).includes(q)) return false;
    }
    return true;
  }).sort((a, b) => (a.estado === 'realizada') - (b.estado === 'realizada') || cmp(b.fecha || '', a.fecha || '') || cmp(b.codigo, a.codigo));

  const wrap = $('#dev-wrap');
  if (!all.length) {
    wrap.innerHTML = `<div class="empty"><h3>Sin devoluciones registradas</h3><p>Registra aquí los productos vencidos, dañados o equivocados que vas a devolver.</p>
      <div class="btn-row"><button class="btn primary" data-act="add">${I.plus} Agregar devolución</button></div></div>`;
    return;
  }
  if (!list.length) { wrap.innerHTML = `<div class="empty"><h3>Sin resultados</h3><p>Prueba con otra búsqueda o filtro.</p></div>`; return; }
  wrap.innerHTML = `<table class="tbl click"><thead><tr>
      <th>Código</th><th>Fecha</th><th>Producto</th><th class="num">Cant.</th><th>Motivo</th><th>Proveedor</th><th>Empresa</th><th>Quién recoge</th><th class="num">Valor</th><th>Estado</th><th></th></tr></thead>
    <tbody>${list.map(x => {
      const p = prodById(x.productoId);
      const done = x.estado === 'realizada';
      return `<tr data-id="${x.id}">
        <td class="mono muted">${esc(x.codigo)}</td>
        <td>${fmtDate(x.fecha)}</td>
        <td class="name-cell">${nameHTML(p, x.productoNombre)}<span class="sub-line">${esc(p?.codigo || '')}${x.descontado ? ' · descontado del stock' : ''}</span></td>
        <td class="num">${fmtNum(x.cantidad)}</td>
        <td>${esc(x.motivo || '')}${x.detalle ? `<span class="sub-line">${esc(x.detalle)}</span>` : ''}</td>
        <td>${esc(provName(x.proveedorId, x.proveedorNombre) || '—')}</td>
        <td>${esc(x.empresa || '—')}</td>
        <td>${esc(x.contacto || '—')}</td>
        <td class="num">${money(num(x.cantidad) * num(p?.precioCompra))}</td>
        <td><button type="button" class="state-btn ${done ? 'done' : 'pend'}" data-act="toggle" title="Clic para cambiar">${done ? I.check + ' Realizada' : I.clock + ' Pendiente'}</button>
          ${done && x.fechaRealizada ? `<span class="sub-line">${fmtDate(x.fechaRealizada)}</span>` : ''}</td>
        <td><div class="acts"><button type="button" class="icon-btn" data-act="edit" title="Editar">${I.edit}</button><button type="button" class="icon-btn danger" data-act="del" title="Eliminar">${I.trash}</button></div></td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

function formDevolucion(id) {
  const dv = id ? S.devoluciones.find(x => x.id === id) : null;
  const isNew = !dv;
  const body = `<form id="f-dev" autocomplete="off">
    <p class="hint">${isNew ? `Código asignado: <b class="mono">${peekCode('dev', 'DEV')}</b>` : `Código: <b class="mono">${esc(dv.codigo)}</b>`}</p>
    <div class="grid2">
      <label class="field span2"><span>Producto *</span><select name="productoId" required>${prodOptionsHTML(dv?.productoId)}</select></label>
      <label class="field"><span>Cantidad a devolver *</span><input name="cantidad" type="number" min="0" step="any" required inputmode="decimal" value="${dv ? dv.cantidad : ''}"></label>
      <label class="field"><span>Fecha</span><input name="fecha" type="date" value="${dv?.fecha || today()}"></label>
      <label class="field"><span>Motivo</span><select name="motivo">${MOTIVOS.map(m => `<option ${dv?.motivo === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label class="field"><span>Detalle del motivo</span><input name="detalle" maxlength="120" value="${esc(dv?.detalle || '')}" placeholder="Ej. lote vencido el 10/10"></label>
      <label class="field"><span>Proveedor</span><select name="proveedorId">${provOptionsHTML(dv?.proveedorId)}</select></label>
      <label class="field"><span>Empresa</span><input name="empresa" maxlength="80" value="${esc(dv?.empresa || '')}" placeholder="Empresa que recoge la devolución"></label>
      <label class="field"><span>Nombre de quien recoge</span><input name="contacto" maxlength="80" value="${esc(dv?.contacto || '')}" placeholder="Ej. Kevin (repartidor)"></label>
      <label class="field"><span>Estado</span><select name="estado"><option value="pendiente">Pendiente</option><option value="realizada">Realizada</option></select></label>
      <label class="check span2"><input type="checkbox" name="descontar" ${isNew || dv.descontado ? 'checked' : ''}> Descontar esta cantidad del stock del inventario</label>
      <label class="field span2"><span>Notas</span><textarea name="notas" rows="2">${esc(dv?.notas || '')}</textarea></label>
    </div></form>`;
  const d = modal({
    title: isNew ? 'Agregar devolución' : 'Editar devolución', body, size: 'wide',
    foot: `<button class="btn" data-close>Cancelar</button><button class="btn primary" type="submit" form="f-dev">${isNew ? 'Registrar devolución' : 'Guardar cambios'}</button>`,
  });
  const f = $('#f-dev', d), E = f.elements;
  E.estado.value = dv?.estado === 'realizada' ? 'realizada' : 'pendiente';
  const autofill = (input, value) => {
    if (!input.value || input.value === input.dataset.auto) { input.value = value || ''; input.dataset.auto = value || ''; }
  };
  const fromProv = () => {
    const pv = provById(E.proveedorId.value);
    if (pv) { autofill(E.empresa, pv.empresa); autofill(E.contacto, pv.contacto); }
  };
  E.productoId.addEventListener('change', () => {
    const p = prodById(E.productoId.value);
    if (p?.proveedorId) { E.proveedorId.value = p.proveedorId; fromProv(); }
  });
  E.proveedorId.addEventListener('change', fromProv);
  f.addEventListener('submit', e => {
    e.preventDefault();
    const p = prodById(E.productoId.value);
    const cant = r3(num(E.cantidad.value));
    if (!p) return toast('Elige un producto', 'error');
    if (cant <= 0) return toast('La cantidad debe ser mayor a 0', 'error');
    const descontar = E.descontar.checked;
    const rec = dv || { id: uid(), codigo: nextCode('dev', 'DEV'), creado: new Date().toISOString(), descontado: false, estado: 'pendiente' };
    if (dv && dv.descontado && (dv.productoId !== p.id || num(dv.cantidad) !== cant || !descontar)) {
      mover(prodById(dv.productoId), 'ajuste', num(dv.cantidad), 'Corrección de devolución', dv.codigo);
      rec.descontado = false;
    }
    if (descontar && !rec.descontado) { mover(p, 'devolucion', cant, 'Devolución al proveedor', rec.codigo); rec.descontado = true; }
    const pv = provById(E.proveedorId.value);
    Object.assign(rec, {
      productoId: p.id, productoNombre: p.nombre, cantidad: cant, fecha: E.fecha.value || today(),
      motivo: E.motivo.value, detalle: E.detalle.value.trim(),
      proveedorId: pv ? pv.id : null, proveedorNombre: pv ? pv.empresa : '',
      empresa: E.empresa.value.trim(), contacto: E.contacto.value.trim(), notas: E.notas.value.trim(),
    });
    const est = E.estado.value;
    if (est === 'realizada' && rec.estado !== 'realizada') rec.fechaRealizada = today();
    if (est === 'pendiente') rec.fechaRealizada = null;
    rec.estado = est;
    if (isNew) S.devoluciones.push(rec);
    logH(isNew ? 'Devolución registrada' : 'Devolución editada', `${rec.codigo} ${p.nombre} × ${fmtNum(cant)} · ${rec.motivo} · ${rec.estado}${rec.descontado ? ' · descontado del stock' : ''}`);
    d.close();
    commit();
    toast(isNew ? `Devolución ${rec.codigo} registrada` : 'Devolución actualizada');
  });
}

async function eliminarDevolucion(id) {
  const dv = S.devoluciones.find(x => x.id === id);
  if (!dv) return;
  const msg = `Se eliminará la devolución <b>${esc(dv.codigo)}</b>.` + (dv.descontado ? ` Las ${fmtNum(dv.cantidad)} unidades descontadas volverán al stock.` : '');
  if (!(await confirmBox(msg, { ok: 'Eliminar', danger: true, title: 'Eliminar devolución' }))) return;
  if (dv.descontado) mover(prodById(dv.productoId), 'ajuste', num(dv.cantidad), 'Devolución eliminada', dv.codigo);
  S.devoluciones = S.devoluciones.filter(x => x.id !== id);
  logH('Devolución eliminada', `${dv.codigo} ${prodById(dv.productoId)?.nombre || dv.productoNombre} × ${fmtNum(dv.cantidad)}`);
  commit();
  toast('Devolución eliminada');
}

/* =========================================================
   3. PROVEEDORES Y PEDIDOS
   ========================================================= */
const EST_PED = {
  pendiente: { label: 'Pendiente', cls: 'b-amber' },
  camino: { label: 'En camino', cls: 'b-blue' },
  recibido: { label: 'Recibido', cls: 'b-green' },
  cancelado: { label: 'Cancelado', cls: 'b-grey' },
};
const pedTotal = x => r2(x.items.reduce((s, it) => s + num(it.cantidad) * num(it.precio), 0));
const pedUnits = x => x.items.reduce((s, it) => s + num(it.cantidad), 0);
function llegadaHTML(x) {
  if (x.estado === 'recibido') return `<span class="muted">Recibido ${fmtDate(x.recibidoEn)}</span>`;
  if (x.estado === 'cancelado') return '<span class="muted">—</span>';
  if (!x.fechaLlegada) return '<span class="muted">Sin fecha</span>';
  const n = daysFromToday(x.fechaLlegada);
  const txt = n === 0 ? 'Hoy' : n === 1 ? 'Mañana' : n > 1 ? `En ${n} días` : `Atrasado ${-n} día${n === -1 ? '' : 's'}`;
  return `<span class="when ${n < 0 ? 'late' : n <= 1 ? 'soon' : ''}">${txt}</span><span class="sub-line">${fmtDate(x.fechaLlegada)}</span>`;
}

function buildProveedores() {
  $('#tab-proveedores').innerHTML = `
    <div class="ph"><div><h2>Proveedores y pedidos</h2><p>Registra a quién le compras y los pedidos que haces: cantidades, precios, total y fecha de llegada.</p></div></div>
    <div class="subtabs" role="tablist"><button type="button" data-sub="pedidos">Pedidos</button><button type="button" data-sub="proveedores">Proveedores</button></div>
    <div id="sub-pedidos">
      <div class="toolbar">
        <label class="search">${I.search}<input id="ped-q" type="search" placeholder="Buscar pedido, proveedor o producto…" autocomplete="off"></label>
        <select id="ped-estado" title="Estado"><option value="activos">En curso</option><option value="">Todos</option>
          ${Object.entries(EST_PED).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
        <select id="ped-prov" title="Proveedor"></select>
        <div class="spacer"></div>
        <button class="btn primary" id="ped-add" type="button">${I.plus} Nuevo pedido</button>
      </div>
      <div class="stats" id="ped-stats"></div>
      <div class="table-wrap" id="ped-wrap"></div>
    </div>
    <div id="sub-proveedores">
      <div class="toolbar">
        <label class="search">${I.search}<input id="prv-q" type="search" placeholder="Buscar proveedor, contacto, RUC…" autocomplete="off"></label>
        <div class="spacer"></div>
        <button class="btn primary" id="prv-add" type="button">${I.plus} Agregar proveedor</button>
      </div>
      <div class="cards" id="prv-wrap"></div>
    </div>`;
  $('#tab-proveedores .subtabs').addEventListener('click', e => {
    const b = e.target.closest('[data-sub]');
    if (b) { ui.ped.sub = b.dataset.sub; renderProveedores(); }
  });
  $('#ped-q').addEventListener('input', e => { ui.ped.q = e.target.value; renderPedidosList(); });
  $('#ped-estado').addEventListener('change', e => { ui.ped.estado = e.target.value; renderPedidosList(); });
  $('#ped-prov').addEventListener('change', e => { ui.ped.prov = e.target.value; renderPedidosList(); });
  $('#ped-add').addEventListener('click', () => {
    if (!S.proveedores.length) { toast('Primero agrega un proveedor', 'error'); ui.ped.sub = 'proveedores'; renderProveedores(); return; }
    if (!S.productos.length) return toast('Primero registra productos en Inventario', 'error');
    formPedido();
  });
  $('#ped-stats').addEventListener('click', e => {
    const c = e.target.closest('[data-estado]');
    if (c) { ui.ped.estado = c.dataset.estado; renderPedidosList(); }
  });
  $('#ped-wrap').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    const tr = e.target.closest('tr[data-id]');
    if (!tr) { if (b?.dataset.act === 'add') $('#ped-add').click(); return; }
    if (b?.dataset.act === 'recibir') { recibirPedido(tr.dataset.id); return; }
    verPedido(tr.dataset.id);
  });
  $('#prv-q').addEventListener('input', e => { ui.prv.q = e.target.value; renderProveedoresList(); });
  $('#prv-add').addEventListener('click', () => formProveedor());
  $('#prv-wrap').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = b.closest('[data-id]')?.dataset.id;
    if (b.dataset.act === 'add') formProveedor();
    if (b.dataset.act === 'edit') formProveedor(id);
    if (b.dataset.act === 'del') eliminarProveedor(id);
    if (b.dataset.act === 'pedido') {
      if (!S.productos.length) return toast('Primero registra productos en Inventario', 'error');
      formPedido(null, id);
    }
    if (b.dataset.act === 'ver') { ui.ped.sub = 'pedidos'; ui.ped.prov = id; ui.ped.estado = ''; renderProveedores(); }
  });
}

function renderProveedores() {
  $$('#tab-proveedores .subtabs button').forEach(b => b.classList.toggle('active', b.dataset.sub === ui.ped.sub));
  $('#sub-pedidos').hidden = ui.ped.sub !== 'pedidos';
  $('#sub-proveedores').hidden = ui.ped.sub !== 'proveedores';
  renderPedidosList();
  renderProveedoresList();
}

function renderPedidosList() {
  const f = ui.ped;
  $('#ped-estado').value = f.estado;
  fillSelect($('#ped-prov'), [['', 'Todos los proveedores'], ...[...S.proveedores].sort((a, b) => cmp(a.empresa, b.empresa)).map(p => [p.id, p.empresa])], f.prov);
  f.prov = $('#ped-prov').value;
  const all = S.pedidos;
  const act = all.filter(x => x.estado === 'pendiente' || x.estado === 'camino');
  const late = act.filter(x => x.fechaLlegada && daysFromToday(x.fechaLlegada) < 0);
  const week = act.filter(x => x.fechaLlegada && daysFromToday(x.fechaLlegada) >= 0 && daysFromToday(x.fechaLlegada) <= 7);
  const mes = all.filter(x => x.estado !== 'cancelado' && (x.fechaPedido || '').slice(0, 7) === today().slice(0, 7));
  $('#ped-stats').innerHTML = `
    <button class="stat ${f.estado === 'activos' ? 'on' : ''}" data-estado="activos" type="button"><span>Pedidos en curso</span><b>${act.length}</b><small>Por pagar/recibir: ${money(act.reduce((s, x) => s + pedTotal(x), 0))}</small></button>
    <div class="stat"><span>Llegan en 7 días</span><b>${week.length}</b><small>${week.filter(x => daysFromToday(x.fechaLlegada) === 0).length} llegan hoy</small></div>
    <div class="stat ${late.length ? 'danger' : ''}"><span>Atrasados</span><b>${late.length}</b><small>Fecha de llegada vencida</small></div>
    <div class="stat"><span>Comprado este mes</span><b>${money(mes.reduce((s, x) => s + pedTotal(x), 0))}</b><small>${mes.length} pedido(s)</small></div>`;

  const q = norm(f.q.trim());
  const list = all.filter(x => {
    if (f.estado === 'activos' && !(x.estado === 'pendiente' || x.estado === 'camino')) return false;
    if (f.estado && f.estado !== 'activos' && x.estado !== f.estado) return false;
    if (f.prov && x.proveedorId !== f.prov) return false;
    if (q) {
      const hay = [x.codigo, provName(x.proveedorId, x.proveedorNombre), x.notas, ...x.items.map(it => prodById(it.productoId)?.nombre || it.nombre)].join(' ');
      if (!norm(hay).includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    const order = { pendiente: 0, camino: 0, recibido: 1, cancelado: 2 };
    return order[a.estado] - order[b.estado] || cmp(a.fechaLlegada || '9999', b.fechaLlegada || '9999') || cmp(b.codigo, a.codigo);
  });

  const wrap = $('#ped-wrap');
  if (!all.length) {
    wrap.innerHTML = `<div class="empty"><h3>Aún no hay pedidos</h3><p>Crea un pedido eligiendo el proveedor y los productos de tu inventario.</p>
      <div class="btn-row"><button class="btn primary" data-act="add">${I.plus} Nuevo pedido</button></div></div>`;
    return;
  }
  if (!list.length) { wrap.innerHTML = `<div class="empty"><h3>Sin resultados</h3><p>Cambia el filtro de estado o la búsqueda.</p></div>`; return; }
  wrap.innerHTML = `<table class="tbl click"><thead><tr><th>Código</th><th>Proveedor</th><th>Fecha pedido</th><th>Llegada</th><th>Productos</th><th class="num">Total</th><th>Estado</th><th></th></tr></thead>
    <tbody>${list.map(x => `<tr data-id="${x.id}">
      <td class="mono muted">${esc(x.codigo)}</td>
      <td><b>${esc(provName(x.proveedorId, x.proveedorNombre) || '—')}</b></td>
      <td>${fmtDate(x.fechaPedido)}</td>
      <td>${llegadaHTML(x)}</td>
      <td>${plural(x.items.length, 'producto', 'productos')}<span class="sub-line">${fmtNum(pedUnits(x))} unidades</span></td>
      <td class="num"><b>${money(pedTotal(x))}</b></td>
      <td><span class="badge ${EST_PED[x.estado].cls}">${EST_PED[x.estado].label}</span></td>
      <td>${x.estado === 'pendiente' || x.estado === 'camino' ? `<button type="button" class="btn sm" data-act="recibir">${I.check} Recibir</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
}

function renderProveedoresList() {
  const q = norm(ui.prv.q.trim());
  const all = S.proveedores;
  const list = all.filter(p => !q || norm([p.empresa, p.contacto, p.ruc, p.telefono, p.email].join(' ')).includes(q))
    .sort((a, b) => cmp(a.empresa, b.empresa));
  const wrap = $('#prv-wrap');
  if (!all.length) {
    wrap.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>Sin proveedores</h3><p>Agrega a las empresas que te venden la mercadería.</p>
      <div class="btn-row"><button class="btn primary" data-act="add">${I.plus} Agregar proveedor</button></div></div>`;
    return;
  }
  if (!list.length) { wrap.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>Sin resultados</h3></div>`; return; }
  wrap.innerHTML = list.map(p => {
    const prods = S.productos.filter(x => x.proveedorId === p.id);
    const peds = S.pedidos.filter(x => x.proveedorId === p.id && x.estado !== 'cancelado');
    const act = peds.filter(x => x.estado === 'pendiente' || x.estado === 'camino').length;
    const bajos = prods.filter(esBajo).length;
    return `<article class="pv-card" data-id="${p.id}">
      <div><div class="mono muted">${esc(p.codigo || '')}</div><h3>${esc(p.empresa)}</h3></div>
      <div class="pv-meta">
        ${p.contacto ? `<div>Contacto: <b>${esc(p.contacto)}</b></div>` : ''}
        ${p.telefono ? `<div>Teléfono: <a href="tel:${esc(p.telefono)}">${esc(p.telefono)}</a></div>` : ''}
        ${p.email ? `<div>Correo: <a href="mailto:${esc(p.email)}">${esc(p.email)}</a></div>` : ''}
        ${p.ruc ? `<div>RUC: ${esc(p.ruc)}</div>` : ''}
        ${p.direccion ? `<div>${esc(p.direccion)}</div>` : ''}
        ${p.notas ? `<div class="muted">${esc(p.notas)}</div>` : ''}
        ${bajos ? `<div class="danger-t"><b class="danger-t">${bajos}</b> producto(s) en o bajo el mínimo</div>` : ''}
      </div>
      <div class="pv-stats"><div><b>${prods.length}</b>productos</div><div><b>${act}</b>en curso</div><div><b>${money(peds.reduce((s, x) => s + pedTotal(x), 0))}</b>comprado</div></div>
      <div class="pv-actions">
        <button class="btn sm primary" data-act="pedido" type="button">${I.plus} Pedido</button>
        <button class="btn sm" data-act="ver" type="button">Ver pedidos</button>
        <button class="btn sm" data-act="edit" type="button">${I.edit} Editar</button>
        <button class="icon-btn danger" data-act="del" type="button" title="Eliminar">${I.trash}</button>
      </div></article>`;
  }).join('');
}

function formProveedor(id) {
  const p = id ? provById(id) : null;
  const isNew = !p;
  const body = `<form id="f-prv" autocomplete="off"><div class="grid2">
    <label class="field span2"><span>Empresa / razón social *</span><input name="empresa" required maxlength="100" value="${esc(p?.empresa || '')}"></label>
    <label class="field"><span>Contacto (vendedor)</span><input name="contacto" maxlength="80" value="${esc(p?.contacto || '')}" placeholder="Nombre de la persona"></label>
    <label class="field"><span>Teléfono / WhatsApp</span><input name="telefono" type="tel" maxlength="30" value="${esc(p?.telefono || '')}"></label>
    <label class="field"><span>Correo</span><input name="email" type="email" maxlength="80" value="${esc(p?.email || '')}"></label>
    <label class="field"><span>RUC</span><input name="ruc" maxlength="15" inputmode="numeric" value="${esc(p?.ruc || '')}"></label>
    <label class="field span2"><span>Dirección</span><input name="direccion" maxlength="140" value="${esc(p?.direccion || '')}"></label>
    <label class="field span2"><span>Notas</span><textarea name="notas" rows="2" placeholder="Días de visita, forma de pago, tiempo de entrega…">${esc(p?.notas || '')}</textarea></label>
  </div></form>`;
  const d = modal({
    title: isNew ? 'Agregar proveedor' : 'Editar proveedor', body,
    foot: `<button class="btn" data-close>Cancelar</button><button class="btn primary" type="submit" form="f-prv">Guardar</button>`,
  });
  const f = $('#f-prv', d), E = f.elements;
  f.addEventListener('submit', e => {
    e.preventDefault();
    const datos = {};
    ['empresa', 'contacto', 'telefono', 'email', 'ruc', 'direccion', 'notas'].forEach(k => { datos[k] = E[k].value.trim(); });
    if (!datos.empresa) return toast('Escribe el nombre de la empresa', 'error');
    if (isNew) S.proveedores.push({ id: uid(), codigo: nextCode('prov', 'PRV'), creado: new Date().toISOString(), ...datos });
    else Object.assign(p, datos);
    logH(isNew ? 'Proveedor agregado' : 'Proveedor editado', datos.empresa);
    d.close();
    commit();
    toast(isNew ? 'Proveedor agregado' : 'Proveedor actualizado');
  });
  setTimeout(() => E.empresa.focus(), 40);
}

async function eliminarProveedor(id) {
  const p = provById(id);
  if (!p) return;
  const n = S.productos.filter(x => x.proveedorId === id).length;
  const ok = await confirmBox(`Se eliminará <b>${esc(p.empresa)}</b>.${n ? ` ${n} producto(s) quedarán sin proveedor.` : ''} Los pedidos antiguos se conservan.`, { ok: 'Eliminar', danger: true, title: 'Eliminar proveedor' });
  if (!ok) return;
  S.productos.forEach(x => { if (x.proveedorId === id) x.proveedorId = null; });
  S.pedidos.forEach(x => { if (x.proveedorId === id) x.proveedorNombre = p.empresa; });
  S.devoluciones.forEach(x => { if (x.proveedorId === id) x.proveedorNombre = p.empresa; });
  S.proveedores = S.proveedores.filter(x => x.id !== id);
  logH('Proveedor eliminado', p.empresa);
  commit();
  toast('Proveedor eliminado');
}

/* ---------- Formulario de pedido ---------- */
function formPedido(id, provId = '', preItems = null) {
  const pd = id ? S.pedidos.find(x => x.id === id) : null;
  const isNew = !pd;
  const body = `<form id="f-ped" autocomplete="off">
    <p class="hint">${isNew ? `Código asignado: <b class="mono">${peekCode('ped', 'PED')}</b>` : `Código: <b class="mono">${esc(pd.codigo)}</b>`}</p>
    <div class="grid4">
      <label class="field"><span>Proveedor *</span><select name="proveedorId" required>${provOptionsHTML(pd?.proveedorId || provId, '— Elige proveedor —')}</select></label>
      <label class="field"><span>Fecha del pedido</span><input type="date" name="fechaPedido" value="${pd?.fechaPedido || today()}"></label>
      <label class="field"><span>¿Qué día llega?</span><input type="date" name="fechaLlegada" value="${pd?.fechaLlegada || ''}"></label>
      <label class="field"><span>Estado</span><select name="estado"><option value="pendiente">Pendiente</option><option value="camino">En camino</option></select></label>
    </div>
    <div class="lines-head"><h4 class="sub-h">Productos del pedido</h4>
      <button type="button" class="btn sm" id="ped-low" title="Agrega los productos de este proveedor que están en rojo">Agregar los que están en rojo</button></div>
    <div class="table-wrap flat"><table class="tbl lines"><thead><tr><th>Producto</th><th class="num">Cantidad</th><th class="num">Precio compra c/u</th><th class="num">Subtotal</th><th></th></tr></thead>
      <tbody id="ped-lines"></tbody></table></div>
    <button type="button" class="btn sm add-line" id="ped-addline">${I.plus} Agregar producto</button>
    <div class="ped-total"><span>Unidades: <b id="ped-units">0</b></span><span>Total: <b id="ped-total">${money(0)}</b></span></div>
    <label class="field"><span>Notas</span><textarea name="notas" rows="2" placeholder="Forma de pago, condiciones, N° de factura…">${esc(pd?.notas || '')}</textarea></label>
  </form>`;
  const d = modal({
    title: isNew ? 'Nuevo pedido' : 'Editar pedido', body, size: 'wide',
    foot: `<button class="btn" data-close>Cancelar</button><button class="btn primary" type="submit" form="f-ped">${isNew ? 'Guardar pedido' : 'Guardar cambios'}</button>`,
  });
  const f = $('#f-ped', d), E = f.elements, tb = $('#ped-lines', d);
  if (pd) E.estado.value = pd.estado === 'camino' ? 'camino' : 'pendiente';

  const optsHTML = sel => {
    const pv = E.proveedorId.value;
    const byName = a => [...a].sort((x, y) => cmp(x.nombre, y.nombre));
    const mine = byName(S.productos.filter(p => pv && p.proveedorId === pv));
    const rest = byName(S.productos.filter(p => !(pv && p.proveedorId === pv)));
    const o = p => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.nombre)} · ${esc(p.codigo)}</option>`;
    return `<option value="">— Elige un producto —</option>`
      + (mine.length ? `<optgroup label="De este proveedor">${mine.map(o).join('')}</optgroup>` : '')
      + (rest.length ? `<optgroup label="${mine.length ? 'Otros productos' : 'Productos'}">${rest.map(o).join('')}</optgroup>` : '');
  };
  const syncLine = tr => {
    const p = prodById($('.l-prod', tr).value);
    const precioIn = $('.l-precio', tr);
    const upd = $('.l-upd', tr);
    if (p) {
      $('.l-note', tr).innerHTML = `Stock: <b class="${esBajo(p) ? 'danger-t' : ''}">${fmtNum(p.cantidad)} ${esc(p.unidad || '')}</b> · mín. ${fmtNum(minDe(p))} · precio actual ${money(p.precioCompra)}`;
      const differs = precioIn.value !== '' && r2(num(precioIn.value)) !== r2(num(p.precioCompra));
      upd.hidden = !differs;
      if (differs) $('span', upd).innerHTML = `Cambió el precio: actualizar en inventario (${money(p.precioCompra)} → ${money(num(precioIn.value))})`;
    } else { $('.l-note', tr).textContent = ''; upd.hidden = true; }
    $('.l-sub', tr).innerHTML = money(num($('.l-cant', tr).value) * num(precioIn.value));
  };
  const totals = () => {
    let t = 0, u = 0;
    $$('tr', tb).forEach(tr => { const q = num($('.l-cant', tr).value); u += q; t += q * num($('.l-precio', tr).value); });
    $('#ped-units', d).textContent = fmtNum(u);
    $('#ped-total', d).innerHTML = money(t);
  };
  const addLine = (it = {}) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><select class="l-prod" aria-label="Producto">${optsHTML(it.productoId)}</select><div class="l-note"></div></td>
      <td class="num"><input class="l-cant" type="number" min="0" step="any" inputmode="decimal" aria-label="Cantidad" value="${it.cantidad ?? ''}"></td>
      <td class="num"><input class="l-precio" type="number" min="0" step="0.01" inputmode="decimal" aria-label="Precio" value="${it.precio ?? ''}">
        <label class="l-upd" hidden><input type="checkbox" class="l-updchk" checked><span></span></label></td>
      <td class="num l-sub"></td>
      <td><button type="button" class="icon-btn danger l-del" title="Quitar">${I.x}</button></td>`;
    tb.appendChild(tr);
    syncLine(tr);
    return tr;
  };
  tb.addEventListener('change', e => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    if (e.target.classList.contains('l-prod')) {
      const p = prodById(e.target.value);
      if (p) {
        $('.l-precio', tr).value = num(p.precioCompra);
        if (!$('.l-cant', tr).value) $('.l-cant', tr).value = sugerido(p);
      }
    }
    syncLine(tr); totals();
  });
  tb.addEventListener('input', e => { const tr = e.target.closest('tr'); if (tr) { syncLine(tr); totals(); } });
  tb.addEventListener('click', e => { if (e.target.closest('.l-del')) { e.target.closest('tr').remove(); totals(); } });
  $('#ped-addline', d).addEventListener('click', () => { const tr = addLine(); $('.l-prod', tr).focus(); });
  $('#ped-low', d).addEventListener('click', () => {
    const pv = E.proveedorId.value;
    const ya = new Set($$('.l-prod', tb).map(s => s.value));
    const lows = S.productos.filter(p => esBajo(p) && (!pv || p.proveedorId === pv) && !ya.has(p.id));
    if (!lows.length) return toast(pv ? 'Ningún producto de este proveedor está en rojo' : 'No hay productos en rojo');
    $$('tr', tb).forEach(tr => { if (!$('.l-prod', tr).value) tr.remove(); });
    lows.forEach(p => addLine({ productoId: p.id, cantidad: sugerido(p), precio: num(p.precioCompra) }));
    totals();
    toast(`${lows.length} producto(s) agregados`);
  });
  E.proveedorId.addEventListener('change', () => {
    $$('tr', tb).forEach(tr => { const s = $('.l-prod', tr); s.innerHTML = optsHTML(s.value); });
  });
  (pd ? pd.items : preItems || [{}]).forEach(it => addLine(it));
  totals();

  f.addEventListener('submit', e => {
    e.preventDefault();
    const pv = provById(E.proveedorId.value);
    if (!pv) return toast('Elige un proveedor', 'error');
    const items = [];
    let bad = false;
    $$('tr', tb).forEach(tr => {
      const pid = $('.l-prod', tr).value, q = r3(num($('.l-cant', tr).value)), pr = r2(num($('.l-precio', tr).value));
      if (!pid && !q) return;
      if (!pid || q <= 0) { bad = true; return; }
      const upd = !$('.l-upd', tr).hidden && $('.l-updchk', tr).checked;
      items.push({ productoId: pid, nombre: prodById(pid)?.nombre || '', cantidad: q, precio: pr, upd });
    });
    if (bad) return toast('Revisa las líneas: falta el producto o la cantidad', 'error');
    if (!items.length) return toast('Agrega al menos un producto', 'error');
    const rec = pd || { id: uid(), codigo: nextCode('ped', 'PED'), creado: new Date().toISOString() };
    let cambios = 0;
    const precios = [];
    items.forEach(it => {
      if (it.upd) {
        const p = prodById(it.productoId);
        if (p && r2(num(p.precioCompra)) !== it.precio) { precios.push(`${p.nombre} ${moneyTxt(p.precioCompra)} → ${moneyTxt(it.precio)}`); cambiarPrecioCompra(p, it.precio, rec.codigo); cambios++; }
      }
      delete it.upd;
    });
    Object.assign(rec, {
      proveedorId: pv.id, proveedorNombre: pv.empresa, fechaPedido: E.fechaPedido.value || today(),
      fechaLlegada: E.fechaLlegada.value, estado: E.estado.value, notas: E.notas.value.trim(), items,
    });
    if (isNew) S.pedidos.push(rec);
    logH(isNew ? 'Pedido creado' : 'Pedido editado', `${rec.codigo} · ${pv.empresa} · ${items.length} producto(s) · ${moneyTxt(pedTotal(rec))}${rec.fechaLlegada ? ' · llega ' + fmtDate(rec.fechaLlegada) : ''}`);
    if (precios.length) logH('Precio de compra cambiado', precios.join(' · ') + ` (pedido ${rec.codigo})`);
    d.close();
    ui.ped.sub = 'pedidos';
    commit();
    toast(`${isNew ? 'Pedido ' + rec.codigo + ' guardado' : 'Pedido actualizado'}${cambios ? ` · ${cambios} precio(s) actualizados` : ''}`);
  });
}

function verPedido(id) {
  const d = modal({ title: 'Pedido', body: '<div id="pdet"></div>', size: 'wide', backdropClose: true });
  const paint = () => {
    const x = S.pedidos.find(y => y.id === id);
    if (!x) { d.close(); return; }
    const pv = provById(x.proveedorId);
    const activo = x.estado === 'pendiente' || x.estado === 'camino';
    $('.m-head h2', d).textContent = 'Pedido ' + x.codigo;
    $('#pdet', d).innerHTML = `
      <div class="det-head">
        <div><span class="badge ${EST_PED[x.estado].cls}">${EST_PED[x.estado].label}</span>
          <h3 class="det-name">${esc(provName(x.proveedorId, x.proveedorNombre) || 'Proveedor eliminado')}</h3>
          ${pv ? `<div class="muted">${esc(pv.contacto || '')}${pv.telefono ? ` · <a href="tel:${esc(pv.telefono)}">${esc(pv.telefono)}</a>` : ''}</div>` : ''}</div>
        <div class="btn-row">
          ${activo ? `<button class="btn sm primary" data-act="recibir">${I.check} Marcar recibido</button>` : ''}
          ${x.estado === 'pendiente' ? `<button class="btn sm" data-act="camino">${I.truck} En camino</button>` : ''}
          ${activo ? `<button class="btn sm" data-act="edit">${I.edit} Editar</button>` : ''}
          <button class="btn sm" data-act="copy" title="Copia el pedido como texto para enviarlo por WhatsApp">${I.copy} Copiar texto</button>
          ${activo ? `<button class="btn sm" data-act="cancel">Cancelar pedido</button>` : ''}
          <button class="icon-btn danger" data-act="del" title="Eliminar">${I.trash}</button>
        </div>
      </div>
      <div class="info-list">
        <div class="card-sm"><h4>Fecha del pedido</h4><b>${fmtDate(x.fechaPedido)}</b></div>
        <div class="card-sm"><h4>Llegada</h4>${llegadaHTML(x)}</div>
        <div class="card-sm"><h4>Total</h4><b>${money(pedTotal(x))}</b><div class="muted">${fmtNum(pedUnits(x))} unidades</div></div>
      </div>
      <div class="table-wrap flat"><table class="tbl compact"><thead><tr><th>Producto</th><th class="num">Cantidad</th><th class="num">Precio c/u</th><th class="num">Subtotal</th></tr></thead>
        <tbody>${x.items.map(it => {
          const p = prodById(it.productoId);
          return `<tr><td>${nameHTML(p, it.nombre)}<span class="sub-line">${esc(p?.codigo || '')}${p ? ` · stock actual ${fmtNum(p.cantidad)}` : ''}</span></td>
            <td class="num">${fmtNum(it.cantidad)} ${esc(p?.unidad || '')}</td><td class="num">${money(it.precio)}</td><td class="num"><b>${money(num(it.cantidad) * num(it.precio))}</b></td></tr>`;
        }).join('')}
        <tr><td colspan="3" class="num"><b>Total</b></td><td class="num"><b>${money(pedTotal(x))}</b></td></tr></tbody></table></div>
      ${x.notas ? `<h4 class="sub-h">Notas</h4><div class="notes">${esc(x.notas)}</div>` : ''}
      ${x.estado === 'recibido' ? '<p class="hint" style="margin-top:12px">Al recibirlo se sumaron las cantidades al inventario.</p>' : ''}`;
  };
  paint();
  d.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const x = S.pedidos.find(y => y.id === id);
    if (!x) return;
    const act = b.dataset.act;
    if (act === 'recibir') { if (await recibirPedido(id)) paint(); }
    if (act === 'camino') { x.estado = 'camino'; logH('Pedido en camino', `${x.codigo} · ${provName(x.proveedorId, x.proveedorNombre)}`); commit(); paint(); toast('Pedido marcado en camino'); }
    if (act === 'edit') { d.close(); formPedido(id); }
    if (act === 'copy') copiarPedido(x);
    if (act === 'cancel') {
      if (await confirmBox(`¿Cancelar el pedido <b>${esc(x.codigo)}</b>? No se modifica el stock.`, { ok: 'Cancelar pedido', danger: true, title: 'Cancelar pedido' })) {
        x.estado = 'cancelado'; logH('Pedido cancelado', `${x.codigo} · ${provName(x.proveedorId, x.proveedorNombre)} · ${moneyTxt(pedTotal(x))}`); commit(); paint(); toast('Pedido cancelado');
      }
    }
    if (act === 'del') {
      const extra = x.estado === 'recibido' ? ' El stock que ya se sumó no se modifica.' : '';
      if (await confirmBox(`Se eliminará el pedido <b>${esc(x.codigo)}</b>.${extra}`, { ok: 'Eliminar', danger: true, title: 'Eliminar pedido' })) {
        S.pedidos = S.pedidos.filter(y => y.id !== id); logH('Pedido eliminado', `${x.codigo} · ${provName(x.proveedorId, x.proveedorNombre)}`); commit(); d.close(); toast('Pedido eliminado');
      }
    }
  });
}

async function recibirPedido(id) {
  const x = S.pedidos.find(y => y.id === id);
  if (!x) return false;
  const ok = await confirmBox(`Se marcará <b>${esc(x.codigo)}</b> como recibido y se sumarán <b>${fmtNum(pedUnits(x))} unidades</b> al inventario.`, { ok: 'Recibir y sumar al stock', title: 'Recibir pedido' });
  if (!ok) return false;
  let faltan = 0;
  x.items.forEach(it => {
    const p = prodById(it.productoId);
    if (p) mover(p, 'entrada', it.cantidad, `Pedido ${x.codigo} · ${provName(x.proveedorId, x.proveedorNombre)}`, x.codigo);
    else faltan++;
  });
  x.estado = 'recibido';
  x.recibidoEn = today();
  logH('Pedido recibido', `${x.codigo} · ${provName(x.proveedorId, x.proveedorNombre)} · +${fmtNum(pedUnits(x))} unidades al stock · ${moneyTxt(pedTotal(x))}`);
  commit();
  toast(`Pedido ${x.codigo} recibido${faltan ? ` (${faltan} producto(s) ya no existen)` : ''}`);
  return true;
}

function copiarPedido(x) {
  const lines = [
    `Pedido ${x.codigo} — ${S.config.nombre}`,
    `Proveedor: ${provName(x.proveedorId, x.proveedorNombre)}`,
    `Fecha: ${fmtDate(x.fechaPedido)}${x.fechaLlegada ? ` · Llegada: ${fmtDate(x.fechaLlegada)}` : ''}`,
    '',
    ...x.items.map(it => { const p = prodById(it.productoId); return `• ${fmtNum(it.cantidad)} ${p?.unidad || ''} ${p?.nombre || it.nombre} — ${moneyTxt(it.precio)} c/u = ${moneyTxt(num(it.cantidad) * num(it.precio))}`.replace(/\s+/g, ' '); }),
    '',
    `TOTAL: ${moneyTxt(pedTotal(x))}`,
  ];
  if (x.notas) lines.push('', x.notas);
  const txt = lines.join('\n');
  (navigator.clipboard?.writeText(txt) || Promise.reject())
    .then(() => toast('Pedido copiado. Pégalo en WhatsApp o correo.'))
    .catch(() => { modal({ title: 'Copiar pedido', body: `<textarea rows="12" style="width:100%">${esc(txt)}</textarea>` }); });
}

/* =========================================================
   4. PRECIOS Y CARRITO (ayudantes)
   ========================================================= */
function buildVentas() {
  $('#tab-ventas').innerHTML = `
    <div class="ph"><div><h2>Precios y carrito</h2><p>Busca el producto, toca <b>+</b> para sumarlo al carrito y mira el total al instante.</p></div></div>
    <div class="pos">
      <div>
        <div class="toolbar"><label class="search">${I.search}<input id="pos-q" type="search" placeholder="Buscar producto o código…" autocomplete="off"></label></div>
        <div class="cat-chips" id="pos-cats"></div>
        <div class="pgrid" id="pos-grid"></div>
      </div>
      <aside class="cart" id="cart" aria-label="Carrito"></aside>
    </div>`;
  $('#pos-q').addEventListener('input', e => { ui.pos.q = e.target.value; renderPOSGrid(); });
  $('#pos-cats').addEventListener('click', e => {
    const b = e.target.closest('[data-cat]');
    if (b) { ui.pos.cat = b.dataset.cat; renderPOSGrid(); }
  });
  $('#pos-grid').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    const card = e.target.closest('[data-id]');
    if (!b || !card) return;
    cartChange(card.dataset.id, b.dataset.act === 'dec' ? -1 : 1);
  });
  const cart = $('#cart');
  cart.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const pid = b.closest('[data-id]')?.dataset.id;
    const act = b.dataset.act;
    if (act === 'inc') cartChange(pid, 1);
    if (act === 'dec') cartChange(pid, -1);
    if (act === 'rm') cartSet(pid, 0);
    if (act === 'clear' && CART.length) { if (await confirmBox('¿Vaciar el carrito?', { ok: 'Vaciar', danger: true, title: 'Vaciar carrito' })) { CART = []; saveCart(); renderPOS(); } }
    if (act === 'sell') registrarVenta();
    if (act === 'anular') anularVenta(b.dataset.venta);
  });
  cart.addEventListener('change', e => {
    if (e.target.dataset.act === 'qty') cartSet(e.target.closest('[data-id]').dataset.id, num(e.target.value));
  });
  $('#cart-bar').addEventListener('click', () => $('#cart').scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function cartQty(pid) { return CART.find(c => c.productoId === pid)?.cantidad || 0; }
function cartSet(pid, q) {
  q = r3(Math.max(0, q));
  const it = CART.find(c => c.productoId === pid);
  if (!q) CART = CART.filter(c => c.productoId !== pid);
  else if (it) it.cantidad = q;
  else CART.push({ productoId: pid, cantidad: q });
  saveCart();
  renderPOS();
}
function cartChange(pid, delta) { cartSet(pid, cartQty(pid) + delta); }
function cartLines() {
  return CART.map(c => ({ c, p: prodById(c.productoId) })).filter(x => x.p);
}

function renderPOS() { renderPOSGrid(); renderCart(); renderCartBar(); }

function renderPOSGrid() {
  const cats = S.config.categorias.filter(c => S.productos.some(p => p.categoria === c));
  if (ui.pos.cat && !cats.includes(ui.pos.cat)) ui.pos.cat = '';
  $('#pos-cats').innerHTML = cats.length ? [['', 'Todas'], ...cats.map(c => [c, c])]
    .map(([v, l]) => `<button type="button" class="chipbtn ${ui.pos.cat === v ? 'active' : ''}" data-cat="${esc(v)}">${esc(l)}</button>`).join('') : '';
  const q = norm(ui.pos.q.trim());
  const list = S.productos.filter(p => (!ui.pos.cat || p.categoria === ui.pos.cat) && (!q || norm(p.nombre + ' ' + p.codigo + ' ' + (p.categoria || '')).includes(q)))
    .sort((a, b) => cmp(a.nombre, b.nombre));
  const grid = $('#pos-grid');
  if (!S.productos.length) { grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>No hay productos</h3><p>Se registran en la pestaña Inventario.</p></div>`; return; }
  if (!list.length) { grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><h3>Sin resultados</h3><p>Prueba con otra palabra.</p></div>`; return; }
  grid.innerHTML = list.map(p => {
    const inC = cartQty(p.id);
    const out = num(p.cantidad) <= 0;
    return `<div class="pcard ${inC ? 'in' : ''} ${out ? 'out' : ''}" data-id="${p.id}">
      <div class="pc-top"><span class="mono muted">${esc(p.codigo)}</span>${p.categoria ? `<span class="chip">${esc(p.categoria)}</span>` : ''}</div>
      <div class="pc-name">${nameHTML(p)}</div>
      <div class="pc-bottom">
        <div><div class="pc-price">${money(p.precioVenta)}</div><div class="pc-stock ${esBajo(p) ? 'low' : ''}">${out ? 'Agotado' : `Stock: ${fmtNum(p.cantidad)} ${esc(p.unidad || '')}`}</div></div>
        ${inC ? `<div class="stepper"><button type="button" data-act="dec" aria-label="Quitar uno">−</button><span>${fmtNum(inC)}</span><button type="button" data-act="inc" aria-label="Agregar uno">+</button></div>`
          : `<button type="button" class="add-btn" data-act="add" aria-label="Agregar ${esc(p.nombre)} al carrito">${I.plus}</button>`}
      </div></div>`;
  }).join('');
}

function cartTotal() { return cartLines().reduce((s, x) => s + x.c.cantidad * num(x.p.precioVenta), 0); }

function renderCart() {
  const lines = cartLines();
  if (lines.length !== CART.length) { CART = lines.map(x => x.c); saveCart(); }
  const total = cartTotal();
  const units = lines.reduce((s, x) => s + x.c.cantidad, 0);
  const hoy = S.ventas.filter(v => isToday(v.fecha)).sort((a, b) => b.fecha.localeCompare(a.fecha));
  $('#cart').innerHTML = `
    <div class="cart-head"><h3>${I.cart} Carrito</h3>${lines.length ? '<button type="button" class="btn sm ghost" data-act="clear">Vaciar</button>' : ''}</div>
    ${lines.length ? `<ul class="cart-list">${lines.map(({ c, p }) => `
      <li data-id="${p.id}">
        <div class="ci-name"><span>${nameHTML(p)}</span><small>${money(p.precioVenta)} c/u</small></div>
        <div class="ci-qty"><button type="button" data-act="dec" aria-label="Quitar uno">−</button><input type="number" min="0" step="any" inputmode="decimal" value="${c.cantidad}" data-act="qty" aria-label="Cantidad"><button type="button" data-act="inc" aria-label="Agregar uno">+</button></div>
        <div class="ci-sub">${money(c.cantidad * num(p.precioVenta))}</div>
        <button type="button" class="icon-btn danger" data-act="rm" title="Quitar">${I.x}</button>
        ${c.cantidad > num(p.cantidad) ? `<div class="ci-warn">Solo hay ${fmtNum(Math.max(0, num(p.cantidad)))} en stock</div>` : ''}
      </li>`).join('')}</ul>`
      : '<div class="cart-empty">El carrito está vacío.<br>Toca <b>+</b> en un producto para sumarlo.</div>'}
    <div class="cart-total"><span>Total</span><b>${money(total)}</b></div>
    <div class="cart-meta">${plural(lines.length, 'producto', 'productos')} · ${plural(units, 'unidad', 'unidades')}</div>
    <button type="button" class="btn primary block lg" data-act="sell" ${lines.length ? '' : 'disabled'}>Registrar venta</button>
    <p class="hint">Registrar la venta descuenta el stock. Si solo quieres saber el total, no es necesario.</p>
    <details class="sales"><summary>Ventas de hoy: ${hoy.length} · ${money(hoy.reduce((s, v) => s + num(v.total), 0))}</summary>
      ${hoy.length ? `<ul>${hoy.map(v => `<li><div class="row"><span><b class="mono">${esc(v.codigo)}</b> <small>${fmtTime(v.fecha)}${v.usuario ? ' · ' + esc(v.usuario) : ''}</small></span><b>${money(v.total)}</b></div>
        <small>${v.items.map(it => `${fmtNum(it.cantidad)} × ${esc(prodById(it.productoId)?.nombre || it.nombre)}`).join(', ')}</small>
        <div class="row"><span></span><button type="button" class="btn sm ghost" data-act="anular" data-venta="${v.id}">${I.undo} Anular</button></div></li>`).join('')}</ul>`
        : '<p class="muted">Aún no hay ventas registradas hoy.</p>'}
    </details>`;
}

function renderCartBar() {
  const bar = $('#cart-bar');
  const n = cartLines().length;
  bar.hidden = !(ui.tab === 'ventas' && n);
  if (!bar.hidden) bar.innerHTML = `<span>${I.cart} ${plural(n, 'producto', 'productos')} · Ver carrito</span><b>${money(cartTotal())}</b>`;
}

async function registrarVenta() {
  const lines = cartLines();
  if (!lines.length) return;
  const total = cartTotal();
  const falta = lines.filter(x => x.c.cantidad > num(x.p.cantidad));
  let msg = `Se registrará la venta por <b>${money(total)}</b> y se descontará del stock.`;
  if (falta.length) msg += `<br><br><span class="danger-t">Stock insuficiente: ${falta.map(x => esc(x.p.nombre)).join(', ')}. Quedará en negativo; revisa el conteo.</span>`;
  if (!(await confirmBox(msg, { ok: 'Registrar venta', title: 'Registrar venta' }))) return;
  const code = nextCode('venta', 'V');
  const items = lines.map(x => ({ productoId: x.p.id, nombre: x.p.nombre, cantidad: x.c.cantidad, precio: num(x.p.precioVenta) }));
  items.forEach(it => mover(prodById(it.productoId), 'venta', it.cantidad, 'Venta', code));
  S.ventas.push({ id: uid(), codigo: code, fecha: new Date().toISOString(), items, total: r2(items.reduce((s, i) => s + i.cantidad * i.precio, 0)), usuario: USUARIO });
  logH('Venta', `${code} · ${moneyTxt(total)} · ${items.map(it => `${fmtNum(it.cantidad)} × ${it.nombre}`).join(', ')}`);
  if (S.ventas.length > 3000) S.ventas = S.ventas.slice(-3000);
  CART = [];
  saveCart();
  commit();
  toast(`Venta ${code} registrada · ${moneyTxt(total)}`);
}

async function anularVenta(id) {
  const v = S.ventas.find(x => x.id === id);
  if (!v) return;
  if (!(await confirmBox(`¿Anular la venta <b>${esc(v.codigo)}</b> por ${money(v.total)}? Las cantidades vuelven al stock.`, { ok: 'Anular venta', danger: true, title: 'Anular venta' }))) return;
  v.items.forEach(it => mover(prodById(it.productoId), 'ajuste', it.cantidad, 'Venta anulada', v.codigo));
  S.movimientos = S.movimientos.filter(m => !(m.tipo === 'venta' && m.ref === v.codigo));
  S.ventas = S.ventas.filter(x => x.id !== id);
  logH('Venta anulada', `${v.codigo} · ${moneyTxt(v.total)}`);
  commit();
  toast('Venta anulada');
}

/* =========================================================
   5. CONFIGURACIÓN
   ========================================================= */
function buildConfig() {
  const tab = $('#tab-config');
  tab.addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target, E = f.elements, c = S.config;
    if (f.id === 'cfg-gen') {
      c.nombre = E.nombre.value.trim() || 'Mi Bodega';
      c.moneda = E.moneda.value.trim() || 'S/';
      logH('Configuración', `Nombre: ${c.nombre} · moneda: ${c.moneda}`); commit(); toast('Datos guardados');
    }
    if (f.id === 'cfg-min') {
      c.stockMinGlobal = Math.max(0, num(E.min.value));
      logH('Configuración', `Stock mínimo universal: ${fmtNum(c.stockMinGlobal)}`); commit(); toast('Stock mínimo universal actualizado');
    }
    if (f.id === 'cfg-rot') {
      const dias = Math.max(1, Math.round(num(E.dias.value))), rap = num(E.rapida.value), nor = num(E.normal.value);
      if (nor <= 0 || rap <= nor) return toast('“Rápida” debe ser mayor que “Normal”, y ambas mayores a 0', 'error');
      Object.assign(c, { rotDias: dias, rotRapida: rap, rotNormal: nor });
      logH('Configuración', `Rotación: ${dias} días · rápida ${fmtNum(rap)} · normal ${fmtNum(nor)}`); commit(); toast('Niveles de rotación actualizados');
    }
    if (f.id === 'cfg-cat') {
      const v = E.cat.value.trim();
      if (!v) return;
      if (c.categorias.some(x => norm(x) === norm(v))) return toast('Esa categoría ya existe', 'error');
      c.categorias.push(v);
      logH('Categoría agregada', v);
      commit(); toast('Categoría agregada');
      setTimeout(() => $('#cfg-cat input')?.focus(), 0);
    }
  });
  tab.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, c = S.config;
    if (act === 'ren-cat') {
      const old = b.dataset.cat;
      const v = await askText('Renombrar categoría', 'Nuevo nombre', old);
      if (!v || v === old) return;
      if (c.categorias.some(x => x !== old && norm(x) === norm(v))) return toast('Esa categoría ya existe', 'error');
      c.categorias = c.categorias.map(x => (x === old ? v : x));
      S.productos.forEach(p => { if (p.categoria === old) p.categoria = v; });
      logH('Categoría renombrada', `${old} → ${v}`); commit(); toast('Categoría renombrada');
    }
    if (act === 'del-cat') {
      const cat = b.dataset.cat;
      const n = S.productos.filter(p => p.categoria === cat).length;
      if (n && !(await confirmBox(`<b>${esc(cat)}</b> está en ${n} producto(s). Quedarán sin categoría.`, { ok: 'Eliminar', danger: true, title: 'Eliminar categoría' }))) return;
      c.categorias = c.categorias.filter(x => x !== cat);
      S.productos.forEach(p => { if (p.categoria === cat) p.categoria = ''; });
      logH('Categoría eliminada', cat); commit(); toast('Categoría eliminada');
    }
    if (act === 'reset-mins') {
      if (!(await confirmBox('Todos los productos usarán el mínimo universal.', { ok: 'Aplicar', title: 'Quitar mínimos propios' }))) return;
      S.productos.forEach(p => { p.stockMin = null; });
      logH('Configuración', 'Todos los productos usan el mínimo universal');
      commit(); toast('Listo');
    }
    if (act === 'export') exportarJSON();
    if (act === 'csv') exportarCSV();
    if (act === 'seed') cargarEjemplo();
    if (act === 'reset') borrarTodo();
  });
  tab.addEventListener('change', e => { if (e.target.id === 'cfg-import') importarJSON(e.target); });
}

function renderConfig() {
  const c = S.config;
  const propios = S.productos.filter(hasOwnMin).length;
  const count = cat => S.productos.filter(p => p.categoria === cat).length;
  $('#tab-config').innerHTML = `
    <div class="ph"><div><h2>Configuración</h2><p>Ajustes generales, categorías, stock mínimo, rotación y respaldo de datos.</p></div></div>
    <div class="cfg-grid">
      <section class="card"><h3>Datos de la bodega</h3><p class="desc">El nombre aparece en la cabecera y en los pedidos copiados.</p>
        <form id="cfg-gen" class="grid2">
          <label class="field"><span>Nombre</span><input name="nombre" maxlength="60" value="${esc(c.nombre)}"></label>
          <label class="field"><span>Símbolo de moneda</span><input name="moneda" maxlength="5" value="${esc(c.moneda)}"></label>
          <div class="span2"><button class="btn primary sm">Guardar</button></div>
        </form></section>

      <section class="card"><h3>Stock mínimo</h3><p class="desc">La cantidad se pinta en <b class="danger-t">rojo</b> cuando llega a este número o menos. Cada producto puede tener su propio mínimo (se pone al editarlo).</p>
        <form id="cfg-min" class="row-form">
          <label class="field"><span>Mínimo universal</span><input name="min" type="number" min="0" step="any" value="${c.stockMinGlobal}"></label>
          <button class="btn primary sm">Guardar</button>
        </form>
        <p class="desc" style="margin:12px 0 0">${propios ? `${propios} producto(s) usan un mínimo propio. <button type="button" class="btn sm ghost" data-act="reset-mins">Usar el universal en todos</button>` : 'Todos los productos usan el mínimo universal.'}</p>
      </section>

      <section class="card"><h3>Nivel de rotación</h3><p class="desc">Se calcula con las salidas y ventas de cada producto en los últimos días.</p>
        <form id="cfg-rot" class="grid3">
          <label class="field"><span>Días a mirar</span><input name="dias" type="number" min="1" step="1" value="${c.rotDias}"></label>
          <label class="field"><span>Rápida desde</span><input name="rapida" type="number" min="1" step="any" value="${c.rotRapida}"></label>
          <label class="field"><span>Normal desde</span><input name="normal" type="number" min="1" step="any" value="${c.rotNormal}"></label>
          <div class="span-all"><button class="btn primary sm">Guardar</button></div>
        </form>
        <ul class="rot-legend">
          <li>${rotBadge('rapida')} ${fmtNum(c.rotRapida)} o más unidades en ${c.rotDias} días</li>
          <li>${rotBadge('normal')} de ${fmtNum(c.rotNormal)} a menos de ${fmtNum(c.rotRapida)}</li>
          <li>${rotBadge('lenta')} menos de ${fmtNum(c.rotNormal)} (pero se movió)</li>
          <li>${rotBadge('sinmov')} ninguna salida en ${c.rotDias} días (stock parado)</li>
          <li>${rotBadge('nuevo')} registrado hace menos de 7 días y aún sin salidas</li>
        </ul></section>

      <section class="card"><h3>Categorías</h3><p class="desc">Son las opciones al registrar un producto. Toca un nombre para renombrarlo.</p>
        <div class="cat-list">${c.categorias.length ? c.categorias.map(cat => `<span class="cat-tag"><button type="button" class="ren" data-act="ren-cat" data-cat="${esc(cat)}">${esc(cat)}</button><small>${count(cat)}</small>
          <button type="button" class="icon-btn danger" data-act="del-cat" data-cat="${esc(cat)}" title="Eliminar">${I.x}</button></span>`).join('') : '<span class="muted">Sin categorías.</span>'}</div>
        <form id="cfg-cat" class="row-form"><input name="cat" maxlength="40" placeholder="Nueva categoría" aria-label="Nueva categoría"><button class="btn primary sm">Agregar</button></form>
      </section>

      <section class="card"><h3>Respaldo de datos</h3><p class="desc">Los datos se guardan <b>en la nube</b> y se ven igual en todos los equipos. Igual descarga un respaldo de vez en cuando, por seguridad.</p>
        <div class="btn-row">
          <button type="button" class="btn" data-act="export">Descargar respaldo (.json)</button>
          <label class="btn">Importar respaldo<input type="file" id="cfg-import" accept=".json,application/json" hidden></label>
          <button type="button" class="btn" data-act="csv">Exportar inventario a Excel (.csv)</button>
        </div></section>

      <section class="card"><h3>Datos de ejemplo y reinicio</h3><p class="desc">Carga productos de prueba para ver cómo funciona todo, o borra toda la información.</p>
        <div class="btn-row">
          <button type="button" class="btn" data-act="seed">Cargar datos de ejemplo</button>
          <button type="button" class="btn danger-ghost" data-act="reset">${I.trash} Borrar todo</button>
        </div></section>
    </div>`;
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportarJSON() {
  download(`bodega-respaldo-${today()}.json`, JSON.stringify(S, null, 1), 'application/json');
  toast('Respaldo descargado');
}
function exportarCSV() {
  const rot = rotMap();
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Código', 'Categoría', 'Nombre', 'Unidad', 'Cantidad', 'Stock mínimo', 'Precio compra', 'Precio venta', 'Margen %', 'Proveedor', 'Rotación', `Salidas ${S.config.rotDias} días`, 'Ubicación'];
  const rows = [...S.productos].sort((a, b) => cmp(a.codigo, b.codigo)).map(p => {
    const m = margen(p), r = rot.get(p.id);
    return [p.codigo, p.categoria, p.nombre, p.unidad, p.cantidad, minDe(p), p.precioCompra, p.precioVenta, m === null ? '' : m.toFixed(1), provName(p.proveedorId), ROT[r.key].label, r.sal, p.ubicacion].map(q).join(',');
  });
  download(`inventario-${today()}.csv`, '﻿' + [head.map(q).join(','), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
  toast('Inventario exportado');
}
function importarJSON(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.productos) || !data.config) throw new Error('formato');
      if (!(await confirmBox(`El respaldo tiene <b>${data.productos.length} productos</b>. Reemplazará <b>todos</b> los datos actuales en la nube, para todos los equipos.`, { ok: 'Importar', danger: true, title: 'Importar respaldo' }))) return;
      replaceAll(normalizeData(data));
      logH('Respaldo importado', `${S.productos.length} productos · archivo ${file.name}`);
      commit();
      toast('Respaldo importado');
    } catch { toast('El archivo no es un respaldo válido', 'error'); }
  };
  reader.readAsText(file);
}
async function borrarTodo() {
  const ok = await confirmBox('Se borrarán <b>todos</b> los productos, proveedores, pedidos, devoluciones y ventas <b>para todos los equipos</b>. Descarga un respaldo antes si lo necesitas.', { ok: 'Borrar todo', danger: true, title: 'Borrar todo' });
  if (!ok) return;
  const keep = { nombre: S.config.nombre, moneda: S.config.moneda };
  replaceAll(defaultData());
  Object.assign(S.config, keep);
  CART = []; saveCart();
  logH('Datos borrados', 'Se borró toda la información');
  commit();
  toast('Datos borrados');
}

/* ---------- Datos de ejemplo ---------- */
async function cargarEjemplo() {
  if (S.productos.length && !(await confirmBox('Los datos de ejemplo <b>reemplazarán</b> los datos actuales en la nube, para todos los equipos.', { ok: 'Cargar ejemplo', danger: true, title: 'Datos de ejemplo' }))) return;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const keep = { nombre: S.config.nombre, moneda: S.config.moneda };
  S = defaultData();
  Object.assign(S.config, keep);
  const now = Date.now(), DAY = 864e5;
  const iso = ms => new Date(ms).toISOString();
  const dateStr = off => { const d = new Date(now + off * DAY); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };

  const provs = [
    ['Distribuidora Andina SAC', 'Luis Ramos', '987 654 321', '20601234567', 'Visita los lunes. Crédito 15 días.'],
    ['Comercial Rímac EIRL', 'Jorge Quispe', '956 112 334', '20555667788', 'Entrega en 48 h.'],
    ['Bebidas del Sur SAC', 'Kevin Huamán', '944 210 908', '20498765432', 'Pedido mínimo S/ 300.'],
  ].map(([empresa, contacto, telefono, ruc, notas]) => ({ id: uid(), codigo: nextCode('prov', 'PRV'), empresa, contacto, telefono, ruc, email: '', direccion: '', notas, creado: iso(now - 90 * DAY) }));
  S.proveedores = provs;

  // nombre, categoría, unidad, compra, venta, proveedor, stock final, salidas 30 días, formato, mínimo propio, días desde registro
  const items = [
    ['Arroz extra 5 kg', 'Abarrotes', 'und', 18.5, 22.9, 0, 24, 32, null, null],
    ['Azúcar rubia 1 kg', 'Abarrotes', 'und', 3.4, 4.2, 0, 4, 26],
    ['Aceite vegetal 1 L', 'Abarrotes', 'und', 7.8, 9.5, 0, 12, 14],
    ['Fideos spaghetti 500 g', 'Abarrotes', 'und', 2.3, 3.0, 0, 30, 18],
    ['Atún en lata 170 g', 'Abarrotes', 'und', 4.1, 5.5, 0, 2, 9],
    ['Huevos', 'Abarrotes', 'docena', 6.5, 8.5, 0, 9, 16, { color: '#b45309' }],
    ['Leche evaporada 400 g', 'Lácteos', 'und', 3.3, 4.0, 1, 48, 40, { b: true }],
    ['Yogur bebible 1 L', 'Lácteos', 'und', 5.2, 6.8, 1, 6, 7, null, 8],
    ['Gaseosa 500 ml', 'Bebidas', 'und', 1.7, 2.5, 2, 60, 75, { b: true, u: true }],
    ['Agua sin gas 625 ml', 'Bebidas', 'und', 0.9, 1.5, 2, 36, 22],
    ['Gaseosa 3 L', 'Bebidas', 'und', 7.9, 10.5, 2, 0, 12, { color: '#c42b2b' }],
    ['Cerveza lata 355 ml', 'Bebidas', 'und', 3.2, 4.5, 2, 24, 3],
    ['Detergente 900 g', 'Limpieza', 'und', 8.4, 10.9, 1, 10, 4],
    ['Lejía 1 L', 'Limpieza', 'und', 2.1, 3.0, 1, 15, 0],
    ['Papel higiénico x4', 'Cuidado personal', 'paquete', 4.6, 6.2, 1, 20, 11],
    ['Jabón de tocador 90 g', 'Cuidado personal', 'und', 1.8, 2.8, 1, 8, 2, { i: true }],
    ['Galletas soda x6', 'Snacks', 'paquete', 3.1, 4.2, 0, 14, 21],
    ['Papas fritas 40 g', 'Snacks', 'und', 1.2, 2.0, 2, 3, 15],
    ['Chocolate 30 g', 'Snacks', 'und', 1.4, 2.5, 2, 24, 0, null, null, 2],
  ];
  const movs = [];
  items.forEach(([nombre, categoria, unidad, pc, pv, provIdx, final, sal30, fmt, ownMin, age = 75]) => {
    const p = {
      id: uid(), codigo: nextCode('prod', 'P'), nombre, categoria, unidad, precioCompra: pc, precioVenta: pv,
      proveedorId: provs[provIdx].id, cantidad: final, stockMin: ownMin ?? null, ubicacion: '', notas: '',
      fmt: Object.assign({ b: false, i: false, u: false, color: null }, fmt || {}), creado: iso(now - age * DAY),
    };
    S.productos.push(p);
    const pm = [];
    let left = sal30;
    while (left > 0) {
      const q = Math.min(left, 1 + Math.floor(rnd() * Math.max(1, sal30 / 5)));
      left -= q;
      pm.push({ tipo: 'venta', cantidad: q, signo: -1, t: now - (rnd() * 29 + 0.2) * DAY, nota: 'Venta' });
    }
    if (age > 40) pm.push({ tipo: 'salida', cantidad: Math.ceil(sal30 * 0.4) || 1, signo: -1, t: now - (35 + rnd() * 10) * DAY, nota: 'Venta' });
    const mid = sal30 > 10 ? Math.round(sal30 * 0.7) : 0;
    if (mid) pm.push({ tipo: 'entrada', cantidad: mid, signo: 1, t: now - 12 * DAY, nota: `Compra · ${provs[provIdx].empresa}` });
    const salidas = pm.filter(m => m.signo < 0).reduce((s, m) => s + m.cantidad, 0);
    pm.push({ tipo: 'entrada', cantidad: final + salidas - mid, signo: 1, t: now - age * DAY, nota: 'Stock inicial' });
    pm.sort((a, b) => a.t - b.t);
    // evita saldos negativos en el historial de ejemplo
    let run = 0, low = 0;
    pm.forEach(m => { run += m.signo * m.cantidad; low = Math.min(low, run); });
    if (low < 0) {
      pm[0].cantidad += -low;
      pm.push({ tipo: 'ajuste', cantidad: -low, signo: -1, t: now - 0.1 * DAY, nota: 'Ajuste por conteo' });
    }
    let saldo = 0;
    pm.forEach(m => { saldo += m.signo * m.cantidad; movs.push({ id: uid(), productoId: p.id, tipo: m.tipo, cantidad: m.cantidad, signo: m.signo, fecha: iso(m.t), nota: m.nota, ref: '', saldo }); });
  });
  S.movimientos = movs;
  const P = n => S.productos.find(p => p.nombre === n);
  const line = (n, q, precio) => ({ productoId: P(n).id, nombre: n, cantidad: q, precio: precio ?? P(n).precioCompra });
  S.pedidos = [
    { id: uid(), codigo: nextCode('ped', 'PED'), creado: iso(now - 14 * DAY), proveedorId: provs[0].id, proveedorNombre: provs[0].empresa, fechaPedido: dateStr(-14), fechaLlegada: dateStr(-12), estado: 'recibido', recibidoEn: dateStr(-12), notas: 'Factura F001-2231', items: [line('Arroz extra 5 kg', 22), line('Aceite vegetal 1 L', 10), line('Fideos spaghetti 500 g', 13)] },
    { id: uid(), codigo: nextCode('ped', 'PED'), creado: iso(now - DAY), proveedorId: provs[2].id, proveedorNombre: provs[2].empresa, fechaPedido: dateStr(-1), fechaLlegada: dateStr(2), estado: 'pendiente', notas: '', items: [line('Gaseosa 3 L', 12), line('Papas fritas 40 g', 24)] },
    { id: uid(), codigo: nextCode('ped', 'PED'), creado: iso(now - 2 * DAY), proveedorId: provs[1].id, proveedorNombre: provs[1].empresa, fechaPedido: dateStr(-2), fechaLlegada: dateStr(0), estado: 'camino', notas: 'Pago contra entrega', items: [line('Yogur bebible 1 L', 12), line('Leche evaporada 400 g', 48, 3.25)] },
  ];
  S.devoluciones = [
    { id: uid(), codigo: nextCode('dev', 'DEV'), creado: iso(now - DAY), fecha: dateStr(-1), productoId: P('Yogur bebible 1 L').id, productoNombre: 'Yogur bebible 1 L', cantidad: 3, motivo: 'Vencido', detalle: 'Vencieron el fin de semana', proveedorId: provs[1].id, proveedorNombre: provs[1].empresa, empresa: provs[1].empresa, contacto: 'Jorge Quispe', estado: 'pendiente', fechaRealizada: null, descontado: false, notas: '' },
    { id: uid(), codigo: nextCode('dev', 'DEV'), creado: iso(now - 6 * DAY), fecha: dateStr(-6), productoId: P('Gaseosa 500 ml').id, productoNombre: 'Gaseosa 500 ml', cantidad: 6, motivo: 'Dañado / roto', detalle: 'Botellas abolladas', proveedorId: provs[2].id, proveedorNombre: provs[2].empresa, empresa: 'Transportes Lima Norte', contacto: 'Kevin Huamán', estado: 'realizada', fechaRealizada: dateStr(-4), descontado: false, notas: '' },
  ];
  CART = []; saveCart();
  replaceAll(S);
  logH('Datos de ejemplo cargados', `${S.productos.length} productos de prueba`);
  commit();
  toast('Datos de ejemplo cargados');
}

/* =========================================================
   Arranque
   ========================================================= */
/* =========================================================
   6. HISTORIAL DE CAMBIOS (quién cambió qué y cuándo)
   ========================================================= */
const pendLog = [];   // entradas por enviar a la nube
function logH(accion, detalle = '') {
  pendLog.push({ usuario: USUARIO || 'Sin nombre', accion, detalle: String(detalle).slice(0, 900), fecha: new Date().toISOString() });
  scheduleSync();
}
function diffProducto(a, b) {
  const L = [];
  const f = (lbl, x, y, fm = v => (v === '' || v === null || v === undefined ? '—' : v)) => {
    if (String(x ?? '') !== String(y ?? '')) L.push(`${lbl}: ${fm(x)} → ${fm(y)}`);
  };
  f('Nombre', a.nombre, b.nombre);
  f('Categoría', a.categoria, b.categoria);
  f('Proveedor', provName(a.proveedorId), provName(b.proveedorId));
  f('Unidad', a.unidad, b.unidad);
  f('P. compra', r2(num(a.precioCompra)), r2(num(b.precioCompra)), moneyTxt);
  f('P. venta', r2(num(a.precioVenta)), r2(num(b.precioVenta)), moneyTxt);
  f('Stock mínimo', hasOwnMin(a) ? num(a.stockMin) : 'universal', hasOwnMin(b) ? num(b.stockMin) : 'universal');
  f('Stock', r3(num(a.cantidad)), r3(num(b.cantidad)));
  f('Ubicación', a.ubicacion, b.ubicacion);
  if (JSON.stringify(a.fmt || {}) !== JSON.stringify(b.fmt || {})) L.push('Formato del nombre');
  if ((a.notas || '') !== (b.notas || '')) L.push('Notas');
  return L.join(' · ');
}

const hist = { rows: [], q: '', user: '', loading: false, error: '' };
function buildHistorial() {
  $('#tab-historial').innerHTML = `
    <div class="ph"><div><h2>Historial de cambios</h2><p>Todo lo que se registra o modifica, con la persona y la hora.</p></div></div>
    <div class="toolbar">
      <label class="search">${I.search}<input id="his-q" type="search" placeholder="Buscar producto, acción, código…" autocomplete="off"></label>
      <select id="his-user" title="Persona"></select>
      <div class="spacer"></div>
      <button class="btn" id="his-reload" type="button">${I.undo} Actualizar</button>
    </div>
    <div class="meta" id="his-meta"></div>
    <div class="table-wrap" id="his-wrap"></div>`;
  $('#his-q').addEventListener('input', e => { hist.q = e.target.value; renderHistorial(); });
  $('#his-user').addEventListener('change', e => { hist.user = e.target.value; renderHistorial(); });
  $('#his-reload').addEventListener('click', () => loadHistorial());
}
async function loadHistorial() {
  if (!supa || hist.loading) return;
  hist.loading = true; hist.error = '';
  renderHistorial();
  const { data, error } = await supa.from('historial').select('id,fecha,usuario,accion,detalle').order('id', { ascending: false }).limit(500);
  hist.loading = false;
  if (error) hist.error = 'No se pudo cargar el historial: ' + error.message;
  else hist.rows = data || [];
  renderHistorial();
}
function renderHistorial() {
  const wrap = $('#his-wrap');
  if (!wrap) return;
  const users = [...new Set(hist.rows.map(r => r.usuario).filter(Boolean))].sort(cmp);
  fillSelect($('#his-user'), [['', 'Todas las personas'], ...users.map(u => [u, u])], hist.user);
  hist.user = $('#his-user').value;
  if (hist.error) { wrap.innerHTML = `<div class="empty"><h3>Error</h3><p>${esc(hist.error)}</p></div>`; return; }
  if (hist.loading && !hist.rows.length) { wrap.innerHTML = `<div class="empty"><p>Cargando…</p></div>`; return; }
  const q = norm(hist.q.trim());
  const list = hist.rows.filter(r => (!hist.user || r.usuario === hist.user) && (!q || norm(`${r.accion} ${r.detalle} ${r.usuario}`).includes(q)));
  $('#his-meta').textContent = hist.rows.length ? `Mostrando ${list.length} de los últimos ${hist.rows.length} cambios` : '';
  if (!hist.rows.length) { wrap.innerHTML = `<div class="empty"><h3>Sin cambios todavía</h3><p>Aquí aparecerá cada cambio que hagan en la página.</p></div>`; return; }
  if (!list.length) { wrap.innerHTML = `<div class="empty"><h3>Sin resultados</h3></div>`; return; }
  wrap.innerHTML = `<table class="tbl compact"><thead><tr><th>Fecha y hora</th><th>Quién</th><th>Acción</th><th>Detalle</th></tr></thead><tbody>
    ${list.map(r => `<tr><td style="white-space:nowrap">${fmtDT(r.fecha)}</td><td><b>${esc(r.usuario || '—')}</b></td><td><span class="chip">${esc(r.accion)}</span></td><td>${esc(r.detalle || '')}</td></tr>`).join('')}
  </tbody></table>`;
}

/* =========================================================
   SINCRONIZACIÓN CON LA NUBE
   Cada producto, pedido, etc. es una fila en la tabla "registros".
   Los cambios se envían solos y los de otros equipos llegan en vivo.
   ========================================================= */
const snap = new Map();       // "coleccion|id" -> cómo está en la nube (JSON)
const pendDelta = new Map();  // productoId -> suma/resta de stock por enviar
let forceFull = false;        // tras importar/borrar todo: enviar todo tal cual
let ready = false, syncing = false, syncAgain = false, syncTimer = null, retryTimer = null;
let chan = null;

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
function snapCant(id) {
  const js = snap.get('productos|' + id);
  if (!js) return null;
  try { return num(JSON.parse(js).cantidad); } catch { return 0; }
}
/** Forma en que se envía un registro. El stock de un producto se manda aparte, como suma/resta. */
function wire(col, rec) {
  if (col !== 'productos' || forceFull) return rec;
  const c = snapCant(rec.id);
  return { ...rec, cantidad: c === null ? r3(num(rec.cantidad) - (pendDelta.get(rec.id) || 0)) : c };
}
function localRecords() {
  const out = new Map();
  out.set('config|main', { col: 'config', id: 'main', data: { config: S.config, counters: S.counters } });
  for (const c of COLS) for (const r of S[c]) out.set(`${c}|${r.id}`, { col: c, id: r.id, data: r });
  return out;
}
function hasPending() {
  if (pendDelta.size || pendLog.length || forceFull) return true;
  const recs = localRecords();
  if ([...snap.keys()].some(k => !recs.has(k))) return true;
  for (const [k, r] of recs) if (snap.get(k) !== stable(wire(r.col, r.data))) return true;
  return false;
}
function replaceAll(nuevo) { S = nuevo; pendDelta.clear(); forceFull = true; }

function scheduleSync(ms = 300) {
  if (!ready) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, ms);
  setStatus('saving');
}
function isAuthError(e) { return e && (e.status === 401 || e.code === 'PGRST301' || /JWT|jwt|not authenticated/i.test(e.message || '')); }

async function sync() {
  if (!ready || !supa) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  clearTimeout(retryTimer);
  let stockChanged = false;
  try {
    const full = forceFull;
    const recs = localRecords();
    const ups = [];
    for (const [k, r] of recs) {
      const data = wire(r.col, r.data);
      const js = stable(data);
      if (snap.get(k) !== js) ups.push({ k, js, row: { coleccion: r.col, id: r.id, data: JSON.parse(JSON.stringify(data)), actualizado: new Date().toISOString() } });
    }
    for (let i = 0; i < ups.length; i += 300) {
      const part = ups.slice(i, i + 300);
      const { error } = await supa.from('registros').upsert(part.map(u => u.row), { onConflict: 'coleccion,id' });
      if (error) throw error;
      part.forEach(u => snap.set(u.k, u.js));
    }
    const dels = [...snap.keys()].filter(k => !localRecords().has(k));
    const byCol = {};
    dels.forEach(k => { const [c, ...rest] = k.split('|'); (byCol[c] = byCol[c] || []).push(rest.join('|')); });
    for (const [c, ids] of Object.entries(byCol)) {
      for (let i = 0; i < ids.length; i += 150) {
        const part = ids.slice(i, i + 150);
        const { error } = await supa.from('registros').delete().eq('coleccion', c).in('id', part);
        if (error) throw error;
        part.forEach(id => snap.delete(`${c}|${id}`));
      }
    }
    if (full) { forceFull = false; pendDelta.clear(); }
    for (const [pid, delta] of [...pendDelta]) {
      if (!delta || !snap.has('productos|' + pid)) { pendDelta.delete(pid); continue; }
      const { data, error } = await supa.rpc('mover_stock', { p_id: pid, delta });
      if (error) throw error;
      const rest = r3((pendDelta.get(pid) || 0) - delta);
      if (rest) pendDelta.set(pid, rest); else pendDelta.delete(pid);
      if (data !== null && data !== undefined) {
        const k = 'productos|' + pid;
        try { const o = JSON.parse(snap.get(k)); o.cantidad = num(data); snap.set(k, stable(o)); } catch { /* */ }
        const p = prodById(pid);
        const nueva = r3(num(data) + rest);
        if (p && num(p.cantidad) !== nueva) { p.cantidad = nueva; stockChanged = true; }
      }
    }
    if (pendLog.length) {
      const batch = pendLog.splice(0);
      const { error } = await supa.from('historial').insert(batch);
      if (error) { pendLog.unshift(...batch); throw error; }
      if (ui.tab === 'historial') loadHistorial();
    }
    setStatus('ok');
  } catch (e) {
    console.warn('Error al sincronizar', e);
    if (isAuthError(e)) { setStatus('error'); showLogin('Tu sesión venció. Vuelve a ingresar la clave.'); }
    else { setStatus('offline'); retryTimer = setTimeout(sync, 5000); }
  } finally {
    syncing = false;
    if (stockChanged) renderSoon();
    if (syncAgain) { syncAgain = false; sync(); }
  }
}

/** Llega un cambio hecho en otro equipo. */
function onRemote(payload) {
  const ev = payload.eventType;
  const row = ev === 'DELETE' ? payload.old : payload.new;
  if (!row || !row.coleccion || !row.id) return;
  const col = row.coleccion, id = row.id, k = `${col}|${id}`;
  if (col !== 'config' && !COLS.includes(col)) return;
  const arr = col === 'config' ? null : S[col];
  const local = col === 'config' ? { config: S.config, counters: S.counters } : arr.find(x => x.id === id);
  const dirty = forceFull || (local ? stable(wire(col, local)) : undefined) !== snap.get(k);
  if (ev === 'DELETE') {
    snap.delete(k);
    if (!dirty && arr) {
      const i = arr.findIndex(x => x.id === id);
      if (i >= 0) arr.splice(i, 1);
      if (col === 'productos') pendDelta.delete(id);
    }
  } else {
    const data = row.data || {};
    snap.set(k, stable(data));
    if (!dirty) {
      if (col === 'config') {
        const n = normalizeData({ config: data.config, counters: data.counters });
        for (const key of Object.keys(S.counters)) n.counters[key] = Math.max(num(n.counters[key]), num(S.counters[key]));
        S.config = n.config; S.counters = n.counters;
      } else {
        const fresh = JSON.parse(JSON.stringify(data));
        if (col === 'productos') fresh.cantidad = r3(num(fresh.cantidad) + (pendDelta.get(id) || 0));
        if (local) { Object.keys(local).forEach(key => delete local[key]); Object.assign(local, fresh); }
        else arr.push(fresh);
      }
    } else scheduleSync();
  }
  renderSoon();
}

let renderTimer = null;
function renderSoon() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => renderAll({ remote: true }), 120);
}

async function loadAll() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supa.from('registros').select('coleccion,id,data').order('coleccion').order('id').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  const d = defaultData();
  let cfg = null;
  snap.clear();
  for (const r of rows) {
    snap.set(`${r.coleccion}|${r.id}`, stable(r.data));
    if (r.coleccion === 'config') cfg = r.data;
    else if (COLS.includes(r.coleccion)) d[r.coleccion].push(r.data);
  }
  if (cfg) { d.config = cfg.config; d.counters = cfg.counters; }
  S = normalizeData(d);
  pendDelta.clear();
  return rows.length;
}

/** Vuelve a leer todo (al volver a la página o al recuperar la conexión). */
async function refresh() {
  if (!ready) return;
  if (syncing || hasPending()) { scheduleSync(50); setTimeout(refresh, 2500); return; }
  if (document.querySelector('dialog[open]')) return;
  try { await loadAll(); renderAll({ remote: true }); setStatus('ok'); }
  catch (e) { if (isAuthError(e)) showLogin('Tu sesión venció. Vuelve a ingresar la clave.'); else setStatus('offline'); }
}

function subscribe() {
  if (chan) supa.removeChannel(chan);
  let first = true;
  chan = supa.channel('bodega-registros')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'registros' }, onRemote)
    .subscribe(st => {
      if (st === 'SUBSCRIBED') { if (!first) refresh(); first = false; }
      else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') setStatus('offline');
    });
}

function setStatus(st) {
  const el = $('#sync');
  if (!el) return;
  if (st === 'saving' && !hasPending()) st = 'ok';
  const txt = { ok: 'Sincronizado', saving: 'Guardando…', offline: 'Sin conexión · reintentando', error: 'Sin sesión' }[st] || '';
  el.className = 'sync ' + st;
  el.querySelector('span').textContent = txt;
  el.title = st === 'ok' ? 'Todo está guardado en la nube' : txt;
}

/* ---------- Pantalla de ingreso ---------- */
function showLogin(msg = '') {
  ready = false;
  $('#app-loading').hidden = true;
  const box = $('#login');
  box.hidden = false;
  const f = $('#login-form');
  f.elements.nombre.value = USUARIO || '';
  f.elements.email.value = lsGet(EMAIL_KEY) || '';
  $('#login-err').textContent = msg;
  setTimeout(() => (f.elements.nombre.value ? (f.elements.email.value ? f.elements.clave : f.elements.email) : f.elements.nombre).focus(), 50);
}
async function doLogin(e) {
  e.preventDefault();
  const f = e.target, E = f.elements, btn = $('button', f);
  const nombre = E.nombre.value.trim(), email = E.email.value.trim(), clave = E.clave.value;
  if (!nombre) return;
  btn.disabled = true; btn.textContent = 'Entrando…';
  $('#login-err').textContent = '';
  const { error } = await supa.auth.signInWithPassword({ email, password: clave });
  btn.disabled = false; btn.textContent = 'Entrar';
  if (error) {
    $('#login-err').textContent = /invalid/i.test(error.message) ? 'Correo o clave incorrectos.' : 'No se pudo entrar: ' + error.message;
    E.clave.select();
    return;
  }
  E.clave.value = '';
  USUARIO = nombre; lsSet(USER_KEY, nombre); lsSet(EMAIL_KEY, email);
  $('#login').hidden = true;
  enterApp();
}
async function logout() {
  if (hasPending() && !(await confirmBox('Hay cambios que aún no se guardaron en la nube. Si sales ahora se pierden.', { ok: 'Salir igual', danger: true, title: 'Cerrar sesión' }))) return;
  if (chan) { supa.removeChannel(chan); chan = null; }
  await supa.auth.signOut();
  S = defaultData(); snap.clear(); pendDelta.clear(); pendLog.length = 0;
  renderAll();
  showLogin();
}
function editUser() {
  const d = modal({
    title: 'Tu usuario', size: 'sm',
    body: `<form id="f-user"><label class="field"><span>Tu nombre (aparece en el historial)</span><input name="n" required maxlength="40" value="${esc(USUARIO)}"></label></form>`,
    foot: `<button class="btn danger-ghost" type="button" data-out>Cerrar sesión</button><span class="spacer"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" type="submit" form="f-user">Guardar</button>`,
  });
  $('form', d).addEventListener('submit', e => {
    e.preventDefault();
    const v = $('[name=n]', d).value.trim();
    if (v) { USUARIO = v; lsSet(USER_KEY, v); renderWho(); toast('Nombre actualizado'); }
    d.close();
  });
  $('[data-out]', d).addEventListener('click', () => { d.close(); logout(); });
}
function renderWho() { const b = $('#who-name'); if (b) b.textContent = USUARIO || 'Sin nombre'; }

async function enterApp() {
  $('#app-loading').hidden = false;
  try {
    await loadAll();
  } catch (e) {
    console.warn(e);
    if (isAuthError(e)) return showLogin('Tu sesión venció. Vuelve a ingresar la clave.');
    $('#app-loading').innerHTML = `<div class="login-card"><h2>No se pudo conectar</h2><p class="muted">Revisa tu internet y vuelve a intentar.</p><button class="btn primary block" onclick="location.reload()">Reintentar</button></div>`;
    return;
  }
  ready = true;
  $('#app-loading').hidden = true;
  renderWho();
  renderAll();
  setTab(location.hash.slice(1) || 'inventario');
  subscribe();
  setStatus('ok');
  if (!snap.has('config|main')) scheduleSync(50);   // primera vez: guarda la configuración
  migrarDatosLocales();
}

/** Si este navegador tiene datos de la versión anterior (sin nube), ofrece subirlos. */
async function migrarDatosLocales() {
  let legacy = null;
  try { legacy = JSON.parse(lsGet(LEGACY_KEY) || 'null'); } catch { legacy = null; }
  if (!legacy || !Array.isArray(legacy.productos) || !legacy.productos.length) return;
  if (S.productos.length) {
    toast('Este navegador tenía datos de la versión anterior. Si los necesitas, usa Configuración → Importar respaldo.');
    return;
  }
  const ok = await confirmBox(`Este navegador tiene <b>${legacy.productos.length} productos</b> guardados de la versión anterior. ¿Subirlos a la nube para que todos los vean?`, { ok: 'Subir a la nube', title: 'Datos encontrados' });
  if (!ok) return;
  replaceAll(normalizeData(legacy));
  logH('Datos migrados', `${S.productos.length} productos subidos desde un navegador`);
  commit();
  lsSet(LEGACY_KEY + '.migrado', lsGet(LEGACY_KEY) || '');
  lsDel(LEGACY_KEY);
  toast('Datos subidos a la nube');
}

/* =========================================================
   Arranque
   ========================================================= */
function renderAll(opts = {}) {
  $('#brandName').textContent = S.config.nombre;
  document.title = `${S.config.nombre} · Inventario`;
  renderInventario();
  renderDevoluciones();
  renderProveedores();
  renderPOS();
  // si llega un cambio de otro equipo mientras escribes en Configuración, no borrar lo que escribes
  if (!(opts.remote && $('#tab-config').contains(document.activeElement))) renderConfig();
  openDetails.forEach(d => {
    if (opts.remote && d.contains(document.activeElement) && document.activeElement.matches('input,select,textarea')) return;
    d._paint && d._paint();
  });
}

async function init() {
  buildInventario();
  buildDevoluciones();
  buildProveedores();
  buildVentas();
  buildHistorial();
  buildConfig();
  $$('.tab').forEach(b => b.addEventListener('click', () => {
    setTab(b.dataset.tab); window.scrollTo({ top: 0 });
    if (b.dataset.tab === 'historial') loadHistorial();
  }));
  window.addEventListener('hashchange', () => setTab(location.hash.slice(1)));
  window.addEventListener('storage', e => {
    if (e.key === CART_KEY) { try { CART = JSON.parse(e.newValue || '[]'); } catch { CART = []; } renderPOS(); }
  });
  window.addEventListener('beforeunload', e => { if (ready && hasPending()) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  window.addEventListener('online', () => { scheduleSync(50); refresh(); });
  $('#login-form').addEventListener('submit', doLogin);
  $('#who').addEventListener('click', editUser);
  renderAll();
  if (!supa) {
    $('#app-loading').innerHTML = `<div class="login-card"><h2>No se pudo cargar</h2><p class="muted">Falta el archivo supabase.js. Revisa que esté subido junto a la página.</p></div>`;
    return;
  }
  const { data } = await supa.auth.getSession();
  if (data?.session) {
    await enterApp();
    if (!USUARIO) editUser();
  } else showLogin();
  if (location.hash.slice(1) === 'historial') loadHistorial();
}
init();
