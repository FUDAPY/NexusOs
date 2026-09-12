const fs = require('fs');
const path = require('path');
const { Printer } = require('@node-escpos/core');
const NetworkAdapter = require('@node-escpos/network-adapter');

let usbAdapterClass = null;

function getUsbAdapter() {
    if (!usbAdapterClass) usbAdapterClass = require('@node-escpos/usb-adapter');
    return usbAdapterClass;
}

const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    connection: 'usb',
    host: '',
    port: 9100,
    vendorId: null,
    productId: null,
    paperWidth: 58,
    columns: 32,
    encoding: 'CP858',
    cut: true,
    cashDrawer: false
});

function cleanText(value, maxLength = 180) {
    return String(value ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function cleanInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function parseUsbId(value) {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value).trim().toLowerCase();
    const parsed = text.startsWith('0x') ? Number.parseInt(text.slice(2), 16) : Number.parseInt(text, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) return null;
    return parsed;
}

function normalizeConfig(value = {}) {
    const connection = value.connection === 'network' ? 'network' : 'usb';
    const paperWidth = Number(value.paperWidth) === 80 ? 80 : 58;
    return {
        enabled: value.enabled !== false,
        connection,
        host: cleanText(value.host, 255),
        port: cleanInteger(value.port, 9100, 1, 65535),
        vendorId: parseUsbId(value.vendorId),
        productId: parseUsbId(value.productId),
        paperWidth,
        columns: paperWidth === 80 ? 48 : 32,
        encoding: ['CP858', 'CP850', 'CP437', 'UTF-8'].includes(value.encoding) ? value.encoding : 'CP858',
        cut: value.cut !== false,
        cashDrawer: value.cashDrawer === true
    };
}

function wrapText(value, width) {
    const text = cleanText(value, 1000);
    if (!text) return [];
    const lines = [];
    let remaining = text;
    while (remaining.length > width) {
        let splitAt = remaining.lastIndexOf(' ', width);
        if (splitAt < Math.floor(width * 0.45)) splitAt = width;
        lines.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trim();
    }
    if (remaining) lines.push(remaining);
    return lines;
}

function alignedLine(leftValue, rightValue, width) {
    const left = cleanText(leftValue, width * 3);
    const right = cleanText(rightValue, width);
    if (!right) return wrapText(left, width);
    const available = Math.max(4, width - right.length - 1);
    const leftLines = wrapText(left, available);
    const lines = leftLines.length ? leftLines : [''];
    const last = lines.pop();
    lines.push(`${last}${' '.repeat(Math.max(1, width - last.length - right.length))}${right}`);
    return lines;
}

function normalizeDocument(value = {}) {
    const items = Array.isArray(value.items) ? value.items.slice(0, 200).map((item) => ({
        quantity: cleanInteger(item.quantity, 1, 1, 999),
        name: cleanText(item.name, 180) || 'Producto',
        amount: cleanText(item.amount, 40),
        note: cleanText(item.note, 180)
    })) : [];
    return {
        businessName: cleanText(value.businessName, 100) || 'CLUB LIN',
        title: cleanText(value.title, 80) || 'TICKET',
        subtitle: cleanText(value.subtitle, 120),
        headerLines: Array.isArray(value.headerLines) ? value.headerLines.slice(0, 10).map((line) => cleanText(line, 180)).filter(Boolean) : [],
        infoLines: Array.isArray(value.infoLines) ? value.infoLines.slice(0, 20).map((line) => cleanText(line, 180)).filter(Boolean) : [],
        items,
        totalLabel: cleanText(value.totalLabel, 40) || 'TOTAL',
        total: cleanText(value.total, 60),
        detailLines: Array.isArray(value.detailLines) ? value.detailLines.slice(0, 20).map((line) => cleanText(line, 180)).filter(Boolean) : [],
        footer: cleanText(value.footer, 240),
        copies: cleanInteger(value.copies, 2, 1, 10),
        openDrawer: value.openDrawer === true
    };
}

function openDevice(device) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error('La impresora no respondio dentro del tiempo esperado.'));
            }
        }, 8000);
        device.open((error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (error) reject(error);
            else resolve();
        });
    });
}

class EscPosService {
    constructor(userDataPath) {
        this.configPath = path.join(userDataPath, 'escpos-config.json');
    }

    isSupported() {
        return process.platform === 'linux';
    }

