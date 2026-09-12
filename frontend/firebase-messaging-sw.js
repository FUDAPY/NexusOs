importScripts("https://www.gstatic.com/firebasejs/10.8.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging-compat.js");

firebase.initializeApp({
    apiKey: "AIzaSyALS7-xIkcvY4MnSvBm44tzFk6cxyS14Eg",
    authDomain: "sys-pos-erp-lingroup.firebaseapp.com",
    projectId: "sys-pos-erp-lingroup",
    storageBucket: "sys-pos-erp-lingroup.firebasestorage.app",
    messagingSenderId: "1084603889746",
    appId: "1:1084603889746:web:822ce55a070dc146b2078b",
    measurementId: "G-1LZVQ05T2E"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
    const data = payload?.data || {};
    const notification = payload?.notification || {};
    const title = notification.title || data.titulo || data.title || "Club Lin";
    const body = notification.body || data.mensaje || data.body || "Tenes una nueva novedad.";
    const route = data.route || "notifications";

    self.registration.showNotification(title, {
        body,
        icon: "/club_lin_logo.jpg",
        badge: "/club_lin_logo.jpg",
        tag: data.notificationId || `club-lin-${Date.now()}`,
        data: {
            route,
            orderId: data.orderId || "",
            notificationId: data.notificationId || ""
        }
    });
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const data = event.notification.data || {};
    const route = data.orderId ? `app_cliente.html?orderId=${encodeURIComponent(data.orderId)}` :
        data.route === "tickets" ? "app_cliente.html?view=tickets" :
        data.route === "orders" ? "app_cliente.html?view=orders" :
        "app_cliente.html?view=notifications";
    const url = new URL(route, self.location.origin).href;

    event.waitUntil((async () => {
        const clientsList = await clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of clientsList) {
            if ("focus" in client) {
                await client.focus();
                if ("navigate" in client) return client.navigate(url);
                return;
            }
        }
        if (clients.openWindow) return clients.openWindow(url);
    })());
});
