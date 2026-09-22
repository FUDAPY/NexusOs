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


export const resourceRouter: Router = Router();


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



resourceRouter.use(
  '/products',
  crearRecurso({
    coleccion: 'products',
    modelo: Product,
    filtros: ['sucursal', 'estado', 'visibilidad', 'categoria', 'controlado'],
    ordenables: ['nombre', 'precio', 'stock'],
    campoBusqueda: 'nombre',
    ordenPorDefecto: 'nombre',
    /* Habilitar el CRUD completo: crear, modificar (POST/PATCH) y eliminar
       (DELETE /products/:id). Sin `borrable` el DELETE ni existia: 404. */
    borrable: true,
    rolesBorrado: ['admin', 'supervisor'],
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

    borrable: true,
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
    
    borrable: true,
  }),
);



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



resourceRouter.use(
  '/lin-tickets',
  crearRecurso({
    coleccion: 'lin_tickets',
    modelo: LinTicket,
    filtros: ['active', 'type', 'branchId'],
    ordenables: ['name'],
    campoBusqueda: 'name',
    ordenPorDefecto: 'name',

    /* La pantalla de LIN Tickets permite eliminar un ticket. */
    borrable: true,
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

/* El PIN nunca sale en una respuesta, por eso se excluye. */
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

    // historial contable.
    borrable: true,
  }),
);


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