    getConfig() {
        try {
            if (!fs.existsSync(this.configPath)) return { ...DEFAULT_CONFIG };
            return normalizeConfig(JSON.parse(fs.readFileSync(this.configPath, 'utf8')));
        } catch {
            return { ...DEFAULT_CONFIG };
        }
    }

    saveConfig(value) {
        const config = normalizeConfig(value);
        if (config.connection === 'network' && !config.host) throw new Error('Indica la IP o el host de la impresora.');
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
        return config;
    }

    listUsbPrinters() {
        if (!this.isSupported()) return [];
        const USBAdapter = getUsbAdapter();
        return USBAdapter.findPrinter().map((device) => {
            const descriptor = device.deviceDescriptor || {};
            return {
                vendorId: Number(descriptor.idVendor || 0),
                productId: Number(descriptor.idProduct || 0),
                vendorHex: `0x${Number(descriptor.idVendor || 0).toString(16).padStart(4, '0')}`,
                productHex: `0x${Number(descriptor.idProduct || 0).toString(16).padStart(4, '0')}`
            };
        });
    }

    createDevice(config) {
        if (config.connection === 'network') return new NetworkAdapter(config.host, config.port, 8000);
        const USBAdapter = getUsbAdapter();
        if (config.vendorId !== null && config.productId !== null) return new USBAdapter(config.vendorId, config.productId);
        return new USBAdapter();
    }

    async print(value) {
        if (!this.isSupported()) return { success: false, handled: false, reason: 'unsupported-platform' };
        const config = this.getConfig();
        if (!config.enabled) return { success: false, handled: false, reason: 'disabled' };
        const document = normalizeDocument(value);
        const device = this.createDevice(config);
        let opened = false;
        try {
            await openDevice(device);
            opened = true;
            const printer = new Printer(device, { encoding: config.encoding, width: config.columns });
            const line = '-'.repeat(config.columns);
            const copies = Math.max(1, Math.min(Number.parseInt(document.copies, 10) || 2, 10));
            for (let copyIndex = 0; copyIndex < copies; copyIndex += 1) {
                printer.hardware('INIT').font('A').align('CT').style('B').size(1, 1).text(document.businessName, config.encoding);
                document.headerLines.forEach((entry) => printer.style('NORMAL').text(entry, config.encoding));
                printer.style('B').text(document.title, config.encoding).style('NORMAL');
                if (document.subtitle) printer.text(document.subtitle, config.encoding);
                printer.align('LT').text(line, config.encoding);
                document.infoLines.forEach((entry) => wrapText(entry, config.columns).forEach((part) => printer.text(part, config.encoding)));
                if (document.infoLines.length) printer.text(line, config.encoding);
                document.items.forEach((item) => {
                    alignedLine(`${item.quantity}x ${item.name}`, item.amount, config.columns).forEach((entry) => printer.text(entry, config.encoding));
                    if (item.note) wrapText(`  ${item.note}`, config.columns).forEach((entry) => printer.text(entry, config.encoding));
                });
                if (document.items.length) printer.text(line, config.encoding);
                if (document.total) {
                    printer.style('B');
                    alignedLine(document.totalLabel, document.total, config.columns).forEach((entry) => printer.text(entry, config.encoding));
                    printer.style('NORMAL');
                }
                document.detailLines.forEach((entry) => alignedLine(entry, '', config.columns).forEach((part) => printer.text(part, config.encoding)));
                if (document.footer) {
                    printer.text(line, config.encoding).align('CT');
                    wrapText(document.footer, config.columns).forEach((entry) => printer.text(entry, config.encoding));
                }
                if (copyIndex === 0 && config.cashDrawer && document.openDrawer) printer.cashdraw(2);
                printer.feed(3);
                if (config.cut) printer.cut(false);
            }
            await printer.close();
            opened = false;
            return { success: true, handled: true, connection: config.connection };
        } catch (error) {
            if (opened) {
                try { device.close(); } catch {}
            }
            const message = cleanText(error?.message || error, 300) || 'No se pudo imprimir.';
            throw new Error(message);
        }
    }

    async test() {
        return this.print({
            businessName: 'CLUB LIN',
            title: 'PRUEBA ESC/POS',
            subtitle: 'Conexion directa Linux',
            infoLines: [`Fecha: ${new Date().toLocaleString('es-PY')}`],
            items: [{ quantity: 1, name: 'Impresora configurada', amount: 'OK' }],
            footer: 'Prueba completada correctamente.'
        });
    }
}

module.exports = { EscPosService, normalizeConfig };
