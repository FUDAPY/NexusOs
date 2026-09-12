(function (global) {
    'use strict';

    const DEFAULT_COPIES = 2;

    function normalizeCopies(value) {
        const copies = Number.parseInt(value, 10);
        return Number.isFinite(copies) && copies > 0 ? Math.min(copies, 10) : DEFAULT_COPIES;
    }

    function buildCopiesDocument(html, copies = DEFAULT_COPIES) {
        const parser = new DOMParser();
        const source = parser.parseFromString(String(html || ''), 'text/html');
        const totalCopies = normalizeCopies(copies);
        const bodyMarkup = source.body.innerHTML;
        const copyMarkup = Array.from({ length: totalCopies }, (_, index) => (
            `<section class="otelax-print-copy${index === totalCopies - 1 ? ' otelax-print-copy-last' : ''}">${bodyMarkup}</section>`
        )).join('');

        return `<!DOCTYPE html><html><head>${source.head.innerHTML}<style>
            .otelax-print-copy { break-after: page; page-break-after: always; }
            .otelax-print-copy-last { break-after: auto; page-break-after: auto; }
        </style></head><body>${copyMarkup}</body></html>`;
    }

    function printHtml(html, options = {}) {
        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.style.position = 'fixed';
        frame.style.right = '0';
        frame.style.bottom = '0';
        frame.style.width = '0';
        frame.style.height = '0';
        frame.style.border = '0';
        document.body.appendChild(frame);
        frame.contentDocument.open();
        frame.contentDocument.write(buildCopiesDocument(html, options.copies));
        frame.contentDocument.close();
        setTimeout(() => {
            frame.contentWindow.focus();
            frame.contentWindow.print();
            setTimeout(() => frame.remove(), 2000);
        }, Number(options.delay || 300));
    }

    function printElement(element, options = {}) {
        if (!element) return;
        const clone = element.cloneNode(true);
        const originalCanvases = element.querySelectorAll('canvas');
        clone.querySelectorAll('canvas').forEach((canvas, index) => {
            const sourceCanvas = originalCanvases[index];
            if (!sourceCanvas) return;
            const image = document.createElement('img');
            image.src = sourceCanvas.toDataURL('image/png');
            image.style.width = `${sourceCanvas.clientWidth || sourceCanvas.width}px`;
            image.style.maxWidth = '100%';
            canvas.replaceWith(image);
        });
        const styles = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
            .map((node) => node.outerHTML)
            .join('');
        const title = options.title || document.title || 'Documento';
        const html = `<!DOCTYPE html><html><head><base href="${document.baseURI}"><meta charset="UTF-8"><title>${title}</title>${styles}<style>
            body { margin: 0; background: white; color: #0f172a; }
            main, header, section, div { max-height: none !important; overflow: visible !important; }
            button, aside, nav, [id^="modal-"], #toast { display: none !important; }
        </style></head><body>${clone.outerHTML}</body></html>`;
        printHtml(html, options);
    }

    global.PrintUtils = Object.freeze({
        DEFAULT_COPIES,
        buildCopiesDocument,
        printHtml,
        printElement
    });
})(window);
