# Bodega · Inventario

Página web para llevar el inventario de una bodega. Funciona solo con HTML, CSS y JavaScript: no necesita servidor, base de datos ni instalar nada.

## Qué tiene

| Pestaña | Para qué sirve |
|---|---|
| **Inventario** | Lista de productos con buscador, filtros (categoría, proveedor, stock, rotación) y orden por columna. Código automático (`P-0001`), nombre con negrita / cursiva / mayúsculas / color, cantidad en **rojo** cuando llega al mínimo, precio de compra y venta, margen, proveedor y nivel de rotación. Clic en un producto → detalle con última entrada, última salida, historial, entradas/salidas y edición. |
| **Devoluciones** | Productos que se devuelven al proveedor: cantidad, motivo, proveedor, empresa y nombre de quien recoge. Se marcan como *pendiente* / *realizada* y pueden descontarse del stock. |
| **Proveedores y pedidos** | Ficha de cada proveedor y pedidos con productos del inventario, cantidades, precio por producto (si cambió, actualiza el precio de compra), total y fecha de llegada. Al marcar *Recibido* suma el stock. Botón para copiar el pedido y mandarlo por WhatsApp. |
| **Precios y carrito** | Para los ayudantes: lista de productos con precio de venta, buscador y botón **+** que arma un carrito con el total. Opcional: registrar la venta para descontar stock. |
| **Configuración** | Nombre y moneda, stock mínimo universal, días y umbrales de rotación, categorías, respaldo (exportar / importar), exportar a Excel (CSV) y datos de ejemplo. |

### Nivel de rotación
Según las salidas y ventas de los últimos 30 días (configurable):
**Rápida** (20 o más), **Normal** (5 a 19), **Lenta** (1 a 4), **Sin movimiento** (0) y **Nuevo** (registrado hace menos de 7 días, sin salidas).

## Subirla a GitHub Pages

1. En GitHub, crea un repositorio nuevo (por ejemplo `bodega-inventario`), público.
2. Botón **Add file → Upload files** y arrastra los 4 archivos: `index.html`, `styles.css`, `app.js`, `README.md`. Luego **Commit changes**.
3. Ve a **Settings → Pages**. En *Source* elige **Deploy from a branch**, rama `main`, carpeta `/ (root)` y **Save**.
4. En 1–2 minutos la página estará en `https://TU-USUARIO.github.io/bodega-inventario/`.

Para probarla en tu computadora sin subirla, abre `index.html` con doble clic.

## Importante: dónde se guardan los datos

Los datos se guardan en el **navegador** (localStorage) de cada equipo. Eso significa:

- Cada computadora o celular tiene sus propios datos. Lo que registras en la PC no aparece solo en el celular del ayudante.
- Si se borran los datos del navegador, se pierde la información. Usa **Configuración → Descargar respaldo** seguido.
- Para pasar los datos a otro equipo: descarga el respaldo en uno e **Importar respaldo** en el otro.

Si necesitas que varias personas vean y editen los mismos datos al mismo tiempo, el siguiente paso es conectar la página a una base de datos en línea (por ejemplo Supabase) con inicio de sesión.

## Archivos

```
index.html   estructura de la página y pestañas
styles.css   diseño (modo claro y oscuro, adaptado a celular)
app.js       toda la lógica y el guardado de datos
```
