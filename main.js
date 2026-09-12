const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { EscPosService } = require('./escpos-service');

// 1. BASE DE DATOS LOCAL PURA (Sin C++, Sin Errores)
const dbPath = path.join(app.getPath('userData'), 'pos_offline_sales.json');

function getSales() {
    if (!fs.existsSync(dbPath)) return [];
    const raw = fs.readFileSync(dbPath);
    return JSON.parse(raw);
}

function saveSales(sales) {
    fs.writeFileSync(dbPath, JSON.stringify(sales, null, 2));
}

// 2. CONFIGURAR LA VENTANA
let mainWindow;
let escPosService;

function crearVentana() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1024,
        minHeight: 768,
        title: "Coffee POS - Terminal de Caja",
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // AHORA CARGA LA CARPETA FRONTEND DIRECTAMENTE
    mainWindow.loadFile(path.join(__dirname, 'frontend/index.html'));
}

app.whenReady().then(() => {
    escPosService = new EscPosService(app.getPath('userData'));
    crearVentana();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// 3. PUENTE DE COMUNICACIÓN OFFLINE
ipcMain.handle('guardar-venta-offline', async (event, datosVenta) => {
    try {
        const sales = getSales();
        const newId = Date.now(); 
        sales.push({ id: newId, data: datosVenta, sync_status: 'pending' });
        saveSales(sales);
        return { success: true, localId: newId };
    } catch (e) {
        console.error(e);
        throw e;
    }
});

ipcMain.handle('obtener-ventas-pendientes', async (event) => {
    const sales = getSales();
    return sales.filter(s => s.sync_status === 'pending');
});

ipcMain.handle('marcar-venta-sincronizada', async (event, localId) => {
    const sales = getSales();
    const updated = sales.map(s => s.id === localId ? { ...s, sync_status: 'synced' } : s);
    saveSales(updated);
    return { success: true };
});

function validarVentanaIpc(event) {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Origen IPC no autorizado.');
}

ipcMain.handle('escpos:status', async (event) => {
    validarVentanaIpc(event);
    return {
        supported: escPosService.isSupported(),
        platform: process.platform,
        config: escPosService.getConfig()
    };
});

ipcMain.handle('escpos:save-config', async (event, config) => {
    validarVentanaIpc(event);
    return { success: true, config: escPosService.saveConfig(config) };
});

ipcMain.handle('escpos:list-usb', async (event) => {
    validarVentanaIpc(event);
    return escPosService.listUsbPrinters();
});

ipcMain.handle('escpos:test', async (event) => {
    validarVentanaIpc(event);
    return escPosService.test();
});

ipcMain.handle('escpos:print', async (event, document) => {
    validarVentanaIpc(event);
    return escPosService.print(document);
});
