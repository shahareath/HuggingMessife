#!/usr/bin/env python3
from __future__ import annotations

"""Create or reuse Cloudflare Workers for Telegram proxy and Space keep-awake."""

import json
import os
import re
import secrets
import sys
import time
import urllib.request
from pathlib import Path

API_BASE = "https://api.cloudflare.com/client/v4"
ENV_FILE = Path("/tmp/huggingmess-cloudflare-proxy.env")
KEEPALIVE_STATUS_FILE = Path("/tmp/huggingmess-cloudflare-keepalive-status.json")
DEFAULT_ALLOWED = [
    "api.telegram.org",
    "discord.com",
    "discordapp.com",
    "gateway.discord.gg",
    "status.discord.com",
    "slack.com",
    "api.slack.com",
    "web.whatsapp.com",
    "graph.facebook.com",
    "graph.instagram.com",
    "api.openai.com",
    "googleapis.com",
    "google.com",
    "googleusercontent.com",
    "gstatic.com",
]


def cf_request(method: str, path: str, token: str, body: bytes | None = None, content_type: str = "application/json"):
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        data=body,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": content_type},
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not payload.get("success"):
        errors = payload.get("errors") or [{"message": "Unknown Cloudflare API error"}]
        raise RuntimeError(errors[0].get("message", "Unknown Cloudflare API error"))
    return payload["result"]


def slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9-]+", "-", value.lower()).strip("-")
    cleaned = re.sub(r"-{2,}", "-", cleaned)
    return (cleaned or "huggingmess-proxy")[:63].rstrip("-")


def derive_worker_name() -> str:
    explicit = os.environ.get("CLOUDFLARE_WORKER_NAME", "").strip()
    if explicit:
        return slugify(explicit)
    space_host = os.environ.get("SPACE_HOST", "").strip()
    if space_host:
        return slugify(f"{space_host.replace('.hf.space', '')}-proxy")
    return "huggingmess-proxy"


def derive_keepalive_worker_name() -> str:
    explicit = os.environ.get("CLOUDFLARE_KEEPALIVE_WORKER_NAME", "").strip()
    if explicit:
        return slugify(explicit)
    space_host = os.environ.get("SPACE_HOST", "").strip()
    if space_host:
        return slugify(f"{space_host.replace('.hf.space', '')}-keepalive")
    return "huggingmess-keepalive"


def render_worker(secret_value: str, allowed_targets: list[str], allow_proxy_all: bool) -> str:
    return f"""addEventListener("fetch", (event) => {{
  event.respondWith(handleRequest(event.request));
}});

const PROXY_SHARED_SECRET = {json.dumps(secret_value)};
const ALLOW_PROXY_ALL = {"true" if allow_proxy_all else "false"};
const ALLOWED_TARGETS = {json.dumps(allowed_targets)};

function isAllowedHost(hostname) {{
  const normalized = String(hostname || "").trim().toLowerCase();
  if (!normalized) return false;
  if (ALLOW_PROXY_ALL) return true;
  return ALLOWED_TARGETS.some((domain) => normalized === domain || normalized.endsWith(`.${{domain}}`));
}}

async function handleRequest(request) {{
  const url = new URL(request.url);
  const queryTarget = url.searchParams.get("proxy_target");
  const targetHost = request.headers.get("x-target-host") || queryTarget;

  if (PROXY_SHARED_SECRET) {{
    const providedSecret = request.headers.get("x-proxy-key") || url.searchParams.get("proxy_key") || "";
    const telegramStylePath = url.pathname.startsWith("/bot") || url.pathname.startsWith("/file/bot");
    if (providedSecret !== PROXY_SHARED_SECRET && !(telegramStylePath && !targetHost)) {{
      return new Response("Unauthorized: Invalid proxy key", {{ status: 401 }});
    }}
  }}

  let targetBase = "";
  if (targetHost) {{
    if (!isAllowedHost(targetHost)) {{
      return new Response(`Forbidden: Host ${{targetHost}} is not allowed.`, {{ status: 403 }});
    }}
    targetBase = `https://${{targetHost}}`;
  }} else if (url.pathname.startsWith("/bot") || url.pathname.startsWith("/file/bot")) {{
    targetBase = "https://api.telegram.org";
  }} else {{
    return new Response("Invalid request: No target host provided.", {{ status: 400 }});
  }}

  const cleanSearch = new URLSearchParams(url.search);
  cleanSearch.delete("proxy_target");
  cleanSearch.delete("proxy_key");
  const searchStr = cleanSearch.toString();
  const targetUrl = targetBase + url.pathname + (searchStr ? `?${{searchStr}}` : "");

  const headers = new Headers(request.headers);
  for (const header of ["cf-connecting-ip", "cf-ray", "cf-visitor", "host", "x-real-ip", "x-target-host", "x-proxy-key"]) {{
    headers.delete(header);
  }}

  try {{
    return await fetch(new Request(targetUrl, {{
      method: request.method,
      headers,
      body: request.body,
      redirect: "follow",
    }}));
  }} catch (error) {{
    return new Response(`Proxy Error: ${{error.message}}`, {{ status: 502 }});
  }}
}}
"""


