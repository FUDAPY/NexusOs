(() => {
    const sections = [
        {
            title: "Administrativo",
            items: [
                { label: "Panel Financiero", href: "dashboard.html", icon: "fa-house", route: "dashboard.html" },
                { label: "Sucursal", href: "sucursales.html", icon: "fa-store", route: "sucursales.html" },
                { label: "Personal", href: "usuarios.html", icon: "fa-user-shield", route: "usuarios.html" },
                { label: "Aprobacion de Clientes", href: "clientes.html?view=aprobaciones", icon: "fa-user-check", route: "clientes-aprobaciones" },
                { label: "Clientes CRM", href: "clientes.html", icon: "fa-gem", route: "clientes.html" },
                { label: "Reportes", href: "reportes.html", icon: "fa-chart-line", route: "reportes.html" }
            ]
        },
        {
            title: "Operacion",
            items: [
                { label: "Stock", href: "stock.html", icon: "fa-warehouse", route: "stock.html" },
                { label: "Produccion", href: "produccion.html", icon: "fa-burger", route: "produccion.html" },
                { label: "Inventario", href: "inventario.html", icon: "fa-boxes-stacked", route: "inventario.html" },
                { label: "Monitor Cocina", href: "kds.html", icon: "fa-fire-burner", route: "kds.html" }
            ]
        },
        {
            title: "Software",
            items: [
                { label: "Lin Tickets", href: "lin_tickets.html", icon: "fa-ticket", route: "lin_tickets.html" },
                { label: "Notificaciones", href: "notificaciones.html", icon: "fa-bell", route: "notificaciones.html" },
                { label: "Auditoria de Transacciones", href: "auditoria_transacciones.html", icon: "fa-shield-halved", route: "auditoria_transacciones.html" },
                { label: "Relatorio de Cierres", href: "relatorio_cierres.html", icon: "fa-scale-balanced", route: "relatorio_cierres.html" },
                { label: "Testers Google Play", href: "play_testers.html", icon: "fa-google-play", route: "play_testers.html" },
                { label: "Monitor de Problemas", href: "monitor_problemas.html", icon: "fa-triangle-exclamation", route: "monitor_problemas.html" }
            ]
        }
    ];

    const currentFile = (window.location.pathname.split("/").pop() || "dashboard.html").toLowerCase();
    const currentView = new URLSearchParams(window.location.search).get("view");
    const currentRoute = currentFile === "clientes.html" && currentView === "aprobaciones" ? "clientes-aprobaciones" : currentFile;
    const inactiveClass = "w-full flex items-center gap-4 text-slate-400 hover:bg-slate-800 hover:text-white px-3 py-2.5 rounded-xl font-semibold transition";
    const activeClass = "w-full flex items-center gap-4 bg-orange-600 text-white px-3 py-2.5 rounded-xl font-semibold shadow-md transition";

    function renderAdminSidebar() {
        const nav = document.querySelector("aside nav");
        if (!nav) return;
        nav.className = "flex-1 overflow-y-auto p-4 space-y-1 mt-2 scrollbar-hide";
        nav.innerHTML = sections.map((section) => `
            <div class="pt-2 first:pt-0">
                <p class="text-xs font-bold text-slate-500 uppercase tracking-widest mt-4 mb-2 pl-2">${section.title}</p>
                <div class="space-y-1">
                    ${section.items.map((item) => {
                        const active = item.route === currentRoute;
                        return `
                            <a href="${item.href}" class="${active ? activeClass : inactiveClass}" data-admin-route="${item.route}">
                                <i class="fa-solid ${item.icon} text-lg w-6 text-center"></i><span>${item.label}</span>
                            </a>
                        `;
                    }).join("")}
                </div>
            </div>
        `).join("");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", renderAdminSidebar);
    } else {
        renderAdminSidebar();
    }
})();
