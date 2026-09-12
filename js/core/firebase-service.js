/**
 * SERVICIO FIREBASE
 * Centraliza todas las operaciones con Firestore
 */

const FirebaseService = {
    // Usuarios
    obtenerUsuarioActual: async function() {
        return new Promise((resolve) => {
            const unsubscribe = db.collection('usuarios').doc(auth.currentUser.uid)
                .onSnapshot(
                    (doc) => {
                        unsubscribe();
                        resolve(doc.exists ? doc.data() : null);
                    },
                    (error) => {
                        console.error('Error getting user:', error);
                        resolve(null);
                    }
                );
        });
    },

    // Productos con listener
    escucharProductos: function(callback) {
        return db.collection('productos').onSnapshot(
            (snapshot) => {
                const productos = [];
                snapshot.forEach(doc => {
                    productos.push({ id: doc.id, ...doc.data() });
                });
                callback(productos);
            },
            (error) => {
                console.error('Error escuchando productos:', error);
                callback([]);
            }
        );
    },

    // Obtener producto por ID
    obtenerProducto: async function(productoId) {
        try {
            const doc = await db.collection('productos').doc(productoId).get();
            return doc.exists ? { id: doc.id, ...doc.data() } : null;
        } catch (e) {
            console.error('Error obtener producto:', e);
            return null;
        }
    },

    // Crear/actualizar producto
    guardarProducto: async function(productoId, datos) {
        try {
            if (productoId) {
                await db.collection('productos').doc(productoId).update(datos);
            } else {
                const docRef = await db.collection('productos').add(datos);
                return docRef.id;
            }
            return productoId || true;
        } catch (e) {
            console.error('Error guardar producto:', e);
            throw e;
        }
    },

    // Agregar imagen a producto
    agregarImagenProducto: async function(productoId, urlImagen) {
        try {
            await db.collection('productos').doc(productoId).update({
                'imagen': urlImagen
            });
            return true;
        } catch (e) {
            console.error('Error agregar imagen:', e);
            return false;
        }
    },

    // Clientes
    escucharClientes: function(callback) {
        return db.collection('clientes').onSnapshot(
            (snapshot) => {
                const clientes = [];
                snapshot.forEach(doc => {
                    clientes.push({ id: doc.id, ...doc.data() });
                });
                callback(clientes);
            },
            (error) => {
                console.error('Error escuchando clientes:', error);
                callback([]);
            }
        );
    },

    obtenerCliente: async function(clienteId) {
        try {
            const doc = await db.collection('clientes').doc(clienteId).get();
            return doc.exists ? { id: doc.id, ...doc.data() } : null;
        } catch (e) {
            console.error('Error obtener cliente:', e);
            return null;
        }
    },

    guardarCliente: async function(clienteId, datos) {
        try {
            if (clienteId) {
                await db.collection('clientes').doc(clienteId).update(datos);
                return clienteId;
            } else {
                const docRef = await db.collection('clientes').add(datos);
                return docRef.id;
            }
        } catch (e) {
            console.error('Error guardar cliente:', e);
            throw e;
        }
    },

    // Actualizar crédito de cliente
    actualizarCreditoCliente: async function(clienteId, deudaNueva) {
        try {
            const cliente = await this.obtenerCliente(clienteId);
            if (!cliente) return false;

            const limiteMaximo = ConfigService.obtenerLimiteCreditoCliente();
            if (deudaNueva > limiteMaximo) {
                Utils.mostrarToast(`Deuda supera límite de ${Utils.formatoMoneda(limiteMaximo)}`, 'error');
                return false;
            }

            await db.collection('clientes').doc(clienteId).update({
                'deuda': deudaNueva,
                'ultimaActualizacion': new Date().getTime()
            });
            return true;
        } catch (e) {
            console.error('Error actualizar crédito:', e);
            return false;
        }
    },

    // Ventas/Transacciones
    guardarVenta: async function(ventaData) {
        try {
            const docRef = await db.collection('ventas').add({
                ...ventaData,
                timestamp: new Date().getTime(),
                sincronizado: true
            });
            return docRef.id;
        } catch (e) {
            console.error('Error guardar venta:', e);
            throw e;
        }
    },

    // Guardar venta sin cobrar (mesa/pendiente)
    guardarVentaPendiente: async function(ventaData) {
        try {
            const docRef = await db.collection('ventasPendientes').add({
                ...ventaData,
                timestamp: new Date().getTime(),
                estado: 'pendiente',
                sincronizado: true
            });
            return docRef.id;
        } catch (e) {
            console.error('Error guardar venta pendiente:', e);
            throw e;
        }
    },

    // Actualizar venta existente
    actualizarVenta: async function(ventaId, datos) {
        try {
            await db.collection('ventas').doc(ventaId).update({
                ...datos,
                actualizadoBefore: new Date().getTime()
            });
            return true;
        } catch (e) {
            console.error('Error actualizar venta:', e);
            return false;
        }
    },

    // Obtener venta
    obtenerVenta: async function(ventaId) {
        try {
            const doc = await db.collection('ventas').doc(ventaId).get();
            return doc.exists ? { id: doc.id, ...doc.data() } : null;
        } catch (e) {
            console.error('Error obtener venta:', e);
            return null;
        }
    },

    // Puntos de cliente
    actualizarPuntosCliente: async function(clienteId, puntos) {
        try {
            const cliente = await this.obtenerCliente(clienteId);
            if (!cliente) return false;

            const nuevosPuntos = (cliente.puntos || 0) + puntos;

            await db.collection('clientes').doc(clienteId).update({
                'puntos': nuevosPuntos
            });
            return true;
        } catch (e) {
            console.error('Error actualizar puntos:', e);
            return false;
        }
    },

    canjearPuntos: async function(clienteId, puntos) {
        try {
            const cliente = await this.obtenerCliente(clienteId);
            if (!cliente || cliente.puntos < puntos) {
                Utils.mostrarToast('Puntos insuficientes', 'error');
                return false;
            }

            const nuevosPuntos = cliente.puntos - puntos;
            await db.collection('clientes').doc(clienteId).update({
                'puntos': nuevosPuntos
            });
            return true;
        } catch (e) {
            console.error('Error canjear puntos:', e);
            return false;
        }
    },

    // Auditoría
    registrarAuditoria: async function(accion, detalles) {
        try {
            await db.collection('auditoria').add({
                usuario: auth.currentUser?.uid || 'anonimo',
                accion,
                detalles,
                timestamp: new Date().getTime(),
                ip: await this._obtenerIP()
            });
        } catch (e) {
            console.error('Error registrar auditoría:', e);
        }
    },

    _obtenerIP: async function() {
        try {
            const response = await fetch('https://api.ipify.org?format=json');
            const data = await response.json();
            return data.ip;
        } catch (e) {
            return 'desconocida';
        }
    }
};