def render_keepalive_worker(target_url: str) -> str:
    return f"""addEventListener("fetch", (event) => {{
  event.respondWith(handleRequest(event.request));
}});

addEventListener("scheduled", (event) => {{
  event.waitUntil(ping("cron"));
}});

const TARGET_URL = {json.dumps(target_url)};

async function ping(source) {{
  const startedAt = new Date().toISOString();
  try {{
    const response = await fetch(TARGET_URL, {{
      method: "GET",
      headers: {{
        "user-agent": "HuggingMess Cloudflare KeepAlive",
        "cache-control": "no-cache"
      }},
      cf: {{ cacheTtl: 0, cacheEverything: false }}
    }});
    return {{
      ok: response.ok,
      status: response.status,
      source,
      target: TARGET_URL,
      timestamp: startedAt
    }};
  }} catch (error) {{
    return {{
      ok: false,
      status: 0,
      source,
      target: TARGET_URL,
      timestamp: startedAt,
      error: error.message
    }};
  }}
}}

async function handleRequest(request) {{
  const url = new URL(request.url);
  if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/ping") {{
    const result = await ping("manual");
    return new Response(JSON.stringify(result, null, 2), {{
      status: result.ok ? 200 : 502,
      headers: {{ "content-type": "application/json; charset=utf-8" }}
    }});
  }}
  return new Response("Not found", {{ status: 404 }});
}}
"""


def write_env(proxy_url: str, proxy_secret: str) -> None:
    ENV_FILE.write_text(
        f'export CLOUDFLARE_PROXY_URL="{proxy_url}"\nexport CLOUDFLARE_PROXY_SECRET="{proxy_secret}"\n',
        encoding="utf-8",
    )
    ENV_FILE.chmod(0o600)


