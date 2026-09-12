const admin = require("firebase-admin");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const messaging = admin.messaging();
const SALES_COLLECTION_PATH = "artifacts/erp_lingroup/users/admin_master_001/sales";
const CASH_FLOW_COLLECTION = "cashFlows";
const CASH_FLOW_CONTRIBUTIONS_COLLECTION = "cashFlowContributions";
const CASH_FLOW_AUDIT_COLLECTION = "cashFlowAudits";
const CASH_FLOW_FIELDS = [
  "ventaTotalBruta",
  "efectivo",
  "tarjetaPOS",
  "transferencia",
  "credito",
  "totalProductos",
  "totalTickets",
  "totalTicketsFlujo",
  "totalTicketsPagados",
  "totalTicketsPendientes"
];
const OPERATIONAL_ALERT_LEVELS = new Set(["info", "warning", "error", "critical"]);
const PROJECT_ID = "sys-pos-erp-lingroup";
const GA4_MEASUREMENT_ID = "G-1LZVQ05T2E";
let ga4ApiSecretCache = null;
const PUBLIC_GOAL_AMOUNT = 2000000;
const BUSINESS_TIMEZONE = "America/Asuncion";
const PLAY_STORE_URL = process.env.PLAY_STORE_URL || "https://play.google.com/store/apps/details?id=com.lingroup.clublin";
const PLAY_TESTERS_GROUP_EMAIL = process.env.PLAY_TESTERS_GROUP_EMAIL || "club-lin-testers@googlegroups.com";
const SMTP_HOST = defineSecret("SMTP_HOST");
const SMTP_USER = defineSecret("SMTP_USER");
const SMTP_PASS = defineSecret("SMTP_PASS");
const PASSWORD_RESET_OTP_PEPPER = defineSecret("PASSWORD_RESET_OTP_PEPPER");
const PASSWORD_RESET_CODE_TTL_MS = 15 * 60 * 1000;
const PASSWORD_RESET_RESEND_MS = 60 * 1000;
const PASSWORD_RESET_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_PROCESSING_MS = PASSWORD_RESET_CODE_TTL_MS;
const PUBLIC_APP_ORIGIN = "https://sys-pos-erp-lingroup.web.app";
const PUBLIC_APP_LOGO_URL = `${PUBLIC_APP_ORIGIN}/club_lin_logo.jpg`;
const CONTROL_CENTER_APPS = {
  pos: {
    id: "pos",
    name: "POS",
    module: "POS",
    url: "https://sys-pos-erp-lingroup.web.app/pos"
  },
  admin: {
    id: "admin",
    name: "ADMIN",
    module: "ADMIN",
    url: "https://sys-pos-erp-lingroup.web.app/dashboard"
  },
  app_cliente: {
    id: "app_cliente",
    name: "APP CLIENTE",
    module: "APP CLIENTE",
    url: "https://sys-pos-erp-lingroup.web.app/app_cliente"
  },
  app_produccion: {
    id: "app_produccion",
    name: "APP PRODUCCION",
    module: "APP PRODUCCION",
    url: "https://sys-pos-erp-lingroup.web.app/produccion"
  },
  app_delivery: {
    id: "app_delivery",
    name: "APP DELIVERY",
    module: "APP DELIVERY",
    url: "https://sys-pos-erp-lingroup.web.app/app_delivery"
  }
};

async function getUserRole(uid) {
  if (!uid) return null;
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return null;
  return snap.data().rol || null;
}

function cleanText(value, maxLength) {
  const text = String(value || "").trim();
  return text.slice(0, maxLength);
}

function cleanNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hashCreditPin(userId, pin) {
  return crypto
    .createHash("sha256")
    .update(`${userId}::club-lin-credit-pin::${String(pin || "")}`)
    .digest("hex");
}

function normalizePasswordResetEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 254);
}

function passwordResetEmailIsValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function passwordResetDocId(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function passwordResetCodeHash(email, code, pepper) {
  return crypto
    .createHmac("sha256", pepper)
    .update(`${email}::${code}`)
    .digest("hex");
}

function passwordResetTimestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  return Number(value) || 0;
}

function passwordResetError(reason) {
  const errors = {
    invalid: ["failed-precondition", "El codigo es incorrecto."],
    expired: ["deadline-exceeded", "El codigo vencio. Solicita uno nuevo."],
    blocked: ["resource-exhausted", "Se supero el limite de intentos. Solicita un codigo nuevo."],
    consumed: ["already-exists", "Este codigo ya fue utilizado."],
    processing: ["aborted", "El cambio de contrasena ya esta en proceso."],
    user_not_found: ["not-found", "No fue posible validar la solicitud de recuperacion."],
    delivery_failed: ["failed-precondition", "El codigo no pudo ser entregado. Solicita uno nuevo."]
  };
  const [code, message] = errors[reason] || errors.invalid;
  return new HttpsError(code, message, { reason });
}

async function markPasswordResetConsumed(otpRef, processingToken) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(otpRef);
        if (!snapshot.exists) throw new Error("La solicitud de recuperacion ya no existe.");
        const data = snapshot.data() || {};
        if (data.status === "consumed" || data.used === true) return;
        if (data.processingToken !== processingToken) throw new Error("El token de procesamiento no coincide.");
        transaction.set(otpRef, {
          status: "consumed",
          used: true,
          codeHash: admin.firestore.FieldValue.delete(),
          processingToken: admin.firestore.FieldValue.delete(),
          processingUntil: admin.firestore.FieldValue.delete(),
          usedAt: admin.firestore.FieldValue.serverTimestamp(),
          consumedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      });
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 150));
    }
  }
  throw lastError;
}

function normalizeAnalyticsClientId(value) {
  const raw = String(value || "").trim();
  if (!raw) return `server.${Date.now()}`;
  return raw
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function cleanAnalyticsParams(params = {}) {
  const cleaned = {};
  Object.entries(params || {}).forEach(([key, value]) => {
    const safeKey = String(key || "")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .slice(0, 40);
    if (!safeKey || value === undefined || value === null) return;
    if (typeof value === "number") {
      if (Number.isFinite(value)) cleaned[safeKey] = value;
      return;
    }
    if (typeof value === "boolean") {
      cleaned[safeKey] = value ? "true" : "false";
      return;
    }
    cleaned[safeKey] = String(value).slice(0, 100);
  });
  return cleaned;
}

async function getGa4ApiSecret() {
  if (ga4ApiSecretCache !== null) return ga4ApiSecretCache;

  const docPaths = [
    ["settings", "analytics"],
    ["settings", "ga4"],
    ["config", "analytics"]
  ];

  for (const [collectionName, docId] of docPaths) {
    try {
      const snap = await db.collection(collectionName).doc(docId).get();
      if (!snap.exists) continue;
      const data = snap.data() || {};
      const candidate = cleanText(
        data.ga4ApiSecret ||
        data.measurementProtocolSecret ||
        data.apiSecret ||
        data.secret,
        160
      );
      if (candidate) {
        ga4ApiSecretCache = candidate;
        return ga4ApiSecretCache;
      }
    } catch (error) {
      logger.warn("No se pudo leer configuracion GA4", {
        path: `${collectionName}/${docId}`,
        message: error?.message || String(error)
      });
    }
  }

  ga4ApiSecretCache = "";
  return ga4ApiSecretCache;
}

async function trackGa4Event({ name, clientId, userId, params = {} }) {
  const eventName = String(name || "")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .slice(0, 40);
  if (!eventName) return;

  const apiSecret = await getGa4ApiSecret();
  if (!apiSecret) {
    logger.warn("GA4 secret vacio", { eventName });
    return;
  }

  const body = {
    client_id: normalizeAnalyticsClientId(clientId || userId),
    user_id: userId ? String(userId).slice(0, 120) : undefined,
    events: [{
      name: eventName,
      params: cleanAnalyticsParams({
        engagement_time_msec: 1,
        source_app: "club_lin",
        ...params
      })
    }]
  };

  try {
    const response = await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(apiSecret)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );
    if (!response.ok) {
      logger.warn("GA4 event rejected", { eventName, status: response.status });
    }
  } catch (error) {
    logger.warn("No se pudo enviar evento GA4", {
      eventName,
      message: error?.message || String(error)
    });
  }
}

async function collectClientPushTokenRecords() {
  const usersSnap = await db.collection("users")
    .where("rol", "==", "cliente")
    .where("pushPermiso", "==", "granted")
    .get();

  const records = [];
  await Promise.all(usersSnap.docs.map(async (userDoc) => {
    const data = userDoc.data() || {};
    const legacyTokens = [
      { token: data.pushTokenMovil, field: "pushTokenMovil" },
      { token: data.pushTokenWeb, field: "pushTokenWeb" }
    ];

    legacyTokens.forEach((item) => {
      const token = String(item.token || "").trim();
      if (token) records.push({ token, userRef: userDoc.ref, legacyField: item.field });
    });

    const tokenSnap = await userDoc.ref.collection("notificationTokens").where("active", "==", true).get();
    tokenSnap.forEach((tokenDoc) => {
      const tokenData = tokenDoc.data() || {};
      const token = String(tokenData.token || "").trim();
      if (token) records.push({ token, userRef: userDoc.ref, tokenRef: tokenDoc.ref });
    });
  }));

  const seen = new Set();
  return records.filter((record) => {
    if (seen.has(record.token)) return false;
    seen.add(record.token);
    return true;
  });
}

