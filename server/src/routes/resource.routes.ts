import { Router } from 'express';
import {
  Branch,
  CashClose,
  CashShift,
  Category,
  CreditPin,
  CreditPinAttempt,
  Currency,
  InventoryMovement,
  LinTicket,
  LinTicketClaim,
  Notification,
  Product,
  ProductionBatch,
  ProductionConfig,
  PublicGoal,
  Setting,
  SupportAlert,
  SyncLog,
  User,
} from '../models/index.js';
import { crearRecurso } from '../utils/resource.factory.js';

/**
 * Rutas CRUD de las colecciones.
 *
 * Se montan bajo `${API_PREFIX}` (ver app.ts) y usan los MISMOS query params
 * en todas, para que nexus-data.js traduzca query(where(), orderBy(), limit())
 * sin casos especiales:
 *
 *   ?<campo>=valor  &q=texto  &desde=ISO  &hasta=ISO
 *   &limit=50       &offset=0 &sort=campo &order=asc|desc
 *
 * Los nombres de campo de `filtros` y `ordenables` salen del reporte real de
 * docs/paridad.json (auditoria de la base), no de suposiciones.
 */
export const resourceRouter: Router = Router();

/**
 * Lectura PUBLICA y sin token, montada aparte en app.ts.
 *
 * Existe por metas-publicas.html, que muestra las metas sin pedir login. Al ser
 * `soloLectura: true` no expone POST ni PATCH, asi que una peticion de escritura
 * cae al resourceRouter protegido (Express sigue si el router no matchea) y ahi
 * si exige token.
 */
export const publicResourceRouter: Router = Router();

publicResourceRouter.use(
  '/public-goals',
  crearRecurso({
    coleccion: 'public_goals',
    modelo: PublicGoal,
    filtros: ['sucursal', 'sucursalKey', 'month'],
    ordenables: ['month', 'sucursalKey'],
    ordenPorDefecto: 'month',
    soloLectura: true,
  }),
);

/* ---------------- Catalogo ---------------- */

resourceRouter.use(
  '/products',
  crearRecurso({
    coleccion: 'products',
    modelo: Product,
    filtros: ['sucursal', 'estado', 'visibilidad', 'categoria', 'controlado'],
    ordenables: ['nombre', 'precio', 'stock'],
    campoBusqueda: 'nombre',
    ordenPorDefecto: 'nombre',
  }),
);

resourceRouter.use(
  '/branches',
  crearRecurso({
    coleccion: 'branches',
    modelo: Branch,
    filtros: ['estado'],
    ordenables: ['nombre'],
    campoBusqueda: 'nombre',
    ordenPorDefecto: 'nombre',
  }),
);

resourceRouter.use(
  '/categories',
  crearRecurso({
    coleccion: 'categories',
    modelo: Category,
    filtros: ['estado', 'sucursal'],
    ordenables: ['nombre', 'orden'],
    campoBusqueda: 'nombre',
    ordenPorDefecto: 'orden',
  }),
);

resourceRouter.use(
  '/currencies',
  crearRecurso({
    coleccion: 'currencies',
    modelo: Currency,
    filtros: ['codigo', 'activa'],
    ordenables: ['codigo'],
    ordenPorDefecto: 'codigo',
    soloLectura: true,
  }),
);

/**
 * Usuarios: el CRUD generico devolveria `passwordHash` y permitiria
 * sobrescribirlo. Por eso se excluye de la respuesta y se bloquea del cuerpo.
 * `puntos`, `deuda` y `saldo` tampoco son escribibles desde el cliente: los
 * mueve la logica de venta, no un PATCH suelto.
 *
 * Los filtros salen del uso real del dashboard: pide el conteo de
 * clientes con `rol: 'cliente'` + `estadoBeneficios: 'pendiente'`. Antes
 * declaraba `estado`, que NO existe en el modelo, y le faltaba
 * `estadoBeneficios`, asi que ese conteo era imposible de reproducir por API.
 */
resourceRouter.use(
  '/users',
  crearRecurso({
    coleccion: 'users',
    modelo: User,
    filtros: ['rol', 'sucursal', 'estadoBeneficios', 'tipoCliente', 'email', 'rfid'],
    ordenables: ['nombre', 'rol'],
    campoBusqueda: 'nombre',
    ordenPorDefecto: 'nombre',
    excluir: ['passwordHash', 'password', 'pin', 'tokenFcm', 'resetToken'],
    noEscribible: ['passwordHash', 'password', 'pin', 'puntos', 'deuda', 'saldo', 'legacyId'],
  }),
);

/* ---------------- Caja ---------------- */

resourceRouter.use(
  '/cash-shifts',
  crearRecurso({
    coleccion: 'cash_shifts',
    modelo: CashShift,
    filtros: ['sucursal', 'estadoTurno'],
    ordenables: ['fechaApertura'],
    campoFecha: 'fechaApertura',
    ordenPorDefecto: 'fechaApertura',
  }),
);

