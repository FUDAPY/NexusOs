/* ===================================================================
   Filtro de sucursal compartido por los modulos del panel.

   Regla: "Todas las sucursales" por defecto, y la seleccion se recuerda
   entre modulos (localStorage). POS, Caja y KDS NO lo usan: esos estan
   atados a la sucursal del turno.

   Uso en un modulo (3 pasos):
     1) <script src="sucursal_filtro.js"></script>   (antes del script del modulo)
     2) await SucursalFiltro.montar({ destino: 'id-del-div-en-el-header', alCambiar: () => MiModulo.renderizar() });
     3) en el render de la lista:  if (!SucursalFiltro.aplica(item)) return;

   `aplica(item)` mira `sucursal` / `sucursalNombre` / `branchName` del item.
   Un item sin sucursal, o con sucursal "Unificado", se considera global y
   se muestra siempre.
   =================================================================== */
window.SucursalFiltro = (function () {
    const CLAVE = '__nexus_sucursal_filtro';
    const TODOS = 'todos';

    let sucursales = [];
    let cargadas = false;
    const oyentes = [];

    const normalizar = (valor) => String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .toLowerCase();

    const clave = (valor) => normalizar(valor).replace(/\s+/g, '_');

    const leerSucursalDe = (item) => {
        const fuente = item || {};
        return String(
            fuente.sucursal
            || fuente.sucursalNombre
            || fuente.branchName
            || fuente.branch
            || ''
        ).trim();
    };

    const valorActual = () => {
        try {
            return localStorage.getItem(CLAVE) || TODOS;
        } catch (error) {
            console.error('[sucursal-filtro] no se pudo leer la seleccion', error);
            return TODOS;
        }
    };

    const actual = () => {
        const valor = valorActual();
        if (valor === TODOS) return { clave: TODOS, nombre: 'Todas las sucursales' };
        const encontrada = sucursales.find((s) => s.clave === valor);
        return { clave: valor, nombre: encontrada ? encontrada.nombre : valor };
    };

    /* true = el item se muestra con la sucursal elegida. */
    const aplica = (item) => {
        const valor = valorActual();
        if (valor === TODOS) return true;

        const nombreSucursal = leerSucursalDe(item);
        if (nombreSucursal === '') return true;

        const normalizado = normalizar(nombreSucursal);
        if (normalizado === 'unificado' || normalizado === 'todas las sucursales') return true;

        return clave(nombreSucursal) === valor;
    };

    const cargar = async () => {
        if (cargadas) return sucursales;
        if (!window.NexusAPI) return sucursales;

        try {
            const resp = await NexusAPI.get('/branches', { limit: 200 }, { ttl: 0, retries: 0 });
            const filas = (resp && resp.data && resp.data.items) || [];
            const vistas = new Map();

            filas.forEach((branch) => {
                const nombre = String(branch.nombre || branch.name || branch.branchName || '').trim()
                    || String(branch._id || branch.id || '');
                const k = clave(nombre);
                if (k !== '' && !vistas.has(k)) vistas.set(k, { clave: k, nombre });
            });

            sucursales = [...vistas.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
            cargadas = true;
        } catch (error) {
            console.error('[sucursal-filtro] no se pudieron leer las sucursales', error);
        }

        return sucursales;
    };

    const pintar = (select) => {
        const valor = valorActual();
        select.innerHTML = `<option value="${TODOS}">Todas las sucursales</option>`
            + sucursales.map((s) => `<option value="${s.clave}">${s.nombre}</option>`).join('');
        select.value = sucursales.some((s) => s.clave === valor) ? valor : TODOS;
    };

    const avisar = (opciones) => {
        oyentes.forEach((fn) => {
            try {
                fn(actual());
            } catch (error) {
                console.error('[sucursal-filtro] error en un oyente', error);
            }
        });
        if (opciones && typeof opciones.alCambiar === 'function') opciones.alCambiar(actual());
    };

    const montar = async (opciones) => {
        const opts = opciones || {};
        const select = document.createElement('select');
        select.id = opts.id || 'filtro-sucursal-compartido';
        select.className = opts.clase
            || 'border border-slate-300 rounded-lg text-sm px-3 py-2 outline-none focus:border-orange-500 transition bg-white';
        select.title = 'Filtrar por sucursal';

        await cargar();
        pintar(select);

        select.addEventListener('change', () => {
            try {
                localStorage.setItem(CLAVE, select.value);
            } catch (error) {
                console.error('[sucursal-filtro] no se pudo guardar la seleccion', error);
            }
            avisar(opciones);
        });

        const destino = typeof opts.destino === 'string' ? document.getElementById(opts.destino) : opts.destino;
        const contenedor = destino || document.querySelector('header') || document.body;
        contenedor.appendChild(select);

        if (typeof opts.alCambiar === 'function' && oyentes.indexOf(opts.alCambiar) === -1) {
            oyentes.push(opts.alCambiar);
        }

        return select;
    };

    const alCambiar = (fn) => {
        if (typeof fn === 'function' && oyentes.indexOf(fn) === -1) oyentes.push(fn);
    };

    return {
        montar,
        aplica,
        actual,
        alCambiar,
        cargar,
        valorActual,
        clave,
        normalizar,
        sucursales: () => sucursales,
    };
})();
