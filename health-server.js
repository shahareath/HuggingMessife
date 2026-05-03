"use strict";

const http = require("http");
const fs = require("fs");
const net = require("net");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 7861);
const GATEWAY_PORT = Number(process.env.API_SERVER_PORT || 8642);
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 9119);
const TELEGRAM_WEBHOOK_PORT = Number(process.env.TELEGRAM_WEBHOOK_PORT || 8765);
const GATEWAY_HOST = "127.0.0.1";
const startTime = Date.now();
const API_SERVER_KEY = process.env.API_SERVER_KEY || "";
const APP_BASE = "/app";
const LOGIN_PATH = "/login";
const LOGOUT_PATH = "/logout";
const SESSION_COOKIE = "huggingmess_session";

const SYNC_STATUS_FILE = "/tmp/huggingmess-sync-status.json";
const UPTIMEROBOT_STATUS_FILE = "/tmp/huggingmess-uptimerobot-status.json";

function canConnect(port, host = GATEWAY_HOST, timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function readJson(path, fallback = null) {
  try {
    if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {}
  return fallback;
}

function timingSafeEqualString(left, right) {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function expectedSessionValue() {
  if (!API_SERVER_KEY) return "";
  return crypto
    .createHmac("sha256", API_SERVER_KEY)
    .update("huggingmess-session-v1")
    .digest("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function isHttpsRequest(req) {
  return req.headers["x-forwarded-proto"] === "https";
}

function buildSessionCookie(req) {
  const secure = isHttpsRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(expectedSessionValue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`;
}

function buildClearSessionCookie(req) {
  const secure = isHttpsRequest(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function getBearerToken(req) {
  const value = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? match[1] : "";
}

function isAuthorized(req) {
  if (!API_SERVER_KEY) return true;
  return (
    timingSafeEqualString(getBearerToken(req), API_SERVER_KEY) ||
    timingSafeEqualString(parseCookies(req)[SESSION_COOKIE], expectedSessionValue())
  );
}

function sanitizeNext(value) {
  if (!value || typeof value !== "string") return `${APP_BASE}/`;
  if (!value.startsWith("/") || value.startsWith("//")) return `${APP_BASE}/`;
  return value;
}

function loginUrl(nextPath) {
  return `${LOGIN_PATH}?next=${encodeURIComponent(sanitizeNext(nextPath))}`;
}

function renderLoginPage(nextPath, errorMessage = "") {
  const safeNext = sanitizeNext(nextPath);
  const errorHtml = errorMessage ? `<div class="error">${escapeHtml(errorMessage)}</div>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HuggingMess Login</title>
  <style>
    :root { color-scheme: dark; --bg:#10141f; --panel:#171d2b; --line:#293246; --text:#f4f7fb; --muted:#9aa7bd; --bad:#ef4444; --accent:#38bdf8; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); padding:20px; }
    main { width:min(440px, 100%); border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:28px; }
    h1 { margin:0 0 8px; font-size:1.55rem; letter-spacing:0; }
    p { margin:0 0 22px; color:var(--muted); line-height:1.5; }
    label { display:block; color:var(--muted); font-size:.82rem; margin-bottom:8px; }
    input { width:100%; min-height:46px; border:1px solid var(--line); border-radius:7px; background:#0b0f18; color:var(--text); padding:0 12px; font:inherit; }
    button { width:100%; min-height:44px; margin-top:16px; border:0; border-radius:7px; color:#07111f; background:var(--accent); font:inherit; font-weight:750; cursor:pointer; }
    .error { border:1px solid rgba(239,68,68,.4); background:rgba(239,68,68,.1); color:#fecaca; border-radius:7px; padding:10px 12px; margin-bottom:16px; }
  </style>
</head>
<body>
  <main>
    <h1>Open HuggingMess</h1>
    <p>Enter the <code>GATEWAY_TOKEN</code> from your Space secrets.</p>
    ${errorHtml}
    <form method="post" action="${LOGIN_PATH}">
      <input type="hidden" name="next" value="${escapeHtml(safeNext)}" />
      <label for="token">GATEWAY_TOKEN</label>
      <input id="token" name="token" type="password" autocomplete="current-password" autofocus required />
      <button type="submit">Continue</button>
    </form>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readRequestBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function requireAuth(req, res) {
  if (isAuthorized(req)) return true;
  const parsed = new URL(req.url, "http://localhost");
  redirect(res, loginUrl(`${parsed.pathname}${parsed.search}`));
  return false;
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || "");
  return accept.includes("text/html");
}

async function handleLogin(req, res, parsed) {
  const nextPath = sanitizeNext(parsed.searchParams.get("next") || `${APP_BASE}/`);

  if (!API_SERVER_KEY) {
    redirect(res, nextPath);
    return;
  }

  if (req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(renderLoginPage(nextPath));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" });
    res.end("Method not allowed");
    return;
  }

  try {
    const body = await readRequestBody(req);
    const params = new URLSearchParams(body);
    const submittedToken = params.get("token") || "";
    const submittedNext = sanitizeNext(params.get("next") || nextPath);

    if (!timingSafeEqualString(submittedToken, API_SERVER_KEY)) {
      res.writeHead(401, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(renderLoginPage(submittedNext, "That token did not match GATEWAY_TOKEN."));
      return;
    }

    res.writeHead(302, {
      location: submittedNext,
      "set-cookie": buildSessionCookie(req),
      "cache-control": "no-store",
    });
    res.end();
  } catch (error) {
    res.writeHead(400, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(error.message || "Invalid login request.");
  }
}

function handleLogout(req, res) {
  res.writeHead(302, {
    location: LOGIN_PATH,
    "set-cookie": buildClearSessionCookie(req),
    "cache-control": "no-store",
  });
  res.end();
}

function proxyRequest(req, res, targetPort, rewritePath = (path) => path) {
  const parsed = new URL(req.url, "http://localhost");
  const targetPath = rewritePath(parsed.pathname) + parsed.search;
  const headers = {
    ...req.headers,
    host: `${GATEWAY_HOST}:${targetPort}`,
    "x-forwarded-host": req.headers.host || "",
    "x-forwarded-proto": req.headers["x-forwarded-proto"] || "https",
  };

  const proxy = http.request(
    {
      hostname: GATEWAY_HOST,
      port: targetPort,
      method: req.method,
      path: targetPath,
      headers,
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    },
  );

  proxy.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
  });

  req.pipe(proxy);
}

function redirect(res, location, statusCode = 302) {
  res.writeHead(statusCode, { location });
  res.end();
}

function formatUptime(ms) {
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function statusPayload() {
  const gateway = await canConnect(GATEWAY_PORT);
  const dashboard = await canConnect(DASHBOARD_PORT);
  const telegramWebhook =
    !!process.env.TELEGRAM_WEBHOOK_URL && (await canConnect(TELEGRAM_WEBHOOK_PORT));
  const sync = readJson(SYNC_STATUS_FILE, process.env.HF_TOKEN
    ? { status: "configured", message: "Backup is enabled; waiting for the first sync." }
    : { status: "disabled", message: "HF_TOKEN is not configured." });

  return {
    ok: gateway,
    uptime: formatUptime(Date.now() - startTime),
    startedAt: new Date(startTime).toISOString(),
    gateway,
    dashboard,
    authConfigured: !!API_SERVER_KEY,
    ports: {
      public: PORT,
      gateway: GATEWAY_PORT,
      dashboard: DASHBOARD_PORT,
      telegramWebhook: TELEGRAM_WEBHOOK_PORT,
    },
    telegram: {
      configured: !!process.env.TELEGRAM_BOT_TOKEN,
      webhook: !!process.env.TELEGRAM_WEBHOOK_URL,
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || "",
      webhookListening: telegramWebhook,
      proxy: process.env.CLOUDFLARE_PROXY_URL || "",
    },
    model: process.env.MODEL_FOR_CONFIG || process.env.HERMES_MODEL || process.env.LLM_MODEL || "",
    provider: process.env.PROVIDER_FOR_CONFIG || process.env.HERMES_INFERENCE_PROVIDER || "auto",
    backup: sync,
    uptimerobot: readJson(UPTIMEROBOT_STATUS_FILE, null),
  };
}

function badge(label, state) {
  return `<span class="badge ${state ? "ok" : "off"}">${escapeHtml(label)}</span>`;
}

function toneBadge(label, tone = "neutral") {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function valueOrUnset(value, fallback = "Not set") {
  return value ? escapeHtml(value) : `<span class="muted">${escapeHtml(fallback)}</span>`;
}

function renderTile({ title, value, detail = "", tone = "neutral", meta = "" }) {
  return `<article class="tile ${tone}">
    <div class="tile-head">
      <span class="tile-title">${escapeHtml(title)}</span>
      <span class="tile-dot"></span>
    </div>
    <div class="tile-value">${value}</div>
    ${detail ? `<div class="tile-detail">${detail}</div>` : ""}
    ${meta ? `<div class="tile-meta">${meta}</div>` : ""}
  </article>`;
}

function renderDashboard(data) {
  const syncStatus = String(data.backup?.status || "unknown");
  const syncTone = ["success", "restored", "synced", "configured"].includes(syncStatus) ? "ok" : syncStatus === "disabled" ? "warn" : "neutral";
  const telegramTone = data.telegram.configured ? (data.telegram.webhookListening || !data.telegram.webhook ? "ok" : "warn") : "warn";
  const keepAliveTone = data.uptimerobot?.configured ? "ok" : process.env.UPTIMEROBOT_API_KEY ? "warn" : "neutral";
  const publicBase = process.env.SPACE_HOST ? `https://${process.env.SPACE_HOST}` : `http://localhost:${PORT}`;
  const apiCurl = `curl -H "Authorization: Bearer $GATEWAY_TOKEN" ${publicBase}/v1/models`;
  const gatewayDetail = data.gateway
    ? `OpenAI-compatible API is listening on internal port <code>${data.ports.gateway}</code>.`
    : `Gateway API is not reachable on internal port <code>${data.ports.gateway}</code>.`;
  const appDetail = data.dashboard
    ? `Hermes dashboard is listening on internal port <code>${data.ports.dashboard}</code>.`
    : `Hermes dashboard is not reachable on internal port <code>${data.ports.dashboard}</code>.`;
  const authDetail = data.authConfigured
    ? `Protected by <code>GATEWAY_TOKEN</code> with a token-only login page.`
    : `No <code>GATEWAY_TOKEN</code> is set; public app routes are unlocked.`;
  const telegramDetail = data.telegram.configured
    ? `${data.telegram.webhook ? "Webhook mode" : "Polling mode"}${data.telegram.proxy ? ` through Cloudflare proxy` : ""}.`
    : "Add TELEGRAM_BOT_TOKEN to enable Telegram.";
  const backupDetail = data.backup?.message ? escapeHtml(data.backup.message) : "No backup status has been written yet.";
  const backupMeta = data.backup?.timestamp ? `Last update ${escapeHtml(data.backup.timestamp)}` : "";
  const keepAliveDetail = data.uptimerobot?.configured
    ? `Monitoring <code>${escapeHtml(data.uptimerobot.url || "/health")}</code>.`
    : process.env.UPTIMEROBOT_API_KEY
      ? "UptimeRobot setup is pending or failed; check Space logs."
      : "Add UPTIMEROBOT_API_KEY to create a keep-awake monitor.";
  const tiles = [
    renderTile({
      title: "Gateway",
      value: toneBadge(data.gateway ? "Online" : "Offline", data.gateway ? "ok" : "off"),
      detail: gatewayDetail,
      tone: data.gateway ? "ok" : "off",
      meta: `<code>/v1/models</code> requires token auth.`,
    }),
    renderTile({
      title: "Hermes App",
      value: toneBadge(data.dashboard ? "Ready" : "Starting", data.dashboard ? "ok" : "warn"),
      detail: appDetail,
      tone: data.dashboard ? "ok" : "warn",
      meta: `<code>/app/</code> opens in a new window.`,
    }),
    renderTile({
      title: "Auth",
      value: toneBadge(data.authConfigured ? "Token set" : "Unlocked", data.authConfigured ? "ok" : "warn"),
      detail: authDetail,
      tone: data.authConfigured ? "ok" : "warn",
      meta: data.authConfigured ? "Browser visits use the login page; API clients use Bearer auth." : "Set GATEWAY_TOKEN before sharing this Space.",
    }),
    renderTile({
      title: "Runtime",
      value: escapeHtml(data.uptime),
      detail: `Public port <code>${data.ports.public}</code>. Started <code>${escapeHtml(data.startedAt)}</code>.`,
      tone: "neutral",
      meta: `Health endpoint: <code>/health</code>`,
    }),
    renderTile({
      title: "Model",
      value: `<code>${valueOrUnset(data.model)}</code>`,
      detail: `Provider <code>${valueOrUnset(data.provider || "auto")}</code>.`,
      tone: data.model ? "ok" : "warn",
      meta: "For Gemini: LLM_MODEL=google/gemini-2.5-flash",
    }),
    renderTile({
      title: "Telegram",
      value: toneBadge(data.telegram.configured ? "Configured" : "Disabled", telegramTone),
      detail: telegramDetail,
      tone: telegramTone,
      meta: data.telegram.webhookUrl ? `<code>${escapeHtml(data.telegram.webhookUrl)}</code>` : "",
    }),
    renderTile({
      title: "Backup",
      value: toneBadge(syncStatus.toUpperCase(), syncTone),
      detail: backupDetail,
      tone: syncTone,
      meta: backupMeta,
    }),
    renderTile({
      title: "Keep Awake",
      value: toneBadge(data.uptimerobot?.configured ? "Monitor active" : "Not configured", keepAliveTone),
      detail: keepAliveDetail,
      tone: keepAliveTone,
      meta: process.env.UPTIMEROBOT_API_KEY ? "UPTIMEROBOT_API_KEY detected." : "",
    }),
  ].join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HuggingMess</title>
  <style>
    :root { color-scheme: dark; --bg:#101010; --panel:#171717; --panel2:#1e1e1e; --line:#303030; --text:#f3f4f6; --muted:#a1a1aa; --soft:#d4d4d8; --good:#4ade80; --warn:#fbbf24; --bad:#fb7185; --accent:#67e8f9; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); font-size:14px; }
    main { width:min(1180px, calc(100% - 32px)); margin:0 auto; padding:24px 0 32px; }
    header { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; margin-bottom:18px; border-bottom:1px solid var(--line); padding-bottom:18px; }
    h1 { margin:0; font-size:clamp(2rem, 4vw, 3.2rem); line-height:1; letter-spacing:0; }
    .subtitle { margin-top:10px; color:var(--muted); max-width:700px; line-height:1.45; font-size:.95rem; }
    .top-actions { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; min-width:300px; }
    .overview { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:10px; margin-bottom:10px; }
    .tile { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:14px; min-height:142px; display:flex; flex-direction:column; gap:10px; }
    .tile.ok { border-color:rgba(74,222,128,.28); }
    .tile.warn { border-color:rgba(251,191,36,.28); }
    .tile.off { border-color:rgba(251,113,133,.32); }
    .tile-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    .tile-title { color:var(--muted); font-size:.72rem; letter-spacing:.12em; text-transform:uppercase; font-weight:800; }
    .tile-dot { width:7px; height:7px; border-radius:50%; background:var(--line); }
    .tile.ok .tile-dot { background:var(--good); }
    .tile.warn .tile-dot { background:var(--warn); }
    .tile.off .tile-dot { background:var(--bad); }
    .tile-value { font-size:1.05rem; font-weight:760; overflow-wrap:anywhere; }
    .tile-detail { color:var(--soft); line-height:1.45; font-size:.86rem; }
    .tile-meta { color:var(--muted); line-height:1.4; font-size:.78rem; margin-top:auto; overflow-wrap:anywhere; }
    .panel { border:1px solid var(--line); background:var(--panel2); border-radius:8px; padding:14px; margin-top:10px; }
    .panel-title { color:var(--muted); font-size:.72rem; letter-spacing:.12em; text-transform:uppercase; font-weight:800; margin-bottom:10px; }
    code { background:#0d0d0d; border:1px solid var(--line); border-radius:6px; padding:2px 5px; color:var(--text); font-size:.9em; }
    pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; background:#0d0d0d; border:1px solid var(--line); border-radius:7px; padding:10px; color:var(--soft); font-size:.82rem; line-height:1.45; }
    .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
    .badge { display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:4px 9px; font-size:.75rem; font-weight:800; line-height:1; }
    .badge.ok { color:var(--good); border-color:rgba(74,222,128,.36); background:rgba(74,222,128,.08); }
    .badge.warn { color:var(--warn); border-color:rgba(251,191,36,.34); background:rgba(251,191,36,.08); }
    .badge.off { color:var(--bad); border-color:rgba(251,113,133,.36); background:rgba(251,113,133,.08); }
    .badge.neutral { color:var(--soft); }
    .muted { color:var(--muted); }
    .button { display:inline-flex; align-items:center; justify-content:center; min-height:34px; padding:0 11px; border-radius:7px; color:#081012; background:var(--accent); text-decoration:none; font-weight:800; font-size:.86rem; }
    .button.secondary { color:var(--text); background:#242424; border:1px solid var(--line); }
    .button.subtle { color:var(--soft); background:transparent; border:1px solid var(--line); }
    @media (max-width: 980px) { .overview { grid-template-columns:repeat(2, minmax(0, 1fr)); } header { display:block; } .top-actions { justify-content:flex-start; margin-top:14px; min-width:0; } }
    @media (max-width: 620px) { main { width:min(100% - 20px, 1180px); padding-top:16px; } .overview { grid-template-columns:1fr; } h1 { font-size:2rem; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>HuggingMess</h1>
        <div class="subtitle">Hermes Agent on Hugging Face Spaces: app gateway, OpenAI-compatible API, Telegram webhook, Cloudflare proxy, backup, and keep-awake state in one place.</div>
      </div>
      <div class="top-actions">
        <a class="button" href="${APP_BASE}/" target="_blank" rel="noopener noreferrer">Open App</a>
        <a class="button secondary" href="/v1/models" target="_blank" rel="noopener noreferrer">Models</a>
        <a class="button secondary" href="/status">Status JSON</a>
        <a class="button subtle" href="${LOGOUT_PATH}">Logout</a>
      </div>
    </header>
    <section class="overview">
      ${tiles}
    </section>
    <section class="panel">
      <div class="panel-title">API Access</div>
      <pre>${escapeHtml(apiCurl)}</pre>
    </section>
  </main>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const path = parsed.pathname;

  if (path === LOGIN_PATH) {
    await handleLogin(req, res, parsed);
    return;
  }

  if (path === LOGOUT_PATH) {
    handleLogout(req, res);
    return;
  }

  if (path === "/health" || path === `${APP_BASE}/health`) {
    const data = await statusPayload();
    res.writeHead(data.ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: data.ok, gateway: data.gateway, uptime: data.uptime }));
    return;
  }

  if (path === "/status" || path === `${APP_BASE}/status`) {
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
    return;
  }

  if (path === "/") {
    const data = await statusPayload();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDashboard(data));
    return;
  }

  if (path === "/dashboard" || path === "/dashboard/") {
    redirect(res, `${APP_BASE}/${parsed.search}`);
    return;
  }

  if (path === "/telegram" || path.startsWith("/telegram/")) {
    proxyRequest(req, res, TELEGRAM_WEBHOOK_PORT);
    return;
  }

  if (path === APP_BASE || path.startsWith(`${APP_BASE}/`)) {
    if (!requireAuth(req, res)) return;
    proxyRequest(req, res, DASHBOARD_PORT, (p) => p.replace(/^\/app/, "") || "/");
    return;
  }

  if (
    path === "/favicon.ico" ||
    path.startsWith("/assets/") ||
    path.startsWith("/api/") ||
    path.startsWith("/dashboard-plugins/") ||
    path.startsWith("/ds-assets/")
  ) {
    if (!requireAuth(req, res)) return;
    proxyRequest(req, res, DASHBOARD_PORT);
    return;
  }

  if (
    [
      "/analytics",
      "/chat",
      "/config",
      "/cron",
      "/docs",
      "/env",
      "/logs",
      "/models",
      "/plugins",
      "/profiles",
      "/sessions",
      "/skills",
    ].some((route) => path === route || path.startsWith(`${route}/`))
  ) {
    redirect(res, `${APP_BASE}${path}${parsed.search}`);
    return;
  }

  if (path === "/v1" || path.startsWith("/v1/")) {
    if (!isAuthorized(req)) {
      if (wantsHtml(req)) {
        redirect(res, loginUrl(`${path}${parsed.search}`));
        return;
      }
      res.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ error: "unauthorized", message: "Use Authorization: Bearer <GATEWAY_TOKEN>." }));
      return;
    }
    proxyRequest(req, res, GATEWAY_PORT);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HuggingMess dashboard listening on 0.0.0.0:${PORT}`);
});