resourceRouter.use(
  '/cash-closes',
  crearRecurso({
    coleccion: 'cash_closes',
    modelo: CashClose,
    filtros: ['sucursal', 'turnoId', 'fechaCierreKey'],
    ordenables: ['fechaCierre'],
    campoFecha: 'fechaCierre',
    ordenPorDefecto: 'fechaCierre',
  }),
);

/* ---------------- Inventario y produccion ---------------- */

resourceRouter.use(
  '/inventory-movements',
  crearRecurso({
    coleccion: 'inventory_movements',
    modelo: InventoryMovement,
    filtros: ['productoId', 'sucursal', 'tipo', 'ventaId', 'turnoId'],
    ordenables: ['fecha'],
    campoFecha: 'fecha',
    ordenPorDefecto: 'fecha',
  }),
);

resourceRouter.use(
  '/production-batches',
  crearRecurso({
    coleccion: 'production_batches',
    modelo: ProductionBatch,
    filtros: ['sucursal', 'sucursalKey', 'tipoInsumo'],
    ordenables: ['createdAt'],
    campoFecha: 'createdAt',
    ordenPorDefecto: 'createdAt',
  }),
);

resourceRouter.use(
  '/production-config',
  crearRecurso({
    coleccion: 'production_config',
    modelo: ProductionConfig,
    filtros: ['sucursalKey', 'sucursal'],
    ordenables: ['sucursalKey'],
    ordenPorDefecto: 'sucursalKey',
  }),
);

/* ---------------- CRM y programas ---------------- */

resourceRouter.use(
  '/lin-tickets',
  crearRecurso({
    coleccion: 'lin_tickets',
    modelo: LinTicket,
    filtros: ['active', 'type', 'branchId'],
    ordenables: ['name'],
    campoBusqueda: 'name',
    ordenPorDefecto: 'name',
  }),
);

resourceRouter.use(
  '/lin-ticket-claims',
  crearRecurso({
    coleccion: 'lin_ticket_claims',
    modelo: LinTicketClaim,
    filtros: ['userId', 'ticketId', 'status', 'branchId'],
    ordenables: ['claimedAt'],
    campoFecha: 'claimedAt',
    ordenPorDefecto: 'claimedAt',
  }),
);

/** El PIN nunca sale en una respuesta, por eso se excluye. */
resourceRouter.use(
  '/credit-pins',
  crearRecurso({
    coleccion: 'credit_pins',
    modelo: CreditPin,
    filtros: ['clienteId', 'activo'],
    ordenables: ['clienteId'],
    ordenPorDefecto: 'clienteId',
    excluir: ['pin'],
  }),
);

resourceRouter.use(
  '/credit-pin-attempts',
  crearRecurso({
    coleccion: 'credit_pin_attempts',
    modelo: CreditPinAttempt,
    filtros: ['clienteId', 'userId', 'exitoso'],
    ordenables: ['fecha'],
    campoFecha: 'fecha',
    ordenPorDefecto: 'fecha',
    soloLectura: true,
  }),
);

resourceRouter.use(
  '/public-goals',
  crearRecurso({
    coleccion: 'public_goals',
    modelo: PublicGoal,
    filtros: ['sucursal', 'sucursalKey', 'month'],
    ordenables: ['month', 'sucursalKey'],
    ordenPorDefecto: 'month',
  }),
);

/* ---------------- Operacion y soporte ---------------- */

resourceRouter.use(
  '/support-alerts',
  crearRecurso({
    coleccion: 'support_alerts',
    modelo: SupportAlert,
    filtros: ['estado', 'nivel', 'origen', 'sucursal', 'tipo'],
    ordenables: ['creadoAt'],
    campoFecha: 'creadoAt',
    ordenPorDefecto: 'creadoAt',
  }),
);

/** 12 710 documentos: el tope evita que una pagina pida todo de una. */
resourceRouter.use(
  '/sync-logs',
  crearRecurso({
    coleccion: 'sync_logs',
    modelo: SyncLog,
    filtros: ['coleccion', 'tipo', 'sucursal'],
    ordenables: ['timestamp'],
    campoFecha: 'timestamp',
    ordenPorDefecto: 'timestamp',
    limiteMaximo: 1000,
  }),
);

resourceRouter.use(
  '/notifications',
  crearRecurso({
    coleccion: 'notifications',
    modelo: Notification,
    filtros: ['autor', 'rolAutor'],
    ordenables: ['fecha'],
    campoFecha: 'fecha',
    ordenPorDefecto: 'fecha',
  }),
);

/** Configuracion global: solo lectura desde el cliente. */
resourceRouter.use(
  '/settings',
  crearRecurso({
    coleccion: 'settings',
    modelo: Setting,
    filtros: ['legacyId'],
    ordenables: ['legacyId'],
    ordenPorDefecto: 'legacyId',
    soloLectura: true,
  }),
);
