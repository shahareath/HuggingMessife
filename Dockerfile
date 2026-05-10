# HuggingMes - Hermes Agent Gateway for Hugging Face Spaces

ARG HERMES_AGENT_VERSION=latest
FROM nousresearch/hermes-agent:${HERMES_AGENT_VERSION}

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    python3 \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libgbm1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxkbcommon0 \
    libx11-6 \
    libxext6 \
    libxfixes3 \
    libasound2 \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && uv pip install --python /opt/hermes/.venv/bin/python --no-cache-dir huggingface_hub

COPY --chown=hermes:hermes start.sh /opt/huggingmes/start.sh
COPY --chown=hermes:hermes health-server.js /opt/huggingmes/health-server.js
COPY --chown=hermes:hermes hermes-sync.py /opt/huggingmes/hermes-sync.py
COPY --chown=hermes:hermes cloudflare-proxy-setup.py /opt/huggingmes/cloudflare-proxy-setup.py
COPY --chown=hermes:hermes cloudflare-keepalive-setup.py /opt/huggingmes/cloudflare-keepalive-setup.py

RUN chmod +x \
    /opt/huggingmes/start.sh \
    /opt/huggingmes/hermes-sync.py \
    /opt/huggingmes/cloudflare-proxy-setup.py \
    /opt/huggingmes/cloudflare-keepalive-setup.py

# Patch kanban migration: wrap ALTER TABLE ADD COLUMN in try/except so a
# persisted DB with the column already present doesn't crash the gateway.
RUN python3 - <<'PY'
from pathlib import Path
import sys

p = Path("/opt/hermes/hermes_cli/kanban_db.py")
if not p.exists():
    sys.exit(0)

src = p.read_text(encoding="utf-8")
sentinel = "# huggingmes: idempotent-alter"
if sentinel in src:
    sys.exit(0)

old = (
    '    conn.execute(\n'
    '        "ALTER TABLE tasks ADD COLUMN consecutive_failures "\n'
    '        "INTEGER NOT NULL DEFAULT 0"\n'
    '    )'
)
new = (
    f'    try:  {sentinel}\n'
    '        conn.execute(\n'
    '            "ALTER TABLE tasks ADD COLUMN consecutive_failures "\n'
    '            "INTEGER NOT NULL DEFAULT 0"\n'
    '        )\n'
    '    except Exception:\n'
    '        pass'
)

if old not in src:
    print("kanban patch: pattern not found — may be fixed upstream, skipping")
    sys.exit(0)

p.write_text(src.replace(old, new), encoding="utf-8")
print("kanban patch: applied")
PY

# Ensure hermes CLI is discoverable in ALL shell types (login, interactive,
# non-interactive). /etc/profile.d/ is sourced by login shells after /etc/profile
# resets PATH, so this survives even full environment resets.
RUN echo 'export PATH="/opt/hermes/.venv/bin:/opt/data/.local/bin:$PATH"' \
    > /etc/profile.d/hermes-venv.sh

ENV HERMES_HOME=/opt/data \
    HUGGINGMES_APP_DIR=/opt/huggingmes \
    HERMES_AGENT_VERSION=${HERMES_AGENT_VERSION} \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 7861

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s \
  CMD curl -fsS http://localhost:7861/health || exit 1

CMD ["/opt/huggingmes/start.sh"]
