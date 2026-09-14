import { Router } from 'express';
import { Branch, CashShift, Category, Currency, Product } from '../models/index.js';
import { crearRecurso } from '../utils/resource.factory.js';

/**
 * Rutas de solo lectura para las colecciones de catalogo.
 *
 * Se montan bajo `${API_PREFIX}` (ver app.ts) y exponen la MISMA forma de
 * query params en todas, para que nexus-data.js traduzca
 * query(where(), orderBy(), limit()) sin casos especiales.
 *
 * PENDIENTE FASE 2: los nombres de campo de `filtros` y `ordenables` hay que
 * confirmarlos contra el esquema real de cada modelo antes de darlos por
 * buenos. Un filtro con un campo que no existe devuelve lista vacia en
 * silencio, sin error.
 */
export const resourceRouter: Router = Router();

// --- Productos: la coleccion que mas consume el POS ---
resourceRouter.use(
  '/products',
  crearRecurso({
    coleccion: 'products',
    modelo: Product,
    filtros: ['sucursal', 'estado', 'visibilidad', 'categoria'],
    ordenables: ['nombre', 'precio', 'stock'],
    campoBusqueda: 'nombre',
    ordenPorDefecto: 'nombre',
  }),
);

// --- Sucursales ---
resourceRouter.use(
  '/branches',
  crearRecurso({
    coleccion: 'branches',
    modelo: Branch,
    filtros: ['estado', 'sucursal'],
    ordenables: ['nombre'],
    campoBusqueda: 'nombre',
    ordenPorDefecto: 'nombre',
  }),
);

// --- Categorias del menu ---
resourceRouter.use(
  '/categories',
  crearRecurso({
    coleccion: 'categories',
    modelo: Category,
    filtros: ['estado', 'sucursal'],
    ordenables: ['nombre', 'orden'],
    campoBusqueda: 'nombre',
    ordenPorDefecto: 'nombre',
  }),
);

// --- Monedas y tasas de cambio ---
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

// --- Turnos de caja ---
resourceRouter.use(
  '/cash-shifts',
  crearRecurso({
    coleccion: 'cash_shifts',
    modelo: CashShift,
    filtros: ['sucursal', 'estadoTurno', 'cajeroId'],
    ordenables: ['fechaApertura'],
    campoFecha: 'fechaApertura',
    ordenPorDefecto: 'fechaApertura',
  }),
);

/*
 * NO SE EXPONE TODAVIA
 * --------------------
 * /users  -> el CRUD generico devolveria `passwordHash` en el GET y permitiria
 *            sobrescribirlo en el PATCH. Antes de publicarlo hay que agregar
 *            una opcion de proyeccion (que campos se devuelven y que campos se
 *            pueden escribir) a resource.factory.ts.
 *
 * Colecciones que todavia no tienen modelo Mongoose (Fase 2):
 *   cash_closes, inventory_movements, production_batches, production_config,
 *   lin_tickets, lin_ticket_claims, credit_pins, public_goals, support_alerts,
 *   sync_logs, notifications, delivery_ratings, analytics
 */
