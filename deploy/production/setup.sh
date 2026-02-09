#!/usr/bin/env bash
#
# AgentMesh production server setup (one-time)
# Target: dev.timutti.cz (Ubuntu 24.04)
#
# Usage: ssh root@dev.timutti.cz < setup.sh
#    or: scp setup.sh root@dev.timutti.cz: && ssh root@dev.timutti.cz ./setup.sh
#
set -euo pipefail

echo "=== AgentMesh Production Setup ==="

# ---------------------------------------------------------------------------
# Safety: verify SSH access rule exists before touching firewall
# ---------------------------------------------------------------------------
echo "--- Checking firewall SSH rule ---"
if ! ufw status | grep -qE "22/tcp.*ALLOW"; then
    echo "ERROR: SSH rule (22/tcp ALLOW) not found in ufw. Aborting to avoid lockout."
    exit 1
fi

# ---------------------------------------------------------------------------
# Firewall — additive only, never reset or remove existing rules
# ---------------------------------------------------------------------------
echo "--- Configuring firewall (additive) ---"
ufw allow 80/tcp comment "HTTP"
ufw allow 443/tcp comment "HTTPS"
# P2P port (4001) intentionally NOT opened — reduces attack surface
ufw --force enable
echo "Firewall rules:"
ufw status numbered

# ---------------------------------------------------------------------------
# Nginx site configs
# ---------------------------------------------------------------------------
echo "--- Installing nginx configs ---"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Copy configs from deploy/production/nginx/ if running from repo,
# otherwise expect them in the same directory as this script
NGINX_SRC="${SCRIPT_DIR}/nginx"
if [ ! -d "$NGINX_SRC" ]; then
    echo "ERROR: nginx config directory not found at $NGINX_SRC"
    echo "Copy deploy/production/nginx/*.conf to the server first."
    exit 1
fi

cp "$NGINX_SRC/agentme-api.conf" /etc/nginx/sites-available/agentme-api
cp "$NGINX_SRC/agentme-bridge.conf" /etc/nginx/sites-available/agentme-bridge
cp "$NGINX_SRC/agentme-web.conf" /etc/nginx/sites-available/agentme-web

# Symlink to sites-enabled (idempotent)
ln -sf /etc/nginx/sites-available/agentme-api /etc/nginx/sites-enabled/agentme-api
ln -sf /etc/nginx/sites-available/agentme-bridge /etc/nginx/sites-enabled/agentme-bridge
ln -sf /etc/nginx/sites-available/agentme-web /etc/nginx/sites-enabled/agentme-web

# Test config before reload
nginx -t
systemctl reload nginx
echo "Nginx configured and reloaded."

# ---------------------------------------------------------------------------
# Placeholder website
# ---------------------------------------------------------------------------
echo "--- Creating placeholder website ---"
mkdir -p /var/www/agentme
if [ ! -f /var/www/agentme/index.html ]; then
    cat > /var/www/agentme/index.html <<'HTMLEOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AgentMesh</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex; justify-content: center; align-items: center;
            min-height: 100vh; margin: 0;
            background: #0a0a0a; color: #e0e0e0;
        }
        .container { text-align: center; max-width: 600px; padding: 2rem; }
        h1 { font-size: 2.5rem; margin-bottom: 0.5rem; }
        p { color: #888; font-size: 1.1rem; }
        a { color: #6366f1; text-decoration: none; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <div class="container">
        <h1>AgentMesh</h1>
        <p>Decentralized marketplace and trust layer for AI agents.</p>
        <p><a href="https://github.com/timutti/agentmesh">GitHub</a></p>
    </div>
</body>
</html>
HTMLEOF
    echo "Placeholder index.html created."
else
    echo "index.html already exists, skipping."
fi

# ---------------------------------------------------------------------------
# Application directory
# ---------------------------------------------------------------------------
echo "--- Setting up /opt/agentmesh ---"
mkdir -p /opt/agentmesh

if [ ! -f /opt/agentmesh/docker-compose.yml ]; then
    cp "$SCRIPT_DIR/docker-compose.yml" /opt/agentmesh/docker-compose.yml
    echo "docker-compose.yml copied to /opt/agentmesh/"
else
    echo "docker-compose.yml already exists in /opt/agentmesh/, skipping."
fi

# Reminder for .env
if [ ! -f /opt/agentmesh/.env ]; then
    echo ""
    echo "WARNING: /opt/agentmesh/.env does not exist."
    echo "Create it with:"
    echo "  echo 'BRIDGE_AGENT_PRIVATE_KEY=0x...' > /opt/agentmesh/.env"
    echo "  echo 'BRIDGE_API_TOKEN=change-me' >> /opt/agentmesh/.env"
    echo "  echo 'AGENTMESH_API_TOKEN=change-me' >> /opt/agentmesh/.env"
    echo "  chmod 600 /opt/agentmesh/.env"
    echo ""
fi

# ---------------------------------------------------------------------------
# TLS Certificates
# ---------------------------------------------------------------------------
echo "--- TLS Certificates ---"
echo "Run the following command to obtain TLS certificates:"
echo ""
echo "  certbot --nginx -d api.agentme.cz -d bridge.agentme.cz -d agentme.cz -d www.agentme.cz"
echo ""
echo "Certbot will modify nginx configs to add SSL blocks and set up auto-renewal."

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Create /opt/agentmesh/.env with BRIDGE_AGENT_PRIVATE_KEY"
echo "  2. Run certbot command above for TLS"
echo "  3. Add deploy SSH key to GitHub secrets (DEPLOY_SSH_KEY, DEPLOY_HOST)"
echo "  4. Push to master to trigger first deployment"
echo "  5. After first push: make GHCR packages public in GitHub Settings > Packages"
echo ""