async function deactivateInvalidPushTokens(records, invalidTokens) {
  if (!invalidTokens.length) return;
  const invalidSet = new Set(invalidTokens);
  const batch = db.batch();

  records.forEach((record) => {
    if (!invalidSet.has(record.token)) return;
    if (record.tokenRef) {
      batch.set(record.tokenRef, {
        active: false,
        invalidatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    if (record.legacyField && record.userRef) {
      batch.update(record.userRef, {
        [record.legacyField]: admin.firestore.FieldValue.delete(),
        pushPermiso: "stale"
      });
    }
  });

  await batch.commit();
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeDocKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "general";
}

function isCreditMethod(value) {
  return normalizeText(value) === "credito";
}

function itemNeedsKitchen(item) {
  const category = normalizeText(item?.categoria || item?.rubro || "");
  return category !== "bebida" && category !== "bebidas";
}

function hasFreeCreditForBranch(userData, sucursal) {
  const branch = normalizeText(sucursal);
  if (!branch || !Array.isArray(userData?.sucursalesCreditoLibre)) return false;
  return userData.sucursalesCreditoLibre.some((item) => normalizeText(item) === branch);
}

function resolveAlertModule(alertData = {}) {
  const origen = normalizeText(alertData?.origen);
  const tipo = normalizeText(alertData?.tipo);
  const texto = `${origen} ${tipo}`;
  if (texto.includes("pos") || texto.includes("caja")) return "POS";
  if (texto.includes("dashboard") || texto.includes("admin")) return "ADMIN";
  if (texto.includes("app_cliente") || texto.includes("cliente")) return "APP CLIENTE";
  if (texto.includes("produccion")) return "APP PRODUCCION";
  if (texto.includes("delivery")) return "APP DELIVERY";
  return "SISTEMA";
}

function buildControlCenterHealthConfig() {
  return {
    apps: Object.values(CONTROL_CENTER_APPS).map((appConfig) => ({
      id: appConfig.id,
      name: appConfig.name,
      projectId: PROJECT_ID,
      serviceAccountPath: "./secrets/sys-pos-erp-lingroup-service-account.json",
      hosting: [
        {
          id: "web",
          label: "Sitio principal",
          url: appConfig.url
        }
      ],
      functions: [
        {
          id: "health",
          label: "Health endpoint",
          url: `https://us-central1-${PROJECT_ID}.cloudfunctions.net/health?app=${appConfig.id}`
        }
      ],
      firestore: {
        enabled: true,
        healthDocumentPath: "health/status"
      },
      storage: {
        enabled: true,
        bucket: "sys-pos-erp-lingroup.firebasestorage.app"
      }
    }))
  };
}

function getConfiguredClientDiscount(userData) {
  if (userData?.descuentoVipConfigurado !== true) return 0;
  return Math.max(0, Math.min(100, cleanNumber(userData?.descuentoVip, 0)));
}

function paymentMethodAllowsPremiumDiscount(method) {
  const normalized = normalizeText(method);
  return ["efectivo", "transferencia", "tarjeta", "mixto"].includes(normalized);
}

function getClientDiscountForPayment(userData, method) {
  if (!paymentMethodAllowsPremiumDiscount(method)) return 0;
  return getConfiguredClientDiscount(userData);
}

function parseTicketDate(value, endOfDay = false) {
  const date = resolveSaleDate(value) || (value ? new Date(String(value).length <= 10 ? `${value}T${endOfDay ? "23:59:59" : "00:00:00"}` : value) : null);
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
}

function ticketAppliesToBranch(ticketData = {}, branchId = "", branchName = "") {
  if (ticketData.appliesToAllBranches === true) return true;
  const ticketBranchId = cleanText(ticketData.branchId, 120);
  if (!ticketBranchId || ticketBranchId === "all") return true;
  return normalizeText(ticketBranchId) === normalizeText(branchId)
    || normalizeText(ticketData.branchName) === normalizeText(branchName);
}

function getPlayTesterRequestId(uid, email) {
  return normalizeDocKey(uid || email || `request_${Date.now()}`).slice(0, 180);
}

function getPlayTesterConfig() {
  return {
    groupEmail: cleanText(process.env.PLAY_TESTERS_GROUP_EMAIL || PLAY_TESTERS_GROUP_EMAIL, 180),
    playStoreUrl: cleanText(process.env.PLAY_STORE_URL || PLAY_STORE_URL, 260),
    clientEmail: cleanText(process.env.GOOGLE_PLAY_TESTERS_CLIENT_EMAIL, 260),
    privateKey: String(process.env.GOOGLE_PLAY_TESTERS_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    delegatedAdminEmail: cleanText(process.env.GOOGLE_IMPERSONATED_ADMIN_EMAIL, 260),
    enabled: String(process.env.GOOGLE_GROUPS_AUTOMATION_ENABLED || "").toLowerCase() === "true"
  };
}

async function addEmailToGoogleTesterGroup(email) {
  const config = getPlayTesterConfig();
  if (!config.enabled || !config.clientEmail || !config.privateKey || !config.delegatedAdminEmail || !config.groupEmail) {
    return {
      ok: false,
      status: "manual_review_required",
      errorMessage: "Google Groups API no esta configurada. Agregar el correo al grupo manualmente o configurar Workspace/API."
    };
  }

  const { google } = require("googleapis");
  const auth = new google.auth.JWT({
    email: config.clientEmail,
    key: config.privateKey,
    scopes: [
      "https://www.googleapis.com/auth/admin.directory.group.member"
    ],
    subject: config.delegatedAdminEmail
  });
  const directory = google.admin({ version: "directory_v1", auth });

  try {
    await directory.members.insert({
      groupKey: config.groupEmail,
      requestBody: {
        email,
        role: "MEMBER"
      }
    });
    return { ok: true, status: "added_to_google_group", errorMessage: "" };
  } catch (error) {
    const code = Number(error?.code || error?.response?.status || 0);
    const message = error?.message || String(error);
    if (code === 409 || normalizeText(message).includes("member_exists")) {
      return { ok: true, status: "added_to_google_group", errorMessage: "" };
    }
    logger.error("No se pudo agregar tester al Google Group", { email, code, message });
    return {
      ok: false,
      status: "failed",
      errorMessage: message
    };
  }
}

async function processPlayTesterRequest({ uid, email, displayName, source = "auto" }) {
  const safeEmail = cleanText(email, 260).toLowerCase();
  if (!uid || !safeEmail || !safeEmail.includes("@")) {
    return { ok: false, status: "manual_review_required", errorMessage: "Usuario sin correo valido." };
  }

  const config = getPlayTesterConfig();
  const requestId = getPlayTesterRequestId(uid, safeEmail);
  const requestRef = db.collection("playTesterRequests").doc(requestId);
  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (transaction) => {
    const reqSnap = await transaction.get(requestRef);
    const existing = reqSnap.exists ? (reqSnap.data() || {}) : {};
    if (["processing", "added_to_google_group"].includes(existing.status)) return;
    transaction.set(requestRef, {
      uid,
      email: safeEmail,
      displayName: cleanText(displayName, 180),
      groupEmail: config.groupEmail,
      status: "processing",
      source,
      createdAt: existing.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      playStoreUrl: config.playStoreUrl
    }, { merge: true });
    transaction.set(userRef, {
      playTesterStatus: "processing",
      playTesterRequestedAt: existing.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      playTesterGroupEmail: config.groupEmail,
      playStoreUrl: config.playStoreUrl
    }, { merge: true });
  });

  const result = await addEmailToGoogleTesterGroup(safeEmail);
  const updatePayload = {
    status: result.status,
    processedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    errorMessage: result.errorMessage || "",
    playStoreUrl: config.playStoreUrl,
    groupEmail: config.groupEmail
  };
  await requestRef.set(updatePayload, { merge: true });
  await userRef.set({
    playTesterStatus: result.status,
    playTesterProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
    playTesterErrorMessage: result.errorMessage || "",
    playTesterGroupEmail: config.groupEmail,
    playStoreUrl: config.playStoreUrl
  }, { merge: true });
  return { ok: result.ok, status: result.status, errorMessage: result.errorMessage || "" };
}

function parseMonthInput(value) {
  const raw = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})$/.exec(raw);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year >= 2020 && year <= 2100 && month >= 1 && month <= 12) {
      return { year, month, key: `${match[1]}-${match[2]}` };
    }
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit"
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === "year")?.value || new Date().getFullYear());
  const month = Number(parts.find((part) => part.type === "month")?.value || (new Date().getMonth() + 1));
  return {
    year,
    month,
    key: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`
  };
}

function getMonthRange(monthInfo) {
  const startUtc = new Date(Date.UTC(monthInfo.year, monthInfo.month - 1, 1, 0, 0, 0));
  const endUtc = new Date(Date.UTC(monthInfo.year, monthInfo.month, 1, 0, 0, 0));
  const widenedStart = new Date(startUtc.getTime() - (24 * 60 * 60 * 1000));
  const widenedEnd = new Date(endUtc.getTime() + (24 * 60 * 60 * 1000));
  return { startUtc, endUtc, widenedStart, widenedEnd };
}

function getDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function getDateKeyInTimezone(dateValue, timeZone = BUSINESS_TIMEZONE) {
  if (!(dateValue instanceof Date) || Number.isNaN(dateValue.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(dateValue);
  const year = parts.find((part) => part.type === "year")?.value || "0000";
  const month = parts.find((part) => part.type === "month")?.value || "00";
  const day = parts.find((part) => part.type === "day")?.value || "00";
  return `${year}-${month}-${day}`;
}

function getMonthLabel(monthInfo, locale = "es-PY") {
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric"
  }).format(new Date(Date.UTC(monthInfo.year, monthInfo.month - 1, 15, 12, 0, 0)));
}

function resolveSaleDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value?.toDate === "function") {
    const converted = value.toDate();
    return converted instanceof Date && !Number.isNaN(converted.getTime()) ? converted : null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function saleCountsForPublicGoal(saleData = {}) {
  if (!saleData) return false;
  if (saleData.tipoTransaccion === "abono_deuda") return false;
  if (normalizeText(saleData.estadoPago) !== "pagado") return false;
  if (normalizeText(saleData.estadoCocina) === "anulado") return false;
  if (normalizeText(saleData.estadoDelivery) === "anulado") return false;
  if (saleData.marcadoComoAbonado === true) return false;
  return cleanNumber(saleData.total, 0) > 0;
}

function getPublicGoalBranchId(branchName) {
  const normalized = normalizeDocKey(branchName);
  if (normalized.includes("chicolin") || normalized.includes("cafeteria")) return "cafeteria_chicolin";
  if (normalized.includes("mr_lin") || normalized.includes("restaurante")) return "mr_lin_restaurante";
  return normalized || "sin_sucursal";
}

function getPublicGoalBranchName(branchName) {
  const branchId = getPublicGoalBranchId(branchName);
  if (branchId === "cafeteria_chicolin") return "Cafeteria Chicolin";
  if (branchId === "mr_lin_restaurante") return "Mr Lin Restaurante";
  return cleanText(branchName || "Sin sucursal", 120) || "Sin sucursal";
}

function resolvePublicGoalSaleDate(saleData = {}) {
  return resolveSaleDate(saleData.fechaMetaPublica)
    || resolveSaleDate(saleData.fechaPago)
    || resolveSaleDate(saleData.fechaConfirmacionCaja)
    || resolveSaleDate(saleData.fecha)
    || new Date();
}

function buildPublicGoalDelta(saleData = {}, direction = 1) {
  if (saleData?.metaPublicaRegistrada === true) return null;
  if (!saleCountsForPublicGoal(saleData)) return null;
  const branchName = cleanText(saleData.sucursal || "Sin sucursal", 120) || "Sin sucursal";
  const date = resolvePublicGoalSaleDate(saleData);
  const dateKey = getDateKeyInTimezone(date, BUSINESS_TIMEZONE);
  if (!dateKey) return null;
  const total = cleanNumber(saleData.total, 0) * direction;
  return {
    branchId: getPublicGoalBranchId(branchName),
    branchName: getPublicGoalBranchName(branchName),
    dateKey,
    month: dateKey.slice(0, 7),
    day: Number(dateKey.slice(-2)),
    total
  };
}

function mergePublicGoalDelta(target, delta) {
  if (!delta || !delta.branchId || !delta.dateKey || delta.total === 0) return;
  if (!target.has(delta.branchId)) {
    target.set(delta.branchId, {
      branchId: delta.branchId,
      branchName: delta.branchName,
      month: delta.month,
      increments: new Map()
    });
  }
  const current = target.get(delta.branchId);
  current.branchName = delta.branchName || current.branchName;
  current.month = delta.month || current.month;
  current.increments.set(delta.dateKey, (current.increments.get(delta.dateKey) || 0) + delta.total);
}

function createPublicBranchMetric(branchName, monthInfo) {
  const daysInMonth = getDaysInMonth(monthInfo.year, monthInfo.month);
  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const dateKey = `${monthInfo.key}-${String(day).padStart(2, "0")}`;
    return {
      date: dateKey,
      day,
      total: 0,
      reached: false
    };
  });

  return {
    id: normalizeDocKey(branchName),
    name: branchName,
    totalMonth: 0,
    monthlyGoalHits: 0,
    reachedDates: [],
    days
  };
}

function finalizePublicBranchMetric(metric) {
  metric.days.forEach((day) => {
    day.reached = day.total >= PUBLIC_GOAL_AMOUNT;
  });
  metric.totalMonth = metric.days.reduce((sum, day) => sum + Number(day.total || 0), 0);
  metric.reachedDates = metric.days.filter((day) => day.reached).map((day) => day.date);
  metric.monthlyGoalHits = metric.reachedDates.length;
  return metric;
}

function buildCashFlowContribution(saleId, saleData = {}) {
  const turnoId = cleanText(saleData.turnoId, 180);
  const sucursal = cleanText(saleData.sucursal, 120);
  if (!turnoId || !sucursal || saleData.arqueado === true || saleData.marcadoComoAbonado === true) return null;
  if (saleData.tipoTransaccion === "abono_deuda" || saleData.tipoTransaccion === "producto_gratis" || saleData.noAfectaCaja === true) return null;

  const estadoPago = normalizeText(saleData.estadoPago || saleData.estado);
  const estadoCocina = normalizeText(saleData.estadoCocina);
  const estadoDelivery = normalizeText(saleData.estadoDelivery);
  if (["anulado", "cancelado", "rechazado"].includes(estadoPago) || estadoCocina === "anulado" || estadoDelivery === "anulado") return null;

  const metodoPago = normalizeText(saleData.metodoPago || saleData.metodoPagoSolicitado);
  const esPagado = estadoPago === "pagado";
  const esPendiente = estadoPago === "pendiente" && (saleData.origenCuentaPendiente === true || metodoPago === "por cobrar");
  if (!esPagado && !esPendiente) return null;

  const total = Math.max(0, cleanNumber(saleData.total, 0));
  let efectivo = 0;
  let tarjetaPOS = 0;
  let transferencia = 0;
  let credito = 0;

  if (esPagado && metodoPago === "mixto" && saleData.detallesPago) {
    efectivo = Math.max(0, cleanNumber(saleData.detallesPago.efectivo, 0));
    tarjetaPOS = Math.max(0, cleanNumber(saleData.detallesPago.tarjeta, 0));
    transferencia = Math.max(0, cleanNumber(saleData.detallesPago.transferencia, 0));
  } else if (esPagado && metodoPago === "efectivo") {
    efectivo = total;
  } else if (esPagado && ["tarjeta", "pos", "tarjeta pos"].includes(metodoPago)) {
    tarjetaPOS = total;
  } else if (esPagado && metodoPago === "transferencia") {
    transferencia = total;
  } else if (esPagado && isCreditMethod(metodoPago)) {
    credito = total;
  }

  const totalInmediato = efectivo + tarjetaPOS + transferencia;
  const ventaTotalBruta = totalInmediato + credito;
  const visibleEnFlujo = totalInmediato > 0 || esPendiente;
  const totalProductos = (Array.isArray(saleData.items) ? saleData.items : [])
    .reduce((sum, item) => sum + Math.max(0, cleanNumber(item?.cantidad, 0)), 0);
  const fechaVenta = resolveSaleDate(saleData.fecha || saleData.createdAt) || new Date();
  const fechaApertura = resolveSaleDate(saleData.fechaAperturaTurno) || fechaVenta;

  return {
    saleId: String(saleId || ""),
    summaryId: turnoId,
    turnoId,
    sucursal,
    sucursalId: normalizeDocKey(sucursal),
    fechaOperativa: getDateKeyInTimezone(fechaApertura),
    fechaAperturaMs: fechaApertura.getTime(),
    ventaTotalBruta,
    efectivo,
    tarjetaPOS,
    transferencia,
    credito,
    totalProductos,
    totalTickets: 1,
    totalTicketsFlujo: visibleEnFlujo ? 1 : 0,
    totalTicketsPagados: esPagado ? 1 : 0,
    totalTicketsPendientes: esPendiente ? 1 : 0
  };
}

function cashFlowContributionChanged(previous, next) {
  if (!previous && !next) return false;
  if (!previous || !next) return true;
  const fields = ["summaryId", "turnoId", "sucursal", "sucursalId", "fechaOperativa", "fechaAperturaMs", ...CASH_FLOW_FIELDS];
  return fields.some((field) => previous[field] !== next[field]);
}

function cashFlowSummaryPayload(current = {}, contribution = {}, deltas = {}) {
  const payload = {
    turnoId: contribution.turnoId || current.turnoId || "",
    sucursal: contribution.sucursal || current.sucursal || "",
    sucursalId: contribution.sucursalId || current.sucursalId || "general",
    fechaOperativa: contribution.fechaOperativa || current.fechaOperativa || "",
    fechaApertura: contribution.fechaAperturaMs
      ? admin.firestore.Timestamp.fromMillis(contribution.fechaAperturaMs)
      : (current.fechaApertura || admin.firestore.FieldValue.serverTimestamp()),
    sucursalesActivas: 1,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    origen: "sales_materialized_view",
    version: 1
  };

  CASH_FLOW_FIELDS.forEach((field) => {
    payload[field] = Math.max(0, cleanNumber(current[field], 0) + cleanNumber(deltas[field], 0));
  });
  const cierreConfirmado = current.estadoTurno === "cerrado" || Boolean(current.closedAt) || Boolean(current.cierreCajaId);
  const aperturaRegistrada = current.estadoTurno === "abierto" || current.aperturaRegistrada === true || current.fondoInicial !== undefined;
  payload.estadoTurno = cierreConfirmado ? "cerrado" : (payload.totalTickets > 0 || aperturaRegistrada ? "abierto" : "cerrado");
  if (payload.estadoTurno === "cerrado") payload.closedAt = admin.firestore.FieldValue.serverTimestamp();
  return payload;
}

function serializeCurrentFlowSale(saleId, saleData = {}) {
  const fecha = resolveSaleDate(saleData.fecha || saleData.createdAt);
  const fechaAperturaTurno = resolveSaleDate(saleData.fechaAperturaTurno);
  const fechaConfirmacionCaja = resolveSaleDate(saleData.fechaConfirmacionCaja);
  return {
    id: String(saleId || ""),
    ticket_id: cleanText(saleData.ticket_id, 120),
    sucursal: cleanText(saleData.sucursal, 120),
    sucursalId: cleanText(saleData.sucursalId, 120),
    turnoId: cleanText(saleData.turnoId, 180),
    cajero: cleanText(saleData.cajero, 160),
    cliente: cleanText(saleData.cliente, 160),
    nombreCliente: cleanText(saleData.nombreCliente, 160),
    aliasReferencia: cleanText(saleData.aliasReferencia, 160),
    observacion: cleanText(saleData.observacion, 500),
    metodoPago: cleanText(saleData.metodoPago, 80),
    metodoPagoSolicitado: cleanText(saleData.metodoPagoSolicitado, 80),
    estadoPago: cleanText(saleData.estadoPago, 80),
    estadoCocina: cleanText(saleData.estadoCocina, 80),
    estadoDelivery: cleanText(saleData.estadoDelivery, 80),
    tipoTransaccion: cleanText(saleData.tipoTransaccion, 100),
    total: Math.max(0, cleanNumber(saleData.total, 0)),
    detallesPago: saleData.detallesPago && typeof saleData.detallesPago === "object" ? {
      efectivo: Math.max(0, cleanNumber(saleData.detallesPago.efectivo, 0)),
      tarjeta: Math.max(0, cleanNumber(saleData.detallesPago.tarjeta, 0)),
      transferencia: Math.max(0, cleanNumber(saleData.detallesPago.transferencia, 0))
    } : null,
    items: Array.isArray(saleData.items) ? saleData.items.map((item) => ({
      nombre: cleanText(item?.nombre, 180),
      cantidad: Math.max(0, cleanNumber(item?.cantidad, 0)),
      obsProd: cleanText(item?.obsProd, 300)
    })) : [],
    arqueado: saleData.arqueado === true,
    marcadoComoAbonado: saleData.marcadoComoAbonado === true,
    origenCuentaPendiente: saleData.origenCuentaPendiente === true,
    noAfectaCaja: saleData.noAfectaCaja === true,
    fecha: fecha ? fecha.getTime() : 0,
    fechaAperturaTurno: fechaAperturaTurno ? fechaAperturaTurno.getTime() : 0,
    fechaConfirmacionCaja: fechaConfirmacionCaja ? fechaConfirmacionCaja.getTime() : 0
  };
}

function getCurrentFlowSalesSnapshot(salesDocs = []) {
  const groups = new Map();
  salesDocs.forEach((saleDoc) => {
    const sale = saleDoc.data() || {};
    const saleDate = resolveSaleDate(sale.fecha || sale.createdAt) || new Date(0);
    const contribution = buildCashFlowContribution(saleDoc.id, sale);
    if (!contribution || contribution.credito > 0) return;
    const groupKey = `${contribution.sucursalId}|${contribution.turnoId}`;
    const current = groups.get(groupKey) || {
      turnoId: contribution.turnoId,
      sucursal: contribution.sucursal,
      sucursalId: contribution.sucursalId,
      updatedAt: 0,
      sales: [],
      summary: {
        turnoId: contribution.turnoId,
        sucursal: contribution.sucursal,
        sucursalId: contribution.sucursalId,
        ventaTotalBruta: 0,
        efectivo: 0,
        tarjetaPOS: 0,
        transferencia: 0,
        credito: 0,
        totalProductos: 0,
        totalTickets: 0,
        totalTicketsFlujo: 0,
        totalTicketsPagados: 0,
        totalTicketsPendientes: 0
      }
    };
    current.updatedAt = Math.max(current.updatedAt, saleDate.getTime());
    current.sales.push(serializeCurrentFlowSale(saleDoc.id, sale));
    CASH_FLOW_FIELDS.forEach((field) => {
      current.summary[field] += Math.max(0, cleanNumber(contribution[field], 0));
    });
    groups.set(groupKey, current);
  });

  const currentByBranch = new Map();
  groups.forEach((group) => {
    const previous = currentByBranch.get(group.sucursalId);
    if (!previous || group.updatedAt > previous.updatedAt) currentByBranch.set(group.sucursalId, group);
  });

  const activeGroups = Array.from(currentByBranch.values());
  return {
    summaries: activeGroups.map((group) => ({
      ...group.summary,
      estadoTurno: "abierto",
      updatedAt: group.updatedAt,
      origen: "sales_server_snapshot"
    })),
    sales: activeGroups.flatMap((group) => group.sales)
      .sort((a, b) => Number(b.fecha || 0) - Number(a.fecha || 0))
  };
}

function isForcedCloseCandidate(saleData = {}, branchName = "") {
  if (normalizeText(saleData.sucursal) !== normalizeText(branchName)) return false;
  if (saleData.arqueado === true || saleData.marcadoComoAbonado === true) return false;
  if (saleData.tipoTransaccion === "abono_deuda" || saleData.tipoTransaccion === "producto_gratis" || saleData.noAfectaCaja === true) return false;
  const estadoPago = normalizeText(saleData.estadoPago || saleData.estado);
  const estadoCocina = normalizeText(saleData.estadoCocina);
  const estadoDelivery = normalizeText(saleData.estadoDelivery);
  if (["anulado", "cancelado", "rechazado"].includes(estadoPago) || estadoCocina === "anulado" || estadoDelivery === "anulado") return false;
  return ["pagado", "pendiente"].includes(estadoPago);
}

function getForcedCloseSalesGroup(salesDocs = [], branchName = "") {
  const groups = new Map();
  salesDocs.forEach((saleDoc) => {
    const sale = saleDoc.data() || {};
    if (!isForcedCloseCandidate(sale, branchName)) return;
    const turnoId = cleanText(sale.turnoId, 180);
    if (!turnoId) return;
    const fecha = resolveSaleDate(sale.fecha || sale.createdAt) || new Date(0);
    const group = groups.get(turnoId) || { turnoId, updatedAt: 0, sales: [] };
    group.updatedAt = Math.max(group.updatedAt, fecha.getTime());
    group.sales.push({ saleDoc, fecha });
    groups.set(turnoId, group);
  });

  const activeGroup = Array.from(groups.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return activeGroup || null;
}

function getForcedCloseSalesSnapshot(salesDocs = [], branchName = "") {
  const activeGroup = getForcedCloseSalesGroup(salesDocs, branchName);
  if (!activeGroup) return { turnoId: "", tickets: [], updatedAt: 0 };

  return {
    turnoId: activeGroup.turnoId,
    updatedAt: activeGroup.updatedAt,
    tickets: activeGroup.sales
      .sort((a, b) => a.fecha.getTime() - b.fecha.getTime())
      .map(({ saleDoc }) => serializeCurrentFlowSale(saleDoc.id, saleDoc.data() || {}))
  };
}

function getForcedCloseTotals(salesDocs = []) {
  return salesDocs.reduce((totals, saleDoc) => {
    const contribution = buildCashFlowContribution(saleDoc.id, saleDoc.data() || {});
    if (!contribution) return totals;
    totals.efectivo += Math.max(0, cleanNumber(contribution.efectivo, 0));
    totals.tarjeta += Math.max(0, cleanNumber(contribution.tarjetaPOS, 0));
    totals.transferencia += Math.max(0, cleanNumber(contribution.transferencia, 0));
    totals.credito += Math.max(0, cleanNumber(contribution.credito, 0));
    return totals;
  }, { efectivo: 0, tarjeta: 0, transferencia: 0, credito: 0 });
}

function getForcedCloseProducts(salesDocs = []) {
  const products = {};
  salesDocs.forEach((saleDoc) => {
    const sale = saleDoc.data() || {};
    (Array.isArray(sale.items) ? sale.items : []).forEach((item) => {
      const name = cleanText(item?.nombre, 180) || "Producto";
      const quantity = Math.max(0, cleanNumber(item?.cantidad, 0));
      const price = Math.max(0, cleanNumber(item?.precioAplicado ?? item?.precio, 0));
      if (!products[name]) products[name] = { cant: 0, total: 0 };
      products[name].cant += quantity;
      products[name].total += quantity * price;
    });
  });
  return products;
}

exports.registrarAperturaCaja = onCall(
  {
    region: "us-central1",
    cors: true
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesion para abrir la caja.");
    }

    const role = await getUserRole(request.auth.uid);
    if (!['admin', 'cajero'].includes(role)) {
      throw new HttpsError("permission-denied", "No tienes permiso para abrir esta caja.");
    }

    const turnoId = cleanText(request.data?.turnoId, 180);
    const sucursal = cleanText(request.data?.sucursal, 180);
    const cajero = cleanText(request.data?.cajero, 180) || request.auth.token?.name || request.auth.uid;
    const fondoInicial = Math.max(0, cleanNumber(request.data?.fondoInicial, 0));
    if (!turnoId || !sucursal) {
      throw new HttpsError("invalid-argument", "Faltan la sucursal o el turno.");
    }

    const turnoRef = db.collection(CASH_FLOW_COLLECTION).doc(turnoId);
    const existing = await turnoRef.get();
    if (existing.exists && existing.data()?.estadoTurno === "cerrado") {
      throw new HttpsError("failed-precondition", "Ese turno ya fue cerrado.");
    }

    const aperturaMs = Date.now();
    await turnoRef.set({
      turnoId,
      sucursal,
      sucursalId: normalizeDocKey(sucursal),
      cajeroId: request.auth.uid,
      cajero,
      fondoInicial,
      fechaApertura: admin.firestore.Timestamp.fromMillis(aperturaMs),
      fechaAperturaMs: aperturaMs,
      aperturaRegistrada: true,
      estadoTurno: "abierto",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      origenApertura: "pos"
    }, { merge: true });

    logger.info("Apertura de caja persistida", { turnoId, sucursal, cajeroId: request.auth.uid, fondoInicial });
    return { ok: true, turnoId, fondoInicial, fechaAperturaMs: aperturaMs };
  }
);

exports.marcarFlujoTurnoCerrado = onDocumentCreated(
  {
    region: "us-central1",
    document: "cierresCaja/{cierreId}",
    retry: true
  },
  async (event) => {
    const cierre = event.data?.data() || {};
    const turnoId = cleanText(cierre.turnoId, 180);
    if (!turnoId) return;

    await db.collection(CASH_FLOW_COLLECTION).doc(turnoId).set({
      turnoId,
      estadoTurno: "cerrado",
      cierreCajaId: event.params.cierreId,
      closedAt: cierre.fechaCierre || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    logger.info("Flujo de turno marcado como cerrado", { turnoId, cierreId: event.params.cierreId });
  }
);

async function syncCashFlowFromCurrentSale(saleId, saleRef) {
  const contributionRef = db.collection(CASH_FLOW_CONTRIBUTIONS_COLLECTION).doc(saleId);

  await db.runTransaction(async (transaction) => {
    const [saleSnap, contributionSnap] = await Promise.all([
      transaction.get(saleRef),
      transaction.get(contributionRef)
    ]);
    const previous = contributionSnap.exists ? contributionSnap.data() : null;
    const next = saleSnap.exists ? buildCashFlowContribution(saleId, saleSnap.data() || {}) : null;
    if (!cashFlowContributionChanged(previous, next)) return;

    const affectedIds = Array.from(new Set([previous?.summaryId, next?.summaryId].filter(Boolean)));
    const summarySnapshots = new Map();
    for (const summaryId of affectedIds) {
      const summaryRef = db.collection(CASH_FLOW_COLLECTION).doc(summaryId);
      summarySnapshots.set(summaryId, {
        ref: summaryRef,
        snap: await transaction.get(summaryRef)
      });
    }

    for (const summaryId of affectedIds) {
      const previousForSummary = previous?.summaryId === summaryId ? previous : null;
      const nextForSummary = next?.summaryId === summaryId ? next : null;
      const deltas = {};
      CASH_FLOW_FIELDS.forEach((field) => {
        deltas[field] = cleanNumber(nextForSummary?.[field], 0) - cleanNumber(previousForSummary?.[field], 0);
      });
      const entry = summarySnapshots.get(summaryId);
      const current = entry.snap.exists ? (entry.snap.data() || {}) : {};
      transaction.set(entry.ref, cashFlowSummaryPayload(current, nextForSummary || previousForSummary || {}, deltas), { merge: true });
    }

    if (next) {
      transaction.set(contributionRef, {
        ...next,
        sourceUpdatedAt: saleSnap.updateTime || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } else if (contributionSnap.exists) {
      transaction.delete(contributionRef);
    }
  });
}

function summarizeCashFlowContributions(contributions = [], turnoId = "") {
  const summary = {
    turnoId,
    sucursal: "",
    sucursalId: "general",
    fechaOperativa: "",
    fechaAperturaMs: 0
  };
  CASH_FLOW_FIELDS.forEach((field) => { summary[field] = 0; });
  contributions.forEach((entry) => {
    summary.sucursal = summary.sucursal || entry.sucursal;
    summary.sucursalId = entry.sucursalId || summary.sucursalId;
    summary.fechaOperativa = summary.fechaOperativa || entry.fechaOperativa;
    if (!summary.fechaAperturaMs || entry.fechaAperturaMs < summary.fechaAperturaMs) summary.fechaAperturaMs = entry.fechaAperturaMs;
    CASH_FLOW_FIELDS.forEach((field) => { summary[field] += cleanNumber(entry[field], 0); });
  });
  return summary;
}

exports.solicitarCodigoRecuperacion = onCall(
  {
    region: "us-central1",
    cors: true,
    secrets: [SMTP_HOST, SMTP_USER, SMTP_PASS, PASSWORD_RESET_OTP_PEPPER]
  },
  async (request) => {
    const email = normalizePasswordResetEmail(request.data?.email);
    if (!passwordResetEmailIsValid(email)) {
      throw new HttpsError("invalid-argument", "Correo electronico invalido.");
    }

    const now = Date.now();
    const emailHash = passwordResetDocId(email);
    const ipHash = passwordResetDocId(request.rawRequest?.ip || "unknown");
    const otpRef = db.collection("passwordResetOtps").doc(emailHash);
    const rateRef = db.collection("passwordResetRateLimits").doc(ipHash);
    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = passwordResetCodeHash(email, code, PASSWORD_RESET_OTP_PEPPER.value());
    let user = null;

    try {
      user = await admin.auth().getUserByEmail(email);
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }

    const rateResult = await db.runTransaction(async (transaction) => {
      const [otpSnap, rateSnap] = await Promise.all([
        transaction.get(otpRef),
        transaction.get(rateRef)
      ]);
      const previous = otpSnap.exists ? (otpSnap.data() || {}) : {};
      const lastSentAt = passwordResetTimestampMillis(previous.sentAt);
      if (lastSentAt && now - lastSentAt < PASSWORD_RESET_RESEND_MS) {
        return { allowed: false, reason: "cooldown", waitSeconds: Math.ceil((PASSWORD_RESET_RESEND_MS - (now - lastSentAt)) / 1000) };
      }

      const rate = rateSnap.exists ? (rateSnap.data() || {}) : {};
      const windowStartedAt = passwordResetTimestampMillis(rate.windowStartedAt);
      const sameWindow = windowStartedAt && now - windowStartedAt < PASSWORD_RESET_CODE_TTL_MS;
      const requestCount = sameWindow ? Number(rate.requestCount || 0) : 0;
      if (requestCount >= 10) {
        return { allowed: false, reason: "rate-limit", waitSeconds: 900 };
      }

      transaction.set(rateRef, {
        requestCount: requestCount + 1,
        windowStartedAt: admin.firestore.Timestamp.fromMillis(sameWindow ? windowStartedAt : now),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(now + 24 * 60 * 60 * 1000)
      }, { merge: true });

      transaction.set(otpRef, {
        emailHash,
        userId: user?.uid || null,
        codeHash,
        attempts: 0,
        maxAttempts: PASSWORD_RESET_MAX_ATTEMPTS,
        status: "active",
        used: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        sentAt: admin.firestore.Timestamp.fromMillis(now),
        expiresAt: admin.firestore.Timestamp.fromMillis(now + PASSWORD_RESET_CODE_TTL_MS),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        deliveryStatus: user ? "pending" : "not_applicable",
        userAgent: String(request.rawRequest?.get?.("user-agent") || "").slice(0, 300)
      }, { merge: false });

      return { allowed: true };
    });

    if (!rateResult.allowed) {
      throw new HttpsError(
        "resource-exhausted",
        rateResult.reason === "cooldown"
          ? `Espera ${rateResult.waitSeconds} segundos antes de solicitar otro codigo.`
          : "Demasiadas solicitudes. Intenta nuevamente en 15 minutos."
      );
    }

    if (user) {
      const smtpPort = Number(process.env.SMTP_PORT || 465);
      const transporter = nodemailer.createTransport({
        host: SMTP_HOST.value(),
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
          user: SMTP_USER.value(),
          pass: SMTP_PASS.value()
        },
        tls: { minVersion: "TLSv1.2" }
      });

      try {
        await transporter.sendMail({
          from: `Club Lin <${SMTP_USER.value()}>`,
          to: email,
          subject: "Codigo para cambiar tu contrasena de Club Lin",
          text: `Tu codigo de recuperacion es ${code}. Es valido durante 15 minutos. Si no solicitaste este cambio, ignora este mensaje.`,
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:28px;background:#111827;color:#f8fafc;border-radius:16px"><div style="text-align:center;margin-bottom:18px"><img src="${PUBLIC_APP_LOGO_URL}" width="88" height="88" alt="Club Lin" style="display:inline-block;width:88px;height:88px;object-fit:contain;border-radius:18px;background:#000"></div><h2 style="margin:0 0 12px;color:#f59e0b;text-align:center">Club Lin</h2><p>Usa este codigo para cambiar tu contrasena:</p><div style="font-size:34px;font-weight:800;letter-spacing:8px;text-align:center;padding:20px;margin:18px 0;background:#1f2937;border:1px solid #d97706;border-radius:12px">${code}</div><p>El codigo vence en 15 minutos y solo puede utilizarse una vez.</p><p style="font-size:12px;color:#cbd5e1">Si no solicitaste este cambio, ignora este mensaje.</p></div>`
        });
        await otpRef.set({
          deliveryStatus: "sent",
          deliveredAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (error) {
        logger.error("No se pudo enviar el codigo de recuperacion", { emailHash, error: error.message });
        await otpRef.set({
          status: "delivery_failed",
          deliveryStatus: "failed",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        throw new HttpsError("unavailable", "No pudimos enviar el codigo. Intenta nuevamente mas tarde.");
      }
    }

    return {
      ok: true,
      expiresInSeconds: PASSWORD_RESET_CODE_TTL_MS / 1000,
      message: "Si el correo esta registrado, recibiras un codigo de 6 digitos."
    };
  }
);

exports.restablecerPasswordConCodigo = onCall(
  {
    region: "us-central1",
    cors: true,
    secrets: [PASSWORD_RESET_OTP_PEPPER]
  },
  async (request) => {
    const email = normalizePasswordResetEmail(request.data?.email);
    const code = String(request.data?.code || "").replace(/\D/g, "").slice(0, 6);
    const newPassword = String(request.data?.newPassword || "");
    if (!passwordResetEmailIsValid(email) || !/^\d{6}$/.test(code)) {
      throw new HttpsError("invalid-argument", "Correo o codigo invalido.");
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      throw new HttpsError("invalid-argument", "La nueva contrasena debe tener entre 8 y 128 caracteres.");
    }

    const now = Date.now();
    const emailHash = passwordResetDocId(email);
    const otpRef = db.collection("passwordResetOtps").doc(emailHash);
    const expectedHash = passwordResetCodeHash(email, code, PASSWORD_RESET_OTP_PEPPER.value());
    const processingToken = crypto.randomBytes(24).toString("hex");

    const verification = await db.runTransaction(async (transaction) => {
      const otpSnap = await transaction.get(otpRef);
      if (!otpSnap.exists) return { valid: false, reason: "invalid" };
      const otp = otpSnap.data() || {};
      const expiresAt = passwordResetTimestampMillis(otp.expiresAt);
      const attempts = Number(otp.attempts || 0);
      if (otp.status === "consumed" || otp.used === true) return { valid: false, reason: "consumed" };
      if (otp.status === "delivery_failed") return { valid: false, reason: "delivery_failed" };
      if (!expiresAt || now > expiresAt) {
        transaction.set(otpRef, { status: "expired", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return { valid: false, reason: "expired" };
      }
      if (attempts >= PASSWORD_RESET_MAX_ATTEMPTS) return { valid: false, reason: "blocked" };
      if (otp.status === "processing" && passwordResetTimestampMillis(otp.processingUntil) > now) {
        return { valid: false, reason: "processing" };
      }

      const storedHash = Buffer.from(String(otp.codeHash || ""), "hex");
      const candidateHash = Buffer.from(expectedHash, "hex");
      const valid = storedHash.length === candidateHash.length && crypto.timingSafeEqual(storedHash, candidateHash);
      if (!valid) {
        transaction.set(otpRef, {
          attempts: attempts + 1,
          status: attempts + 1 >= PASSWORD_RESET_MAX_ATTEMPTS ? "blocked" : "active",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return { valid: false, reason: attempts + 1 >= PASSWORD_RESET_MAX_ATTEMPTS ? "blocked" : "invalid" };
      }

      transaction.set(otpRef, {
        status: "processing",
        processingToken,
        processingUntil: admin.firestore.Timestamp.fromMillis(now + PASSWORD_RESET_PROCESSING_MS),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return { valid: true, userId: otp.userId || null };
    });

    if (!verification.valid) throw passwordResetError(verification.reason);

    let user = null;
    try {
      user = verification.userId
        ? await admin.auth().getUser(verification.userId)
        : await admin.auth().getUserByEmail(email);
      if (normalizePasswordResetEmail(user.email) !== email) {
        throw new Error("El correo del usuario no coincide con la solicitud.");
      }
      await admin.auth().updateUser(user.uid, { password: newPassword });
    } catch (error) {
      logger.error("No se pudo restablecer la contrasena", { emailHash, error: error.message });
      try {
        await otpRef.set({
          status: "active",
          processingToken: admin.firestore.FieldValue.delete(),
          processingUntil: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (unlockError) {
        logger.error("No se pudo liberar la solicitud OTP despues del error", { emailHash, error: unlockError.message });
      }
      if (error.code === "auth/user-not-found") throw passwordResetError("user_not_found");
      if (error.code === "auth/invalid-password") {
        throw new HttpsError("invalid-argument", "La nueva contrasena no cumple los requisitos de seguridad.", { reason: "invalid_password" });
      }
      if (error.code === "auth/insufficient-permission") {
        throw new HttpsError("permission-denied", "El servicio no tiene permiso para actualizar la cuenta.", { reason: "auth_permission" });
      }
      if (["auth/internal-error", "auth/network-request-failed"].includes(error.code)) {
        throw new HttpsError("unavailable", "No pudimos conectar con Firebase Authentication.", { reason: "network" });
      }
      throw new HttpsError("internal", "No pudimos cambiar la contrasena. Intenta nuevamente.", { reason: "internal" });
    }

    try {
      await admin.auth().revokeRefreshTokens(user.uid);
    } catch (revokeError) {
      logger.warn("La contrasena cambio pero no se pudieron revocar sesiones previas", { emailHash, error: revokeError.message });
    }

    try {
      await markPasswordResetConsumed(otpRef, processingToken);
    } catch (finalizeError) {
      logger.error("La contrasena cambio pero no se pudo finalizar el codigo OTP", {
        emailHash,
        error: finalizeError.message
      });
    }
    return { ok: true };
  }
);

exports.health = onRequest(
  {
    region: "us-central1",
    cors: true
  },
  async (req, res) => {
    try {
      const appId = normalizeDocKey(req.query?.app || req.body?.app || "sistema");
      const selectedApp = CONTROL_CENTER_APPS[appId] || null;
      const recentAlertsSnap = await db.collection("systemAlerts")
        .orderBy("creadoAt", "desc")
        .limit(250)
        .get();
      const recentAlerts = recentAlertsSnap.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data()
      }));
      const unresolvedAlerts = recentAlerts.filter((alert) => normalizeText(alert.estado || "abierta") !== "resuelta");
      const filteredAlerts = selectedApp
        ? unresolvedAlerts.filter((alert) => resolveAlertModule(alert) === selectedApp.module)
        : unresolvedAlerts;
      const criticalAlerts = filteredAlerts.filter((alert) => {
        const level = normalizeText(alert.nivel);
        return level === "critical" || level === "error";
      });
      const healthDocSnap = await db.doc("health/status").get().catch(() => null);
      const latestAlert = filteredAlerts[0] || recentAlerts[0] || null;

      res.status(200).json({
        ok: criticalAlerts.length === 0,
        projectId: PROJECT_ID,
        monitoredAt: new Date().toISOString(),
        app: selectedApp ? {
          id: selectedApp.id,
          name: selectedApp.name,
          module: selectedApp.module,
          url: selectedApp.url
        } : {
          id: "sistema",
          name: "SISTEMA",
          module: "SISTEMA",
          url: "https://sys-pos-erp-lingroup.web.app/"
        },
        firestore: {
          enabled: true,
          healthDocumentPath: "health/status",
          healthDocumentExists: Boolean(healthDocSnap && healthDocSnap.exists),
          lastDocumentUpdate: healthDocSnap?.exists
            ? (healthDocSnap.data()?.updatedAt?.toDate?.()?.toISOString?.() || null)
            : null
        },
        storage: {
          enabled: true,
          bucket: "sys-pos-erp-lingroup.firebasestorage.app"
        },
        alerts: {
          open: filteredAlerts.length,
          critical: criticalAlerts.length,
          lastAlertAt: latestAlert?.creadoAt?.toDate?.()?.toISOString?.() || null
        },
        config: buildControlCenterHealthConfig()
      });
    } catch (error) {
      logger.error("health endpoint error", { message: error?.message || String(error) });
      res.status(500).json({
        ok: false,
        projectId: PROJECT_ID,
        monitoredAt: new Date().toISOString(),
        error: error?.message || "unknown_error"
      });
    }
  }
);

exports.publicGoalMetrics = onRequest(
  {
    region: "us-central1",
    cors: true
  },
  async (req, res) => {
    const allowedOrigins = new Set([
      "https://sys-pos-erp-lingroup.web.app",
      "https://sys-pos-erp-lingroup.firebaseapp.com",
      "http://localhost:5000",
      "http://localhost:5173"
    ]);
    const origin = req.get("origin");
    res.set("Access-Control-Allow-Origin", allowedOrigins.has(origin) ? origin : "https://sys-pos-erp-lingroup.web.app");
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set("Access-Control-Max-Age", "3600");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    try {
      const monthInfo = parseMonthInput(req.query?.month || req.body?.month);
      const range = getMonthRange(monthInfo);

      const branchSnap = await db.collection("branches").get().catch(() => null);
      const branchMap = new Map();
      if (branchSnap) {
        branchSnap.forEach((docSnap) => {
          const branchName = cleanText(docSnap.data()?.nombre || docSnap.id, 120);
          if (branchName) branchMap.set(branchName, createPublicBranchMetric(branchName, monthInfo));
        });
      }

      const salesSnap = await db.collection(SALES_COLLECTION_PATH)
        .where("fecha", ">=", range.widenedStart)
        .where("fecha", "<", range.widenedEnd)
        .get();

      salesSnap.forEach((docSnap) => {
        const sale = docSnap.data() || {};
        if (!saleCountsForPublicGoal(sale)) return;

        const saleDate = resolvePublicGoalSaleDate(sale);
        const dateKey = getDateKeyInTimezone(saleDate, BUSINESS_TIMEZONE);
        if (!dateKey || !dateKey.startsWith(`${monthInfo.key}-`)) return;

        const branchName = cleanText(sale.sucursal || "Sin sucursal", 120) || "Sin sucursal";
        if (!branchMap.has(branchName)) {
          branchMap.set(branchName, createPublicBranchMetric(branchName, monthInfo));
        }

        const metric = branchMap.get(branchName);
        const dayIndex = Number(dateKey.slice(-2)) - 1;
        if (!metric || dayIndex < 0 || dayIndex >= metric.days.length) return;

        metric.days[dayIndex].total += cleanNumber(sale.total, 0);
      });

      const branches = Array.from(branchMap.values())
        .map((metric) => finalizePublicBranchMetric(metric))
        .sort((a, b) => a.name.localeCompare(b.name, "es"));

      res.set("Cache-Control", "no-store, max-age=0");
      res.status(200).json({
        ok: true,
        projectId: PROJECT_ID,
        timezone: BUSINESS_TIMEZONE,
        goalAmount: PUBLIC_GOAL_AMOUNT,
        month: monthInfo.key,
        monthLabel: getMonthLabel(monthInfo),
        generatedAt: new Date().toISOString(),
        branches
      });
    } catch (error) {
      logger.error("publicGoalMetrics error", { message: error?.message || String(error) });
      res.status(500).json({
        ok: false,
        projectId: PROJECT_ID,
        error: error?.message || "unknown_error"
      });
    }
  }
);

exports.sincronizarMetasPublicasVentas = onDocumentWritten(
  {
    region: "us-central1",
    document: `${SALES_COLLECTION_PATH}/{saleId}`
  },
  async (event) => {
    const before = event.data?.before?.exists ? (event.data.before.data() || {}) : null;
    const after = event.data?.after?.exists ? (event.data.after.data() || {}) : null;
    const deltas = new Map();

    mergePublicGoalDelta(deltas, buildPublicGoalDelta(before, -1));
    mergePublicGoalDelta(deltas, buildPublicGoalDelta(after, 1));

    if (deltas.size === 0) return;

    const batch = db.batch();
    deltas.forEach((entry) => {
      const payload = {
        branchId: entry.branchId,
        branchName: entry.branchName,
        dailyGoal: PUBLIC_GOAL_AMOUNT,
        monthlyGoal: PUBLIC_GOAL_AMOUNT,
        month: entry.month,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      entry.increments.forEach((amount, dateKey) => {
        if (!amount) return;
        payload.monthlyTotal = admin.firestore.FieldValue.increment(amount);
        payload[`dailyTotals.${dateKey}`] = admin.firestore.FieldValue.increment(amount);
        payload.lastSaleAt = admin.firestore.FieldValue.serverTimestamp();
        payload.lastSaleTotal = Math.max(0, amount);
        payload.lastSaleDay = Number(dateKey.slice(-2));
      });

      batch.set(db.collection("publicGoals").doc(entry.branchId), payload, { merge: true });
    });

    await batch.commit();
  }
);

exports.sincronizarResumenFlujoTurno = onDocumentWritten(
  {
    region: "us-central1",
    document: `${SALES_COLLECTION_PATH}/{saleId}`,
    retry: true
  },
  async (event) => {
    const saleRef = event.data?.after?.ref || event.data?.before?.ref;
    if (!saleRef) return;
    await syncCashFlowFromCurrentSale(event.params.saleId, saleRef);
  }
);

exports.reconciliarFlujoTurno = onCall(
  {
    region: "us-central1",
    cors: true,
    timeoutSeconds: 120,
    memory: "256MiB"
  },
  async (request) => {
    if (!request.auth?.uid || await getUserRole(request.auth.uid) !== "admin") {
      throw new HttpsError("permission-denied", "Solo administracion puede reconciliar el flujo de un turno.");
    }

    const turnoId = cleanText(request.data?.turnoId, 180);
    if (!turnoId) throw new HttpsError("invalid-argument", "Debes indicar el turnoId a reconciliar.");

    const salesSnap = await db.collection(SALES_COLLECTION_PATH).where("turnoId", "==", turnoId).get();
    const contributions = salesSnap.docs
      .map((saleDoc) => buildCashFlowContribution(saleDoc.id, saleDoc.data() || {}))
      .filter(Boolean);
    const summaryRef = db.collection(CASH_FLOW_COLLECTION).doc(turnoId);
    const [beforeSnap, storedContributionsSnap] = await Promise.all([
      summaryRef.get(),
      db.collection(CASH_FLOW_CONTRIBUTIONS_COLLECTION).where("turnoId", "==", turnoId).get()
    ]);
    const before = beforeSnap.exists ? (beforeSnap.data() || {}) : {};
    const calculated = summarizeCashFlowContributions(contributions, turnoId);
    if (!calculated.sucursal && before.sucursal) {
      calculated.sucursal = before.sucursal;
      calculated.sucursalId = before.sucursalId || normalizeDocKey(before.sucursal);
      calculated.fechaOperativa = before.fechaOperativa || "";
    }

    const desiredIds = new Set(contributions.map((entry) => entry.saleId));
    const writes = [];
    storedContributionsSnap.docs.forEach((storedDoc) => {
      if (!desiredIds.has(storedDoc.id)) writes.push({ type: "delete", ref: storedDoc.ref });
    });
    contributions.forEach((entry) => {
      writes.push({
        type: "set",
        ref: db.collection(CASH_FLOW_CONTRIBUTIONS_COLLECTION).doc(entry.saleId),
        data: { ...entry, updatedAt: admin.firestore.FieldValue.serverTimestamp() }
      });
    });

    for (let offset = 0; offset < writes.length; offset += 400) {
      const batch = db.batch();
      writes.slice(offset, offset + 400).forEach((write) => {
        if (write.type === "delete") batch.delete(write.ref);
        else batch.set(write.ref, write.data);
      });
      await batch.commit();
    }

    const summaryPayload = cashFlowSummaryPayload({}, calculated, calculated);
    summaryPayload.reconciledAt = admin.firestore.FieldValue.serverTimestamp();
    summaryPayload.reconciledBy = request.auth.uid;
    summaryPayload.reconciliationSource = "admin_callable";
    await summaryRef.set(summaryPayload, { merge: true });

    const differences = {};
    CASH_FLOW_FIELDS.forEach((field) => {
      differences[field] = cleanNumber(calculated[field], 0) - cleanNumber(before[field], 0);
    });
    const auditRef = await db.collection(CASH_FLOW_AUDIT_COLLECTION).add({
      action: "reconcile_current_shift",
      turnoId,
      sucursal: calculated.sucursal || before.sucursal || "",
      before: CASH_FLOW_FIELDS.reduce((acc, field) => ({ ...acc, [field]: cleanNumber(before[field], 0) }), {}),
      after: CASH_FLOW_FIELDS.reduce((acc, field) => ({ ...acc, [field]: cleanNumber(calculated[field], 0) }), {}),
      differences,
      ticketsRead: salesSnap.size,
      contributionsApplied: contributions.length,
      createdBy: request.auth.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    logger.info("Flujo de turno reconciliado", {
      turnoId,
      auditId: auditRef.id,
      ticketsRead: salesSnap.size,
      contributionsApplied: contributions.length,
      differences
    });

    return {
      ok: true,
      turnoId,
      auditId: auditRef.id,
      ticketsRead: salesSnap.size,
      differences,
      summary: CASH_FLOW_FIELDS.reduce((acc, field) => ({ ...acc, [field]: cleanNumber(calculated[field], 0) }), {})
    };
  }
);

exports.obtenerVentasFlujoActual = onCall(
  {
    region: "us-central1",
    cors: true,
    timeoutSeconds: 60,
    memory: "256MiB"
  },
  async (request) => {
    if (!request.auth?.uid || await getUserRole(request.auth.uid) !== "admin") {
      throw new HttpsError("permission-denied", "Solo administracion puede consultar el flujo actual.");
    }

    const recentSalesStart = admin.firestore.Timestamp.fromMillis(Date.now() - (21 * 24 * 60 * 60 * 1000));
    const salesSnap = await db.collection(SALES_COLLECTION_PATH)
      .where("fecha", ">=", recentSalesStart)
      .orderBy("fecha", "desc")
      .limit(5000)
      .get();

    const currentFlow = getCurrentFlowSalesSnapshot(salesSnap.docs);

    logger.info("Respaldo de flujo actual consultado", {
      requestedBy: request.auth.uid,
      salesRead: salesSnap.size,
      activeBranches: currentFlow.summaries.length,
      activeTickets: currentFlow.sales.length
    });
    return { ok: true, ...currentFlow, fetchedAt: Date.now() };
  }
);

exports.obtenerTicketsCierreForzado = onCall(
  {
    region: "us-central1",
    cors: true,
    timeoutSeconds: 60,
    memory: "256MiB"
  },
  async (request) => {
    if (!request.auth?.uid || await getUserRole(request.auth.uid) !== "admin") {
      throw new HttpsError("permission-denied", "Solo administracion puede preparar un cierre forzado.");
    }

    const sucursal = cleanText(request.data?.sucursal, 120);
    if (!sucursal) {
      throw new HttpsError("invalid-argument", "Debes seleccionar una sucursal.");
    }

    const salesSnap = await db.collection(SALES_COLLECTION_PATH)
      .where("sucursal", "==", sucursal)
      .limit(5000)
      .get();
    const snapshot = getForcedCloseSalesSnapshot(salesSnap.docs, sucursal);

    logger.info("Tickets preparados para cierre forzado", {
      requestedBy: request.auth.uid,
      sucursal,
      salesRead: salesSnap.size,
      turnoId: snapshot.turnoId,
      tickets: snapshot.tickets.length
    });
    return { ok: true, sucursal, ...snapshot, fetchedAt: Date.now() };
  }
);

exports.forzarCierreCajaSucursal = onCall(
  {
    region: "us-central1",
    cors: true,
    timeoutSeconds: 60,
    memory: "256MiB"
  },
  async (request) => {
    if (!request.auth?.uid || await getUserRole(request.auth.uid) !== "admin") {
      throw new HttpsError("permission-denied", "Solo administracion puede forzar un cierre de caja.");
    }

    const sucursal = cleanText(request.data?.sucursal, 120);
    const motivo = cleanText(request.data?.motivo, 500);
    if (!sucursal || !motivo) {
      throw new HttpsError("invalid-argument", "Debes indicar la sucursal y el motivo del cierre forzado.");
    }

    const declaracion = request.data?.declaracion && typeof request.data.declaracion === "object"
      ? request.data.declaracion
      : {};
    const fondoInicial = Math.max(0, cleanNumber(declaracion.fondoInicial, 0));
    const efectivoDeclarado = Math.max(0, cleanNumber(declaracion.efectivo, 0));
    const tarjetaDeclarada = Math.max(0, cleanNumber(declaracion.tarjeta, 0));
    const transferenciaDeclarada = Math.max(0, cleanNumber(declaracion.transferencia, 0));
    const gastosDeclarados = Math.max(0, cleanNumber(declaracion.gastos, 0));
    const htmlTicket = cleanText(request.data?.htmlTicket, 50000);
    const dryRun = request.data?.dryRun === true;

    const result = await db.runTransaction(async (transaction) => {
      const salesQuery = db.collection(SALES_COLLECTION_PATH).where("sucursal", "==", sucursal).limit(5000);
      const salesSnap = await transaction.get(salesQuery);
      const activeGroup = getForcedCloseSalesGroup(salesSnap.docs, sucursal);
      if (!activeGroup || !activeGroup.sales.length) {
        throw new HttpsError("failed-precondition", "No hay tickets no arqueados del turno activo para esta sucursal.");
      }

      const ticketDocs = activeGroup.sales.map(({ saleDoc }) => saleDoc);
      const totals = getForcedCloseTotals(ticketDocs);
      const products = getForcedCloseProducts(ticketDocs);
      const firstSale = ticketDocs[0].data() || {};
      const fechaApertura = resolveSaleDate(firstSale.fechaAperturaTurno)
        || resolveSaleDate(firstSale.fecha || firstSale.createdAt)
        || new Date();
      const totalEsperadoEfectivo = fondoInicial + totals.efectivo - gastosDeclarados;
      const totalEsperado = totalEsperadoEfectivo + totals.tarjeta + totals.transferencia;
      const totalDeclarado = efectivoDeclarado + tarjetaDeclarada + transferenciaDeclarada;
      const totalVendido = totals.efectivo + totals.tarjeta + totals.transferencia + totals.credito;
      const cierreDate = new Date();

      const payload = {
        turnoId: activeGroup.turnoId,
        sucursal,
        tickets: ticketDocs.length,
        totals,
        totalEsperado,
        totalDeclarado,
        totalVendido,
        difference: totalDeclarado - totalEsperado,
        fechaApertura
      };
      if (dryRun) return { ...payload, dryRun: true };

      const cierreRef = db.collection("cierresCaja").doc();
      ticketDocs.forEach((ticketDoc) => {
        transaction.update(ticketDoc.ref, {
          arqueado: true,
          fechaArqueo: cierreDate,
          cierreForzado: true,
          motivoCierreForzado: motivo,
          cierreForzadoPor: request.auth.uid,
          cierreForzadoPorId: request.auth.uid
        });
      });

      const diferenciaEfectivo = efectivoDeclarado - totalEsperadoEfectivo;
      const diferenciaTarjeta = tarjetaDeclarada - totals.tarjeta;
      const diferenciaTransferencia = transferenciaDeclarada - totals.transferencia;
      transaction.set(cierreRef, {
        turnoId: activeGroup.turnoId,
        turnosIncluidos: [activeGroup.turnoId],
        sucursal,
        cajeroId: null,
        cajero: "Cierre forzado por admin",
        fechaApertura,
        fechaCierre: cierreDate,
        fechaOperacionKey: getDateKeyInTimezone(fechaApertura),
        fechaCierreKey: getDateKeyInTimezone(cierreDate),
        fondoInicial,
        declaracion: {
          efectivo: efectivoDeclarado,
          gastos: gastosDeclarados,
          tarjeta: tarjetaDeclarada,
          transferencia: transferenciaDeclarada,
          totalCaja: totalDeclarado
        },
        sistema: {
          ventasEfectivo: totals.efectivo,
          ventasTarjeta: totals.tarjeta,
          ventasTransferencia: totals.transferencia,
          ventasCredito: totals.credito,
          fondoInicial,
          totalEsperadoEfectivo,
          totalEsperado,
          totalCobradoInmediato: totals.efectivo + totals.tarjeta + totals.transferencia,
          totalVendido,
          diferenciaEfectivo,
          diferenciaTarjeta,
          diferenciaTransferencia,
          diferenciaTotal: totalDeclarado - totalEsperado
        },
        resumenFinanciero: {
          efectivoPos: totals.efectivo,
          efectivoDeclarado,
          efectivoEsperado: totalEsperadoEfectivo,
          posTarjeta: totals.tarjeta,
          transferencia: totals.transferencia,
          credito: totals.credito,
          gastos: gastosDeclarados,
          fondoInicial,
          diferenciaCaja: diferenciaEfectivo,
          diferenciaTotal: totalDeclarado - totalEsperado,
          sobrante: Math.max(diferenciaEfectivo, 0),
          faltante: Math.max(-diferenciaEfectivo, 0)
        },
        versionEsquemaFinanciero: 2,
        productosVendidos: products,
        ticketsContados: ticketDocs.length,
        ticketsTurnoIds: ticketDocs.map((ticketDoc) => ticketDoc.id),
        cierreForzado: true,
        motivoCierreForzado: motivo,
        forzadoPor: request.auth.uid,
        forzadoPorId: request.auth.uid,
        htmlTicket,
        creadoEn: admin.firestore.FieldValue.serverTimestamp()
      });

      transaction.set(db.collection(CASH_FLOW_COLLECTION).doc(activeGroup.turnoId), {
        estadoTurno: "cerrado",
        cierreCajaId: cierreRef.id,
        closedAt: cierreDate,
        updatedAt: cierreDate,
        cierreForzado: true,
        cierreForzadoPorId: request.auth.uid
      }, { merge: true });
      transaction.set(db.collection("auditoria").doc(), {
        tipo: "cierre_forzado_caja",
        sucursal,
        turnoId: activeGroup.turnoId,
        total: totalEsperado,
        totalBrutoConCredito: totalVendido,
        totalDeclarado,
        diferenciaTotal: totalDeclarado - totalEsperado,
        ticketsContados: ticketDocs.length,
        motivo,
        cierreId: cierreRef.id,
        adminId: request.auth.uid,
        fecha: cierreDate,
        timestamp: cierreDate
      });

      return { ...payload, cierreId: cierreRef.id, dryRun: false };
    });

    logger.info("Cierre forzado ejecutado", {
      requestedBy: request.auth.uid,
      sucursal,
      turnoId: result.turnoId,
      tickets: result.tickets,
      dryRun
    });
    return { ok: true, ...result };
  }
);

exports.claimLinTicket = onCall(
  {
    region: "us-central1",
    cors: true
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesion.");
    }

    const uid = request.auth.uid;
    const ticketId = cleanText(request.data?.ticketId, 160);
    const branchId = cleanText(request.data?.branchId, 120);
    const branchName = cleanText(request.data?.branchName, 120);
    if (!ticketId) {
      throw new HttpsError("invalid-argument", "Ticket invalido.");
    }

    const ticketRef = db.collection("linTickets").doc(ticketId);
    const userRef = db.collection("users").doc(uid);
    const safeClaimId = `${uid}_${ticketId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const oneTimeClaimRef = db.collection("linTicketClaims").doc(safeClaimId);

    return await db.runTransaction(async (transaction) => {
      const [ticketSnap, userSnap, existingClaimSnap] = await Promise.all([
        transaction.get(ticketRef),
        transaction.get(userRef),
        transaction.get(oneTimeClaimRef)
      ]);

      if (!ticketSnap.exists) {
        throw new HttpsError("not-found", "Este LIN Ticket no existe.");
      }
      if (!userSnap.exists) {
        throw new HttpsError("not-found", "No se encontro tu perfil.");
      }

      const ticket = ticketSnap.data() || {};
      const user = userSnap.data() || {};
      const oneTimePerUser = ticket.oneTimePerUser !== false;
      if (ticket.active === false) {
        throw new HttpsError("failed-precondition", "Este beneficio ya no esta activo.");
      }
      if (!ticketAppliesToBranch(ticket, branchId, branchName)) {
        throw new HttpsError("failed-precondition", "Este beneficio no esta disponible para esta sucursal.");
      }

      const now = new Date();
      const startDate = parseTicketDate(ticket.startDate, false);
      const endDate = parseTicketDate(ticket.endDate, true);
      if (startDate && now < startDate) {
        throw new HttpsError("failed-precondition", "Este beneficio todavia no esta disponible.");
      }
      if (endDate && now > endDate) {
        throw new HttpsError("failed-precondition", "Este beneficio esta vencido.");
      }
      if (oneTimePerUser && existingClaimSnap.exists) {
        throw new HttpsError("already-exists", "Este beneficio ya fue utilizado por tu cuenta.");
      }

      const type = cleanText(ticket.type || ticket.benefitType || "special_promo", 40);
      const pointsGranted = type === "free_points" ? Math.max(0, Math.floor(cleanNumber(ticket.pointsValue || ticket.points, 0))) : 0;
      const isFreeProduct = type === "free_product";
      const claimRef = oneTimePerUser ? oneTimeClaimRef : db.collection("linTicketClaims").doc();
      const claimPayload = {
        ticketId,
        ticketName: cleanText(ticket.name || ticket.title || "LIN Ticket", 160),
        productId: isFreeProduct ? cleanText(ticket.productId, 160) : "",
        productName: isFreeProduct ? cleanText(ticket.productName || ticket.name || ticket.title || "Producto gratis", 180) : "",
        productPrice: isFreeProduct ? cleanNumber(ticket.productPrice, 0) : 0,
        productImageUrl: isFreeProduct ? cleanText(ticket.productImageUrl || ticket.imageUrl, 500) : "",
        userId: uid,
        userName: cleanText(user.nombre || user.displayName || user.email || "Cliente", 160),
        branchId: branchId || cleanText(ticket.branchId || "all", 120),
        branchName: branchName || cleanText(ticket.branchName || "", 120),
        claimedAt: admin.firestore.FieldValue.serverTimestamp(),
        pointsGranted,
        status: isFreeProduct ? "pending_redeem" : "claimed",
        noAfectaCaja: isFreeProduct,
        oneTimePerUser,
        type
      };

      transaction.set(claimRef, claimPayload);
      if (pointsGranted > 0) {
        transaction.update(userRef, {
          puntos: admin.firestore.FieldValue.increment(pointsGranted),
          linTicketPointsUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      return {
        ok: true,
        claimId: claimRef.id,
        pointsGranted,
        pointsBalance: cleanNumber(user.puntos, 0) + pointsGranted,
        status: "claimed"
      };
    });
  }
);

exports.crearSolicitudPlayTester = onDocumentCreated(
  {
    region: "us-central1",
    document: "users/{uid}"
  },
  async (event) => {
    const uid = event.params.uid;
    const data = event.data?.data() || {};
    if (data.rol && data.rol !== "cliente") return;
    const email = cleanText(data.email, 260).toLowerCase();
    if (!email) {
      await db.collection("users").doc(uid).set({
        playTesterStatus: "manual_review_required",
        playTesterErrorMessage: "Usuario creado sin correo electronico.",
        playStoreUrl: PLAY_STORE_URL,
        playTesterGroupEmail: PLAY_TESTERS_GROUP_EMAIL
      }, { merge: true });
      return;
    }
    await processPlayTesterRequest({
      uid,
      email,
      displayName: data.nombre || data.displayName || "",
      source: "user_created"
    });
  }
);

exports.reintentarPlayTesterRequest = onCall(
  {
    region: "us-central1",
    cors: true
  },
  async (request) => {
    if (!request.auth?.uid || await getUserRole(request.auth.uid) !== "admin") {
      throw new HttpsError("permission-denied", "Solo admin puede reintentar testers.");
    }
    const uid = cleanText(request.data?.uid, 160);
    const email = cleanText(request.data?.email, 260).toLowerCase();
    if (!uid || !email) {
      throw new HttpsError("invalid-argument", "Faltan uid o email.");
    }
    return await processPlayTesterRequest({
      uid,
      email,
      displayName: cleanText(request.data?.displayName, 180),
      source: "admin_retry"
    });
  }
);

exports.marcarPlayTesterAgregadoManual = onCall(
  {
    region: "us-central1",
    cors: true
  },
  async (request) => {
    if (!request.auth?.uid || await getUserRole(request.auth.uid) !== "admin") {
      throw new HttpsError("permission-denied", "Solo admin puede marcar testers.");
    }
    const uid = cleanText(request.data?.uid, 160);
    const email = cleanText(request.data?.email, 260).toLowerCase();
    if (!uid || !email) {
      throw new HttpsError("invalid-argument", "Faltan uid o email.");
    }
    const config = getPlayTesterConfig();
    const requestRef = db.collection("playTesterRequests").doc(getPlayTesterRequestId(uid, email));
    await requestRef.set({
      uid,
      email,
      displayName: cleanText(request.data?.displayName, 180),
      groupEmail: config.groupEmail,
      status: "added_to_google_group",
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      processedBy: request.auth.uid,
      source: "manual_admin",
      errorMessage: "",
      playStoreUrl: config.playStoreUrl
    }, { merge: true });
    await db.collection("users").doc(uid).set({
      playTesterStatus: "added_to_google_group",
      playTesterProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
      playTesterErrorMessage: "",
      playTesterGroupEmail: config.groupEmail,
      playStoreUrl: config.playStoreUrl
    }, { merge: true });
    return { ok: true, status: "added_to_google_group", playStoreUrl: config.playStoreUrl };
  }
);

exports.validarPinCreditoCliente = onCall(
  {
    region: "us-central1",
    cors: true
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Sesion requerida.");
    }
    const role = await getUserRole(request.auth.uid);
    if (!["admin", "cajero"].includes(role)) {
      throw new HttpsError("permission-denied", "No autorizado para validar credito.");
    }

    const clienteId = cleanText(request.data?.clienteId, 128);
    const pin = cleanText(request.data?.pin, 64);
    if (!clienteId || pin.length < 4) {
      throw new HttpsError("invalid-argument", "Cliente y PIN son obligatorios.");
    }

    const clienteSnap = await db.collection("users").doc(clienteId).get();
    if (!clienteSnap.exists) {
      throw new HttpsError("not-found", "Cliente no encontrado.");
    }
    const cliente = clienteSnap.data() || {};
    if (cliente.solicitarPinCredito !== true) {
      return { ok: true, pinRequired: false };
    }

    const pinSnap = await db.collection("creditPins").doc(clienteId).get();
    if (!pinSnap.exists || !pinSnap.data()?.pinHash) {
      throw new HttpsError("failed-precondition", "El cliente no tiene PIN de credito configurado.");
    }

    const success = hashCreditPin(clienteId, pin) === pinSnap.data().pinHash;
    await db.collection("creditPinAttempts").add({
      clienteId,
      cajeroId: request.auth.uid,
      cajeroRol: role,
      success,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (!success) {
      throw new HttpsError("permission-denied", "PIN incorrecto.");
    }

    return { ok: true, pinRequired: true };
  }
);

function buildOrderSignature({ sucursal, metodoPago, direccionDelivery, items, puntosCanjeados }) {
  const itemsOrdenados = (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: cleanText(item?.id, 120),
      nombre: cleanText(item?.nombre, 120),
      cantidad: Math.max(1, Math.floor(cleanNumber(item?.cantidad, 1))),
      precioAplicado: Math.max(0, cleanNumber(item?.precioAplicado, item?.precio || 0)),
      puntosCoste: Math.max(0, Math.floor(cleanNumber(item?.puntosCoste, 0))),
      esCanje: item?.esCanje === true
    }))
    .sort((a, b) => `${a.id}|${a.nombre}`.localeCompare(`${b.id}|${b.nombre}`));

  return JSON.stringify({
    sucursal: normalizeText(sucursal),
    metodoPago: normalizeText(metodoPago),
    direccionDelivery: cleanText(direccionDelivery, 220),
    puntosCanjeados: Math.max(0, Math.floor(cleanNumber(puntosCanjeados, 0))),
    items: itemsOrdenados
  });
}

async function findRecentDuplicateCustomerOrder({ userId, sucursal, metodoPago, direccionDelivery, items, puntosCanjeados }) {
  const firmaActual = buildOrderSignature({ sucursal, metodoPago, direccionDelivery, items, puntosCanjeados });
  const recientesSnap = await db.collection(SALES_COLLECTION_PATH)
    .where("cliente", "==", userId)
    .limit(20)
    .get();

  const ahora = Date.now();
  for (const docSnap of recientesSnap.docs) {
    const data = docSnap.data() || {};
    if (data.tipoTransaccion !== "app_delivery") continue;
    const fecha = typeof data.fecha?.toDate === "function" ? data.fecha.toDate() : new Date(data.fecha || 0);
    if (Number.isNaN(fecha.getTime()) || (ahora - fecha.getTime()) > 120000) continue;
    if (normalizeText(data.estadoCocina) === "anulado" || normalizeText(data.estadoPago) === "anulado") continue;
    const firmaExistente = buildOrderSignature({
      sucursal: data.sucursal,
      metodoPago: data.metodoPagoSolicitado || data.metodoPago,
      direccionDelivery: data.direccionDelivery,
      items: data.items,
      puntosCanjeados: data.puntosCanjeados
    });
    if (firmaExistente === firmaActual) {
      return { id: docSnap.id, data };
    }
  }
  return null;
}

function sanitizeOrderItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => {
      const nombre = cleanText(item?.nombre, 120);
      const cantidad = Math.max(1, Math.floor(cleanNumber(item?.cantidad, 1)));
      const precio = Math.max(0, cleanNumber(item?.precio, 0));
      const precioAplicado = Math.max(0, cleanNumber(item?.precioAplicado, precio));
      const puntosCoste = Math.max(0, Math.floor(cleanNumber(item?.puntosCoste, 0)));

      if (!nombre) return null;

      return {
        id: cleanText(item?.id, 120) || `APPITEM-${Date.now()}`,
        nombre,
        cantidad,
        precio,
        precioAplicado,
        puntosCoste,
        esCanje: item?.esCanje === true,
        categoria: cleanText(item?.categoria, 80) || "General",
        controlado: item?.controlado === true,
        usaProduccionCarne: item?.usaProduccionCarne === true,
        medallonesPorUnidad: Math.max(0, Math.floor(cleanNumber(item?.medallonesPorUnidad, 0))),
        usaProduccionPan: item?.usaProduccionPan === true,
        panesPorUnidad: Math.max(0, Math.floor(cleanNumber(item?.panesPorUnidad, 0))),
        usaProduccionPapa: item?.usaProduccionPapa === true,
        papasPorUnidad: Math.max(0, Math.floor(cleanNumber(item?.papasPorUnidad, 0))),
        usaProduccionCarneSalteado: item?.usaProduccionCarneSalteado === true,
        carneSalteadoPorUnidad: Math.max(0, Math.floor(cleanNumber(item?.carneSalteadoPorUnidad, 0))),
        usaProduccionCarneLomito: item?.usaProduccionCarneLomito === true,
        carneLomitoPorUnidad: Math.max(0, Math.floor(cleanNumber(item?.carneLomitoPorUnidad, 0))),
        usaProduccionPanLomito: item?.usaProduccionPanLomito === true,
        panLomitoPorUnidad: Math.max(0, Math.floor(cleanNumber(item?.panLomitoPorUnidad, 0))),
        stockDescontado: item?.stockDescontado === true,
        stockDescontadoCantidad: Math.max(0, Math.floor(cleanNumber(item?.stockDescontadoCantidad, 0))),
        icono: cleanText(item?.icono, 60) || "fa-box",
        imagen: cleanText(item?.imagen, 500),
        sucursal: cleanText(item?.sucursal, 120),
        observacion: cleanText(item?.observacion || item?.obsProd, 180)
      };
    })
    .filter(Boolean);
}

async function prepararReservasStockPedido(items, sucursal, transaction = null) {
  const reservasPorProducto = new Map();
  const sucursalPedido = normalizeText(sucursal);

  for (const item of items) {
    const productoId = cleanText(item?.id, 120);
    if (!productoId || productoId.startsWith("APPITEM-")) {
      item.stockDescontado = false;
      continue;
    }

    const cantidad = Math.max(1, Math.floor(cleanNumber(item.cantidad, 1)));
    const actual = reservasPorProducto.get(productoId) || {
      ref: db.collection("products").doc(productoId),
      cantidad: 0,
      items: []
    };
    actual.cantidad += cantidad;
    actual.items.push({ item, cantidad });
    reservasPorProducto.set(productoId, actual);
  }

  const reservas = [];
  for (const reserva of reservasPorProducto.values()) {
    const productSnap = transaction
      ? await transaction.get(reserva.ref)
      : await reserva.ref.get();
    const itemReferencia = reserva.items[0]?.item || {};
    if (!productSnap.exists) {
      if (itemReferencia.controlado === true) {
        throw new HttpsError("failed-precondition", `Producto no encontrado: ${itemReferencia.nombre}`);
      }
      reserva.items.forEach(({ item }) => {
        item.stockDescontado = false;
      });
      continue;
    }

    const productData = productSnap.data() || {};
    const sucursalProducto = cleanText(productData.sucursal, 120) || "Unificado";
    if (sucursalProducto !== "Unificado" && normalizeText(sucursalProducto) !== sucursalPedido) {
      throw new HttpsError("failed-precondition", `El producto ${itemReferencia.nombre} no pertenece a la sucursal seleccionada.`);
    }

    if (productData.controlado !== true) {
      reserva.items.forEach(({ item }) => {
        item.controlado = false;
        item.stockDescontado = false;
        item.stockDescontadoCantidad = 0;
        item.sucursal = sucursalProducto;
      });
      continue;
    }

    const stockActual = cleanNumber(productData.stock, 0);
    if (stockActual < reserva.cantidad) {
      throw new HttpsError("failed-precondition", `Stock insuficiente para ${productData.nombre || itemReferencia.nombre}. Disponible: ${stockActual}`);
    }

    reserva.items.forEach(({ item, cantidad }) => {
      item.controlado = true;
      item.stockDescontado = true;
      item.stockDescontadoCantidad = cantidad;
      item.categoria = cleanText(productData.categoria, 80) || item.categoria;
      item.sucursal = sucursalProducto;
    });
    reservas.push({
      ref: reserva.ref,
      cantidad: reserva.cantidad,
      productoId: reserva.ref.id,
      nombre: productData.nombre || itemReferencia.nombre || "Producto"
    });
  }

  return reservas;
}

function saleIsCancelled(data) {
  if (!data) return true;
  return normalizeText(data.estadoPago) === "anulado" || normalizeText(data.estadoCocina) === "anulado";
}

function buildProductionConsumptionMap(saleData) {
  const result = new Map();
  if (!saleData || saleIsCancelled(saleData) || saleData.tipoTransaccion === "abono_deuda") return result;

  const branchFallback = cleanText(saleData.sucursal, 120) || "General";
  const items = Array.isArray(saleData.items) ? saleData.items : [];
  for (const item of items) {
    const cantidad = Math.max(0, Math.floor(cleanNumber(item?.cantidad, 0)));
    const medallones = item?.usaProduccionCarne === true
      ? Math.max(0, Math.floor(cleanNumber(item?.medallonesPorUnidad, 0))) * cantidad
      : 0;
    const panes = item?.usaProduccionPan === true
      ? Math.max(0, Math.floor(cleanNumber(item?.panesPorUnidad, 0))) * cantidad
      : 0;
    const papas = item?.usaProduccionPapa === true
      ? Math.max(0, Math.floor(cleanNumber(item?.papasPorUnidad, 0))) * cantidad
      : 0;
    const carneSalteado = item?.usaProduccionCarneSalteado === true
      ? Math.max(0, Math.floor(cleanNumber(item?.carneSalteadoPorUnidad, 0))) * cantidad
      : 0;
    const carneLomito = item?.usaProduccionCarneLomito === true
      ? Math.max(0, Math.floor(cleanNumber(item?.carneLomitoPorUnidad, 0))) * cantidad
      : 0;
    const panLomito = item?.usaProduccionPanLomito === true
      ? Math.max(0, Math.floor(cleanNumber(item?.panLomitoPorUnidad, 0))) * cantidad
      : 0;
    if (medallones <= 0 && panes <= 0 && papas <= 0 && carneSalteado <= 0 && carneLomito <= 0 && panLomito <= 0) continue;
    const itemBranch = cleanText(item?.sucursal, 120);
    const branchName = itemBranch && itemBranch !== "Unificado" ? itemBranch : branchFallback;
    const branchKey = normalizeDocKey(branchName);
    const current = result.get(branchKey) || { sucursal: branchName, cantidad: 0, medallones: 0, panes: 0, papas: 0, carneSalteado: 0, carneLomito: 0, panLomito: 0 };
    current.cantidad += medallones + panes + papas + carneSalteado + carneLomito + panLomito;
    current.medallones += medallones;
    current.panes += panes;
    current.papas += papas;
    current.carneSalteado += carneSalteado;
    current.carneLomito += carneLomito;
    current.panLomito += panLomito;
    result.set(branchKey, current);
  }

  return result;
}

function mapTotalConsumption(consumptionMap) {
  let total = 0;
  for (const value of consumptionMap.values()) total += Number(value?.cantidad || 0);
  return total;
}

exports.registrarAlertaOperativa = onCall(
  {
    region: "us-central1",
    cors: true
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesion para registrar alertas operativas.");
    }

    const role = await getUserRole(request.auth.uid);
    if (!["admin", "cajero", "produccion"].includes(role)) {
      throw new HttpsError("permission-denied", "No tienes permisos para registrar alertas operativas.");
    }

    const data = request.data || {};
    const origen = cleanText(data.origen, 80) || "frontend";
    const tipo = cleanText(data.tipo, 80) || "evento_operativo";
    const nivel = OPERATIONAL_ALERT_LEVELS.has(normalizeText(data.nivel))
      ? normalizeText(data.nivel)
      : "warning";
    const mensaje = cleanText(data.mensaje, 240);
    const sucursal = cleanText(data.sucursal, 120);
    const detalle = typeof data.detalle === "object" && data.detalle !== null ? data.detalle : {};

    if (!mensaje) {
      throw new HttpsError("invalid-argument", "Debes indicar un mensaje para la alerta operativa.");
    }

    const payload = {
      origen,
      tipo,
      nivel,
      mensaje,
      sucursal,
      detalle,
      creadoPor: request.auth.uid,
      creadoPorRol: role,
      creadoAt: admin.firestore.FieldValue.serverTimestamp(),
      estado: "abierta"
    };

    const alertRef = await db.collection("systemAlerts").add(payload);

    const loggerPayload = { alertId: alertRef.id, origen, tipo, sucursal, creadoPor: request.auth.uid };
    if (nivel === "critical" || nivel === "error") {
      logger.error("Alerta operativa registrada", loggerPayload);
    } else if (nivel === "warning") {
      logger.warn("Alerta operativa registrada", loggerPayload);
    } else {
      logger.info("Alerta operativa registrada", loggerPayload);
    }

    return {
      ok: true,
      alertId: alertRef.id
    };
  }
);

exports.enviarNotificacionPush = onCall(
  {
    region: "us-central1",
    cors: true
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const role = await getUserRole(request.auth.uid);
    if (!["admin", "cajero"].includes(role)) {
      throw new HttpsError("permission-denied", "No tienes permiso para enviar notificaciones.");
    }

    const titulo = cleanText(request.data?.titulo, 60);
    const mensaje = cleanText(request.data?.mensaje, 180);
    if (!titulo || !mensaje) {
      throw new HttpsError("invalid-argument", "Titulo y mensaje son obligatorios.");
    }

    const autor = cleanText(request.data?.autor, 80) || request.auth.token?.name || "Sistema";
    const now = new Date().toISOString();
    const payloadDoc = {
      titulo,
      mensaje,
      fecha: now,
      autor,
      rolAutor: role,
      vistoPor: [],
      pushEnviados: 0,
      pushFallidos: 0
    };

    const notifRef = await db.collection("notifications").add(payloadDoc);

    const tokenRecords = await collectClientPushTokenRecords();
    const tokens = tokenRecords.map((record) => record.token);
    let successCount = 0;
    let failureCount = 0;
    let invalidTokens = [];

    if (tokens.length > 0) {
      const chunks = [];
      for (let index = 0; index < tokens.length; index += 500) {
        chunks.push(tokens.slice(index, index + 500));
      }

      for (const chunk of chunks) {
        const multicast = {
          tokens: chunk,
          notification: {
            title: titulo,
            body: mensaje
          },
          android: {
            priority: "high",
            notification: {
              channelId: "club_lin_promos",
              sound: "default",
              color: "#C96B2C"
            }
          },
          webpush: {
            fcmOptions: {
              link: "https://sys-pos-erp-lingroup.web.app/app_cliente.html?view=notifications"
            },
            notification: {
              icon: "https://sys-pos-erp-lingroup.web.app/club_lin_logo.jpg",
              badge: "https://sys-pos-erp-lingroup.web.app/club_lin_logo.jpg"
            }
          },
          data: {
            notificationId: notifRef.id,
            route: "notifications",
            titulo,
            mensaje
          }
        };

        const response = await messaging.sendEachForMulticast(multicast);
        successCount += response.successCount;
        failureCount += response.failureCount;

        response.responses.forEach((item, index) => {
          if (!item.success) {
            const code = item.error?.code || "";
            if (
              code.includes("registration-token-not-registered") ||
              code.includes("invalid-registration-token")
            ) {
              invalidTokens.push(chunk[index]);
            }
            logger.error("Error enviando push", {
              token: chunk[index],
              code,
              message: item.error?.message || ""
            });
          }
        });
      }
    }

    await deactivateInvalidPushTokens(tokenRecords, invalidTokens);

    await notifRef.update({
      pushEnviados: successCount,
      pushFallidos: failureCount,
      totalTokens: tokens.length
    });

    await trackGa4Event({
      name: "admin_notification_sent",
      clientId: `admin_${request.auth.uid}`,
      userId: request.auth.uid,
      params: {
        notification_id: notifRef.id,
        notification_title: titulo,
        target: "clientes",
        push_success: successCount,
        push_failed: failureCount,
        total_tokens: tokens.length,
        author_role: role
      }
    });

    return {
      ok: true,
      notificationId: notifRef.id,
      pushEnviados: successCount,
      pushFallidos: failureCount,
      totalTokens: tokens.length
    };
  }
);

exports.enviarNotificacionPushHttp = onRequest(
  {
    region: "us-central1",
    cors: true
  },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "https://sys-pos-erp-lingroup.web.app");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "method_not_allowed" });
      return;
    }

    try {
      const authHeader = String(req.headers.authorization || "");
      const match = /^Bearer\s+(.+)$/i.exec(authHeader);
      if (!match) {
        throw new HttpsError("unauthenticated", "Debes iniciar sesion.");
      }

      const decoded = await admin.auth().verifyIdToken(match[1]);
      const role = await getUserRole(decoded.uid);
      if (!["admin", "cajero"].includes(role)) {
        throw new HttpsError("permission-denied", "No tienes permiso para enviar notificaciones.");
      }

      const titulo = cleanText(req.body?.titulo, 60);
      const mensaje = cleanText(req.body?.mensaje, 180);
      if (!titulo || !mensaje) {
        throw new HttpsError("invalid-argument", "Titulo y mensaje son obligatorios.");
      }

      const autor = cleanText(req.body?.autor, 80) || decoded.name || "Sistema";
      const now = new Date().toISOString();
      const payloadDoc = {
        titulo,
        mensaje,
        fecha: now,
        autor,
        rolAutor: role,
        vistoPor: [],
        pushEnviados: 0,
        pushFallidos: 0
      };

      const notifRef = await db.collection("notifications").add(payloadDoc);
      const tokenRecords = await collectClientPushTokenRecords();
      const tokens = tokenRecords.map((record) => record.token);
      let successCount = 0;
      let failureCount = 0;
      const invalidTokens = [];

      if (tokens.length > 0) {
        for (let offset = 0; offset < tokens.length; offset += 500) {
          const chunk = tokens.slice(offset, offset + 500);
          const response = await messaging.sendEachForMulticast({
            tokens: chunk,
            notification: {
              title: titulo,
              body: mensaje
            },
            android: {
              priority: "high",
              notification: {
                channelId: "club_lin_promos",
                sound: "default",
                color: "#C96B2C"
              }
            },
            webpush: {
              fcmOptions: {
                link: "https://sys-pos-erp-lingroup.web.app/app_cliente.html?view=notifications"
              },
              notification: {
                icon: "https://sys-pos-erp-lingroup.web.app/club_lin_logo.jpg",
                badge: "https://sys-pos-erp-lingroup.web.app/club_lin_logo.jpg"
              }
            },
            data: {
              notificationId: notifRef.id,
              route: "notifications",
              titulo,
              mensaje
            }
          });

          successCount += response.successCount;
          failureCount += response.failureCount;
          response.responses.forEach((item, index) => {
            if (!item.success) {
              const code = item.error?.code || "";
              if (code.includes("registration-token-not-registered") || code.includes("invalid-registration-token")) {
                invalidTokens.push(chunk[index]);
              }
              logger.error("Error enviando push", {
                token: chunk[index],
                code,
                message: item.error?.message || ""
              });
            }
          });
        }
      }

      await deactivateInvalidPushTokens(tokenRecords, invalidTokens);

      await notifRef.update({
        pushEnviados: successCount,
        pushFallidos: failureCount,
        totalTokens: tokens.length
      });

      await trackGa4Event({
        name: "admin_notification_sent",
        clientId: `admin_${decoded.uid}`,
        userId: decoded.uid,
        params: {
          notification_id: notifRef.id,
          notification_title: titulo,
          target: "clientes",
          push_success: successCount,
          push_failed: failureCount,
          total_tokens: tokens.length,
          author_role: role,
          channel: "admin_http"
        }
      });

      res.status(200).json({
        ok: true,
        notificationId: notifRef.id,
        pushEnviados: successCount,
        pushFallidos: failureCount,
        totalTokens: tokens.length
      });
    } catch (error) {
      logger.error("enviarNotificacionPushHttp error", { code: error?.code || "", message: error?.message || String(error) });
      const status = error?.code === "unauthenticated"
        ? 401
        : error?.code === "permission-denied"
          ? 403
          : error?.code === "invalid-argument"
            ? 400
            : 500;
      res.status(status).json({
        ok: false,
        error: error?.code || "internal",
        message: error?.message || "No se pudo enviar la notificacion."
      });
    }
  }
);

exports.notificarEstadoPedidoCliente = onCall(
  {
    region: "us-central1",
    cors: true
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesion.");
    }

    const role = await getUserRole(request.auth.uid);
    if (!["admin", "cajero", "delivery"].includes(role)) {
      throw new HttpsError("permission-denied", "No tienes permiso para enviar este aviso.");
    }

    const clienteId = cleanText(request.data?.clienteId, 128);
    const saleId = cleanText(request.data?.saleId, 128);
    const titulo = cleanText(request.data?.titulo, 60);
    const mensaje = cleanText(request.data?.mensaje, 180);
    if (!clienteId || !titulo || !mensaje) {
      throw new HttpsError("invalid-argument", "clienteId, titulo y mensaje son obligatorios.");
    }

    const userRef = db.collection("users").doc(clienteId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError("not-found", "Cliente no encontrado.");
    }

    const userData = userSnap.data() || {};
    const token = String(userData.pushTokenMovil || "").trim();
    if (!token || String(userData.pushPermiso || "") !== "granted") {
      return { ok: true, skipped: true, reason: "push_not_available" };
    }

    try {
      const response = await messaging.sendEachForMulticast({
        tokens: [token],
        notification: {
          title: titulo,
          body: mensaje
        },
        android: {
          priority: "high",
          notification: {
            channelId: "club_lin_promos",
            sound: "default",
            color: "#C96B2C"
          }
        },
        data: {
          route: "orders",
          saleId,
          titulo,
          mensaje
        }
      });

      const item = response.responses?.[0];
      if (!item?.success) {
        const code = item?.error?.code || "";
        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-registration-token")
        ) {
          await userRef.update({
            pushTokenMovil: admin.firestore.FieldValue.delete(),
            pushPermiso: "stale"
          });
        }
        throw item?.error || new Error("push_failed");
      }

      return { ok: true, skipped: false };
    } catch (error) {
      logger.error("Error enviando push de estado al cliente", {
        clienteId,
        saleId,
        message: error?.message || String(error)
      });
      throw new HttpsError("internal", "No se pudo enviar la notificacion.");
    }
  }
);

exports.crearPedidoCliente = onCall(
  {
    region: "us-central1",
    cors: true
  },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesion.");
    }

    const userRef = db.collection("users").doc(request.auth.uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError("not-found", "No se encontro el perfil del cliente.");
    }

    const userData = userSnap.data() || {};
    if (userData.rol !== "cliente") {
      throw new HttpsError("permission-denied", "Solo clientes pueden crear pedidos desde la app.");
    }

    const items = sanitizeOrderItems(request.data?.items);
    if (items.length === 0) {
      throw new HttpsError("invalid-argument", "Debes agregar al menos un producto.");
    }

    const total = Math.max(0, cleanNumber(request.data?.total, 0));
    const puntosCanjeados = Math.max(0, Math.floor(cleanNumber(request.data?.puntosCanjeados, 0)));
    const sucursal = cleanText(request.data?.sucursal, 120);
    const telefonoContacto = cleanText(request.data?.telefonoContacto, 40) || cleanText(userData.telefono, 40);
    const direccionDelivery = cleanText(request.data?.direccionDelivery, 220);
    const notasCliente = cleanText(request.data?.notasCliente, 220);
    const metodoPago = cleanText(request.data?.metodoPago, 40) || "Efectivo";
    const metodoPagoNormalizado = normalizeText(metodoPago);
    const tipoEntrega = cleanText(request.data?.tipoEntrega, 40) || (metodoPagoNormalizado === "retiro" ? "Retiro" : "Delivery");
    const esRetiro = normalizeText(tipoEntrega) === "retiro" || metodoPagoNormalizado === "retiro";
    const detallesPagoData = request.data?.detallesPago && typeof request.data.detallesPago === "object"
      ? {
          banco: cleanText(request.data.detallesPago.banco, 80),
          titular: cleanText(request.data.detallesPago.titular, 120),
          alias: cleanText(request.data.detallesPago.alias, 80),
          instrucciones: cleanText(request.data.detallesPago.instrucciones, 180)
        }
      : null;
    const ticketId = cleanText(request.data?.ticket_id, 40) || `APP-${Math.floor(Math.random() * 1000000)}`;
    const gps = request.data?.gps && typeof request.data.gps === "object"
      ? {
          lat: cleanNumber(request.data.gps.lat, null),
          lng: cleanNumber(request.data.gps.lng, null)
        }
      : null;

    if (!sucursal) {
      throw new HttpsError("invalid-argument", "Debes seleccionar una sucursal.");
    }
    if (!esRetiro && !direccionDelivery && !(gps && gps.lat !== null && gps.lng !== null)) {
      throw new HttpsError("invalid-argument", "Debes indicar una direccion o ubicacion GPS.");
    }

    const descuentoPremiumPct = getClientDiscountForPayment(userData, metodoPago);

    const subtotalCalculado = items.reduce((sum, item) => sum + (item.precioAplicado * item.cantidad), 0);
    const esPagoInmediatoConDescuento = descuentoPremiumPct > 0;
    const descuentoPremiumMonto = esPagoInmediatoConDescuento ? Math.round(subtotalCalculado * (descuentoPremiumPct / 100)) : 0;
    const totalCalculado = Math.max(0, subtotalCalculado - descuentoPremiumMonto);
    if (Math.abs(totalCalculado - total) > 1) {
      throw new HttpsError("invalid-argument", "El total del pedido no coincide con los items.");
    }

    const puntosCalculados = items.reduce((sum, item) => sum + (item.puntosCoste * item.cantidad), 0);
    if (puntosCalculados !== puntosCanjeados) {
      throw new HttpsError("invalid-argument", "Los puntos canjeados no coinciden con los productos.");
    }

    const esCreditoPremium = isCreditMethod(metodoPago);
    const creditoLibreSucursal = esCreditoPremium && hasFreeCreditForBranch(userData, sucursal);
    const premiumActivo = userData.tipoCliente === "premium" && userData.estadoBeneficios === "activo";
    const tieneItemsDeCocina = items.some((item) => itemNeedsKitchen(item));
    const gpsValido = Boolean(gps && gps.lat !== null && gps.lng !== null);
    const mapaDeliveryUrl = gpsValido
      ? `https://www.openstreetmap.org/?mlat=${gps.lat}&mlon=${gps.lng}#map=18/${gps.lat}/${gps.lng}`
      : (direccionDelivery ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(`${direccionDelivery}, ${sucursal}`)}` : "");
    if (esCreditoPremium && !premiumActivo && !creditoLibreSucursal) {
      throw new HttpsError("permission-denied", "Solo clientes premium activos o habilitados con credito libre pueden cargar a credito.");
    }

    if ((userData.puntos || 0) < puntosCanjeados) {
      throw new HttpsError("failed-precondition", "No tienes puntos suficientes para este canje.");
    }

    const pedidoDuplicado = await findRecentDuplicateCustomerOrder({
      userId: request.auth.uid,
      sucursal,
      metodoPago,
      direccionDelivery: direccionDelivery || "Ubicacion GPS (Ver mapa)",
      items,
      puntosCanjeados
    });
    if (pedidoDuplicado) {
      return {
        ok: true,
        saleId: pedidoDuplicado.id,
        ticketId: pedidoDuplicado.data.ticket_id || ticketId,
        metodoPago: pedidoDuplicado.data.metodoPago || (esCreditoPremium ? "Crédito" : "Por Cobrar"),
        creditoLibreSucursal: pedidoDuplicado.data.creditoLibreSucursal === true,
        deudaActualizada: cleanNumber(userData.deuda, 0),
        puntosRestantes: cleanNumber(userData.puntos, 0),
        duplicado: true
      };
    }

    let reservasStock = [];

    const payload = {
      ticket_id: ticketId,
      tipoTransaccion: "app_delivery",
      origenPedido: "app_cliente",
      total,
      puntosCanjeados,
      subtotalOriginal: subtotalCalculado,
      sucursal,
      cajero: "Auto (App Cliente)",
      cliente: request.auth.uid,
      nombreCliente: cleanText(userData.nombre, 120) || "Cliente App",
      aliasReferencia: cleanText(userData.nombre, 120) || "Pedido App",
      telefonoCliente: telefonoContacto,
      items,
      fecha: new Date(),
      estadoPago: esCreditoPremium ? "pagado" : "pendiente",
      metodoPago: esCreditoPremium ? "Crédito" : metodoPago,
      metodoPagoSolicitado: esCreditoPremium ? "Crédito" : metodoPago,
      tipoEntrega,
      detallesPago: detallesPagoData,
      descuentoPagoEfectivoPct: descuentoPremiumPct,
      descuentoPagoEfectivoMonto: descuentoPremiumMonto,
      premiumDiscountApplied: descuentoPremiumMonto > 0,
      premiumDiscountPercent: descuentoPremiumPct,
      discountAmount: descuentoPremiumMonto,
      creditoProcesado: esCreditoPremium,
      requiereConfirmacionCaja: !esCreditoPremium,
      confirmadoPorCaja: esCreditoPremium,
      fechaConfirmacionCaja: esCreditoPremium ? new Date().toISOString() : null,
      creditoLibreSucursal,
      sucursalCreditoLibre: creditoLibreSucursal ? sucursal : null,
      deudaGenerada: esCreditoPremium && !creditoLibreSucursal ? total : 0,
      estadoCocina: tieneItemsDeCocina ? "pendiente" : "listo",
      estadoDelivery: "preparando",
      direccionDelivery: direccionDelivery || "Ubicacion GPS (Ver mapa)",
      notasCliente,
      gps: gpsValido ? gps : null,
      referenciaGPS: gpsValido ? `${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}` : "",
      mapaProveedor: "openstreetmap",
      mapaDeliveryUrl
    };

    const saleRef = db.collection(SALES_COLLECTION_PATH).doc();

    const userUpdate = {};
    if (puntosCanjeados > 0) {
      userUpdate.puntos = admin.firestore.FieldValue.increment(-puntosCanjeados);
    }
    if (esCreditoPremium && !creditoLibreSucursal) {
      userUpdate.deuda = admin.firestore.FieldValue.increment(total);
    }
    if (telefonoContacto) {
      userUpdate.telefono = telefonoContacto;
    }
    if (direccionDelivery) {
      userUpdate.ultimaDireccionDelivery = direccionDelivery;
    }
    if (gpsValido) {
      userUpdate.ultimaUbicacionDelivery = gps;
      userUpdate.ubicacionActualizadaAt = new Date().toISOString();
    }
    await db.runTransaction(async (transaction) => {
      const currentUserSnap = await transaction.get(userRef);
      const currentUserData = currentUserSnap.exists ? (currentUserSnap.data() || {}) : null;
      if (!currentUserData || currentUserData.rol !== "cliente") {
        throw new HttpsError("failed-precondition", "El perfil del cliente cambio mientras se procesaba el pedido.");
      }
      if (cleanNumber(currentUserData.puntos, 0) < puntosCanjeados) {
        throw new HttpsError("failed-precondition", "No tienes puntos suficientes para este canje.");
      }

      reservasStock = await prepararReservasStockPedido(items, sucursal, transaction);
      transaction.set(saleRef, payload);
      reservasStock.forEach((reserva) => {
        transaction.update(reserva.ref, {
          stock: admin.firestore.FieldValue.increment(-reserva.cantidad)
        });
      });
      if (Object.keys(userUpdate).length > 0) {
        transaction.update(userRef, userUpdate);
      }
    });

    await trackGa4Event({
      name: "purchase",
      clientId: `cliente_${request.auth.uid}`,
      userId: request.auth.uid,
      params: {
        transaction_id: saleRef.id,
        ticket_id: ticketId,
        value: total,
        currency: "PYG",
        branch_name: sucursal,
        payment_type: payload.metodoPago,
        shipping_tier: tipoEntrega,
        items_count: items.reduce((sum, item) => sum + cleanNumber(item.cantidad, 0), 0),
        points_redeemed: puntosCanjeados,
        app_origin: "app_cliente"
      }
    });

    try {
      const tokenCliente = String(userData.pushTokenMovil || "").trim();
      if (tokenCliente && String(userData.pushPermiso || "") === "granted") {
        await messaging.sendEachForMulticast({
          tokens: [tokenCliente],
          notification: {
            title: "Pedido recibido",
            body: `Tu pedido fue recibido en ${sucursal}.`
          },
          android: {
            priority: "high",
            notification: {
              channelId: "club_lin_promos",
              sound: "default",
              color: "#C96B2C"
            }
          },
          data: {
            route: "orders",
            saleId: saleRef.id,
            ticketId,
            titulo: "Pedido recibido",
            mensaje: `Tu pedido fue recibido en ${sucursal}.`
          }
        });
      }
    } catch (pushClienteError) {
      logger.error("No se pudo enviar push inicial al cliente", {
        message: pushClienteError?.message || String(pushClienteError),
        saleId: saleRef.id,
        clienteId: request.auth.uid
      });
    }

    try {
      const deliverySnap = await db.collection("users")
        .where("rol", "==", "delivery")
        .where("pushPermiso", "==", "granted")
        .get();

      const deliveryTokens = [];
      deliverySnap.forEach((docSnap) => {
        const deliveryData = docSnap.data() || {};
        const sucursalDelivery = normalizeText(deliveryData.sucursal || "");
        if (sucursalDelivery && sucursalDelivery !== normalizeText(sucursal)) return;
        const token = String(deliveryData.pushTokenMovil || "").trim();
        if (token) deliveryTokens.push(token);
      });

      if (deliveryTokens.length > 0) {
        await messaging.sendEachForMulticast({
          tokens: Array.from(new Set(deliveryTokens)),
          notification: {
            title: "Nuevo pedido para delivery",
            body: `${cleanText(userData.nombre, 80) || "Cliente"} - ${sucursal}`
          },
          android: {
            priority: "high",
            notification: {
              channelId: "delivery_pedidos",
              sound: "default",
              color: "#1E3A8A"
            }
          },
          data: {
            route: "app_delivery",
            saleId: saleRef.id,
            ticketId,
            sucursal,
            total: String(total)
          }
        });
      }
    } catch (pushError) {
      logger.error("No se pudo enviar push a delivery", {
        message: pushError?.message || String(pushError),
        sucursal,
        saleId: saleRef.id
      });
    }

    return {
      ok: true,
      saleId: saleRef.id,
      ticketId,
      metodoPago: payload.metodoPago,
      creditoLibreSucursal,
      deudaActualizada: esCreditoPremium && !creditoLibreSucursal ? (cleanNumber(userData.deuda, 0) + total) : cleanNumber(userData.deuda, 0),
      puntosRestantes: puntosCanjeados > 0 ? Math.max(0, cleanNumber(userData.puntos, 0) - puntosCanjeados) : cleanNumber(userData.puntos, 0)
    };
  }
);

exports.sincronizarProduccionVentas = onDocumentWritten(
  {
    document: `${SALES_COLLECTION_PATH}/{saleId}`,
    region: "us-central1"
  },
  async (event) => {
    const beforeData = event.data?.before?.exists ? (event.data.before.data() || {}) : null;
    const afterData = event.data?.after?.exists ? (event.data.after.data() || {}) : null;
    if (!beforeData && !afterData) return;

    const beforeConsumption = buildProductionConsumptionMap(beforeData);
    const afterConsumption = buildProductionConsumptionMap(afterData);
    const branchKeys = new Set([...beforeConsumption.keys(), ...afterConsumption.keys()]);
    const deltas = [];

    for (const branchKey of branchKeys) {
      const beforeEntry = beforeConsumption.get(branchKey) || {};
      const afterEntry = afterConsumption.get(branchKey) || {};
      const beforeValue = beforeEntry.cantidad || 0;
      const afterValue = afterEntry.cantidad || 0;
      const diff = afterValue - beforeValue;
      const panesDiff = Number(afterEntry.panes || 0) - Number(beforeEntry.panes || 0);
      const papasDiff = Number(afterEntry.papas || 0) - Number(beforeEntry.papas || 0);
      const carneSalteadoDiff = Number(afterEntry.carneSalteado || 0) - Number(beforeEntry.carneSalteado || 0);
      const carneLomitoDiff = Number(afterEntry.carneLomito || 0) - Number(beforeEntry.carneLomito || 0);
      const panLomitoDiff = Number(afterEntry.panLomito || 0) - Number(beforeEntry.panLomito || 0);
      if (diff !== 0 || panesDiff !== 0 || papasDiff !== 0 || carneSalteadoDiff !== 0 || carneLomitoDiff !== 0 || panLomitoDiff !== 0) {
        deltas.push({
          key: branchKey,
          sucursal: afterEntry.sucursal || beforeEntry.sucursal || "General",
          diff,
          panesDiff,
          papasDiff,
          carneSalteadoDiff,
          carneLomitoDiff,
          panLomitoDiff
        });
      }
    }

    if (deltas.length === 0) return;

    const saleRef = event.data.after?.exists ? event.data.after.ref : null;
    await db.runTransaction(async (transaction) => {
      for (const delta of deltas) {
        const configRef = db.collection("produccionConfig").doc(delta.key);
        const configSnap = await transaction.get(configRef);
        const baseData = configSnap.exists ? (configSnap.data() || {}) : {};

        transaction.set(configRef, {
          sucursal: baseData.sucursal || delta.sucursal,
          sucursalKey: delta.key,
          medallonesDisponibles: admin.firestore.FieldValue.increment(-delta.diff),
          medallonesConsumidos: admin.firestore.FieldValue.increment(delta.diff),
          panesDisponibles: admin.firestore.FieldValue.increment(-(delta.panesDiff || 0)),
          panesConsumidos: admin.firestore.FieldValue.increment(delta.panesDiff || 0),
          papasDisponibles: admin.firestore.FieldValue.increment(-(delta.papasDiff || 0)),
          papasConsumidos: admin.firestore.FieldValue.increment(delta.papasDiff || 0),
          carneSalteadoDisponible: admin.firestore.FieldValue.increment(-(delta.carneSalteadoDiff || 0)),
          carneSalteadoConsumida: admin.firestore.FieldValue.increment(delta.carneSalteadoDiff || 0),
          carneLomitoDisponible: admin.firestore.FieldValue.increment(-(delta.carneLomitoDiff || 0)),
          carneLomitoConsumida: admin.firestore.FieldValue.increment(delta.carneLomitoDiff || 0),
          panLomitoDisponible: admin.firestore.FieldValue.increment(-(delta.panLomitoDiff || 0)),
          panLomitoConsumido: admin.firestore.FieldValue.increment(delta.panLomitoDiff || 0),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedByNombre: "Sync ventas"
        }, { merge: true });
      }

      if (saleRef) {
        transaction.set(saleRef, {
          produccionSync: {
            version: 1,
            totalMedallones: mapTotalConsumption(afterConsumption),
            sucursales: Array.from(afterConsumption.entries()).map(([key, value]) => ({
              key,
              sucursal: value.sucursal,
              cantidad: value.cantidad
            })),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }
        }, { merge: true });
      }
    });

    logger.info("Produccion sincronizada desde venta", {
      saleId: saleRef?.id || event.params.saleId,
      totalAntes: mapTotalConsumption(beforeConsumption),
      totalDespues: mapTotalConsumption(afterConsumption),
      deltas
    });
  }
);
