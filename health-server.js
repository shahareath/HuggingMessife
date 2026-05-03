"use strict";

const http = require("http");
const fs = require("fs");
const net = require("net");

const PORT = Number(process.env.PORT || 7861);
const GATEWAY_PORT = Number(process.env.API_SERVER_PORT || 8642);
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 9119);
const TELEGRAM_WEBHOOK_PORT = Number(process.env.TELEGRAM_WEBHOOK_PORT || 8765);
const GATEWAY_HOST = "127.0.0.1";
const startTime = Date.now();
const API_SERVER_KEY = process.env.API_SERVER_KEY || "";
const APP_BASE = "/app";

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
    gateway,
    dashboard,
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
  const cls = state ? "ok" : "off";
  return `<span class="badge ${cls}">${label}</span>`;
}

function renderDashboard(data) {
  const syncStatus = String(data.backup?.status || "unknown").toUpperCase();
  const dashboardLink = data.dashboard ? `<a class="button" href="${APP_BASE}/">Open Hermes App</a>` : "";
  const apiLink = data.gateway ? `<a class="button secondary" href="/v1/models">API Models</a>` : "";
  const keepAlive = data.uptimerobot?.configured
    ? `UptimeRobot is monitoring <code>${data.uptimerobot.url}</code>.`
    : process.env.UPTIMEROBOT_API_KEY
      ? "UptimeRobot setup is pending or failed; check logs."
      : "Add UPTIMEROBOT_API_KEY to create a keep-awake monitor.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HuggingMess</title>
  <style>
    :root { color-scheme: dark; --bg:#10141f; --panel:#171d2b; --line:#293246; --text:#f4f7fb; --muted:#9aa7bd; --good:#22c55e; --warn:#f59e0b; --bad:#ef4444; --accent:#38bdf8; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
    main { width:min(960px, calc(100% - 32px)); margin:0 auto; padding:36px 0; }
    header { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; margin-bottom:28px; }
    h1 { margin:0; font-size:clamp(2rem, 6vw, 4.4rem); line-height:.95; letter-spacing:0; }
    .subtitle { margin-top:12px; color:var(--muted); max-width:620px; line-height:1.5; }
    .grid { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:14px; }
    .card { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:18px; min-height:120px; }
    .wide { grid-column:1 / -1; }
    .label { color:var(--muted); font-size:.78rem; letter-spacing:.08em; text-transform:uppercase; margin-bottom:10px; }
    .value { font-size:1.05rem; overflow-wrap:anywhere; }
    code { background:#0b0f18; border:1px solid var(--line); border-radius:6px; padding:2px 6px; }
    .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    .badge { display:inline-flex; border:1px solid var(--line); border-radius:999px; padding:5px 10px; font-size:.8rem; font-weight:700; }
    .badge.ok { color:var(--good); border-color:rgba(34,197,94,.35); background:rgba(34,197,94,.08); }
    .badge.off { color:var(--bad); border-color:rgba(239,68,68,.35); background:rgba(239,68,68,.08); }
    .button { display:inline-flex; align-items:center; justify-content:center; min-height:42px; padding:0 14px; border-radius:7px; color:#07111f; background:var(--accent); text-decoration:none; font-weight:750; }
    .button.secondary { color:var(--text); background:#222b3c; border:1px solid var(--line); }
    @media (max-width: 720px) { header { display:block; } .grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>HuggingMess</h1>
        <div class="subtitle">Hermes Agent running as an always-on Hugging Face Docker Space, with Telegram gateway, state backup, Cloudflare proxy support, and keep-awake monitoring.</div>
      </div>
      <div class="row">${badge("Gateway", data.gateway)}${badge("Dashboard", data.dashboard)}${badge("Backup", data.backup?.status !== "disabled")}</div>
    </header>
    <section class="grid">
      <div class="card"><div class="label">Uptime</div><div class="value">${data.uptime}</div></div>
      <div class="card"><div class="label">Model</div><div class="value"><code>${data.model || "not set"}</code></div></div>
      <div class="card"><div class="label">Provider</div><div class="value"><code>${data.provider}</code></div></div>
      <div class="card"><div class="label">Telegram</div><div class="value">${data.telegram.configured ? "Configured" : "Not configured"}${data.telegram.webhook ? " via webhook" : ""}</div></div>
      <div class="card wide"><div class="label">Backup</div><div class="value"><strong>${syncStatus}</strong><br>${data.backup?.message || ""}</div></div>
      <div class="card wide"><div class="label">Keep Awake</div><div class="value">${keepAlive}</div></div>
      <div class="card wide"><div class="label">Entrypoints</div><div class="row">${dashboardLink}${apiLink}<a class="button secondary" href="/status">Status JSON</a></div></div>
    </section>
  </main>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, "http://localhost");
  const path = parsed.pathname;

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
    if (API_SERVER_KEY) {
      const expected = `Bearer ${API_SERVER_KEY}`;
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized", message: "Use Authorization: Bearer <GATEWAY_TOKEN>." }));
        return;
      }
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
