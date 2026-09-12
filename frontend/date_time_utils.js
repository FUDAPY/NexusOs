(function (root) {
    function toDate(value) {
        if (!value) return null;
        if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
        if (typeof value.toDate === 'function') return toDate(value.toDate());
        if (typeof value.seconds === 'number') return toDate(value.seconds * 1000);
        if (typeof value._seconds === 'number') return toDate(value._seconds * 1000);
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function normalizeMidnight(text) {
        return String(text || '').replace(/\b24:/g, '00:');
    }

    function formatTime24(value, fallback = '--:--') {
        const date = toDate(value);
        if (!date) return fallback;
        return normalizeMidnight(new Intl.DateTimeFormat('es-PY', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            hourCycle: 'h23'
        }).format(date));
    }

    function formatDate24(value, fallback = '--') {
        const date = toDate(value);
        if (!date) return fallback;
        return new Intl.DateTimeFormat('es-PY', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        }).format(date);
    }

    function formatDateTime24(value, fallback = '--') {
        const date = toDate(value);
        if (!date) return fallback;
        return normalizeMidnight(new Intl.DateTimeFormat('es-PY', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            hourCycle: 'h23'
        }).format(date));
    }

    root.DateTime24 = Object.freeze({ toDate, formatTime24, formatDate24, formatDateTime24 });
})(typeof globalThis !== 'undefined' ? globalThis : window);