def write_keepalive_status(payload: dict) -> None:
    payload = {
        **payload,
        "timestamp": payload.get("timestamp") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    KEEPALIVE_STATUS_FILE.write_text(json.dumps(payload), encoding="utf-8")
    try:
        KEEPALIVE_STATUS_FILE.chmod(0o600)
    except OSError:
        pass


def resolve_account_and_subdomain(api_token: str) -> tuple[str, str]:
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    if not account_id:
        accounts = cf_request("GET", "/accounts", api_token)
        if not accounts:
            raise RuntimeError("No Cloudflare account is available for this token.")
        account_id = accounts[0]["id"]

    subdomain_info = cf_request("GET", f"/accounts/{account_id}/workers/subdomain", api_token)
    subdomain = (subdomain_info or {}).get("subdomain", "").strip()
    if not subdomain:
        raise RuntimeError("Cloudflare Workers subdomain is not configured. Enable workers.dev first.")
    return account_id, subdomain


def setup_keepalive_worker(api_token: str, account_id: str, subdomain: str) -> None:
    enabled = os.environ.get("CLOUDFLARE_KEEPALIVE_ENABLED", "true").strip().lower()
    if enabled in {"0", "false", "no", "off"}:
        write_keepalive_status({"configured": False, "status": "disabled", "message": "Cloudflare keep-awake is disabled."})
        return

    space_host = os.environ.get("SPACE_HOST", "").strip()
    if not space_host:
        write_keepalive_status({"configured": False, "status": "skipped", "message": "SPACE_HOST is not set."})
        return

    cron = os.environ.get("CLOUDFLARE_KEEPALIVE_CRON", "*/10 * * * *").strip()
    space_host = space_host.removeprefix("https://").removeprefix("http://").split("/")[0]
    target_url = os.environ.get("CLOUDFLARE_KEEPALIVE_URL", f"https://{space_host}/health").strip()
    worker_name = derive_keepalive_worker_name()
    worker_source = render_keepalive_worker(target_url)

    cf_request(
        "PUT",
        f"/accounts/{account_id}/workers/scripts/{worker_name}",
        api_token,
        body=worker_source.encode("utf-8"),
        content_type="application/javascript",
    )
    cf_request(
        "POST",
        f"/accounts/{account_id}/workers/scripts/{worker_name}/subdomain",
        api_token,
        body=json.dumps({"enabled": True, "previews_enabled": True}).encode("utf-8"),
    )
    cf_request(
        "PUT",
        f"/accounts/{account_id}/workers/scripts/{worker_name}/schedules",
        api_token,
        body=json.dumps([{"cron": cron}]).encode("utf-8"),
    )

    worker_url = f"https://{worker_name}.{subdomain}.workers.dev"
    write_keepalive_status(
        {
            "configured": True,
            "status": "configured",
            "workerName": worker_name,
            "workerUrl": worker_url,
            "targetUrl": target_url,
            "cron": cron,
            "message": f"Cloudflare Worker cron pings {target_url} on {cron}.",
        }
    )


def main() -> int:
    existing_url = os.environ.get("CLOUDFLARE_PROXY_URL", "").strip()
    existing_secret = os.environ.get("CLOUDFLARE_PROXY_SECRET", "").strip()
    api_token = os.environ.get("CLOUDFLARE_WORKERS_TOKEN", "").strip()

    if existing_url:
        write_env(existing_url, existing_secret)

    if not api_token:
        return 0

    try:
        account_id, subdomain = resolve_account_and_subdomain(api_token)

        if not existing_url:
            allowed_raw = os.environ.get("CLOUDFLARE_PROXY_DOMAINS", "").strip()
            allow_proxy_all = allowed_raw == "*"
            extra = [] if allow_proxy_all else [v.strip() for v in allowed_raw.split(",") if v.strip()]
            allowed = list(dict.fromkeys(DEFAULT_ALLOWED + extra))
            worker_name = derive_worker_name()
            proxy_secret = existing_secret or secrets.token_urlsafe(24)

            cf_request(
                "PUT",
                f"/accounts/{account_id}/workers/scripts/{worker_name}",
                api_token,
                body=render_worker(proxy_secret, allowed, allow_proxy_all).encode("utf-8"),
                content_type="application/javascript",
            )
            cf_request(
                "POST",
                f"/accounts/{account_id}/workers/scripts/{worker_name}/subdomain",
                api_token,
                body=json.dumps({"enabled": True, "previews_enabled": True}).encode("utf-8"),
            )
            write_env(f"https://{worker_name}.{subdomain}.workers.dev", proxy_secret)

        setup_keepalive_worker(api_token, account_id, subdomain)
        return 0
    except Exception as exc:
        print(f"Cloudflare proxy setup failed: {exc}", file=sys.stderr)
        write_keepalive_status({"configured": False, "status": "error", "message": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
