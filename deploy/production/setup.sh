#!/usr/bin/env bash
#
# AgoraMesh production server setup (one-time)
# Target: dev.timutti.cz (Ubuntu 24.04)
#
# Usage: ssh root@dev.timutti.cz < setup.sh
#    or: scp setup.sh root@dev.timutti.cz: && ssh root@dev.timutti.cz ./setup.sh
#
set -euo pipefail

echo "=== AgoraMesh Production Setup ==="

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

cp "$NGINX_SRC/agoramesh-api.conf" /etc/nginx/sites-available/agoramesh-api
cp "$NGINX_SRC/agoramesh-bridge.conf" /etc/nginx/sites-available/agoramesh-bridge
cp "$NGINX_SRC/agoramesh-web.conf" /etc/nginx/sites-available/agoramesh-web

# Symlink to sites-enabled (idempotent)
ln -sf /etc/nginx/sites-available/agoramesh-api /etc/nginx/sites-enabled/agoramesh-api
ln -sf /etc/nginx/sites-available/agoramesh-bridge /etc/nginx/sites-enabled/agoramesh-bridge
ln -sf /etc/nginx/sites-available/agoramesh-web /etc/nginx/sites-enabled/agoramesh-web

# Test config before reload
nginx -t
systemctl reload nginx
echo "Nginx configured and reloaded."

# ---------------------------------------------------------------------------
# Placeholder website
# ---------------------------------------------------------------------------
echo "--- Creating placeholder website ---"
mkdir -p /var/www/agoramesh
if [ ! -f /var/www/agoramesh/index.html ]; then
    cat > /var/www/agoramesh/index.html <<'HTMLEOF'
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>AgoraMesh</title>
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
        <h1>AgoraMesh</h1>
        <p>Decentralized marketplace and trust layer for AI agents.</p>
        <p><a href="https://github.com/timutti/agoramesh">GitHub</a></p>
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
echo "--- Setting up /opt/agoramesh ---"
mkdir -p /opt/agoramesh

if [ ! -f /opt/agoramesh/docker-compose.yml ]; then
    cp "$SCRIPT_DIR/docker-compose.yml" /opt/agoramesh/docker-compose.yml
    echo "docker-compose.yml copied to /opt/agoramesh/"
else
    echo "docker-compose.yml already exists in /opt/agoramesh/, skipping."
fi

# Reminder for .env
if [ ! -f /opt/agoramesh/.env ]; then
    echo ""
    echo "WARNING: /opt/agoramesh/.env does not exist."
    echo "Create it with:"
    echo "  echo 'BRIDGE_AGENT_PRIVATE_KEY=0x...' > /opt/agoramesh/.env"
    echo "  echo 'BRIDGE_API_TOKEN=change-me' >> /opt/agoramesh/.env"
    echo "  echo 'AGORAMESH_API_TOKEN=change-me' >> /opt/agoramesh/.env"
    echo "  chmod 600 /opt/agoramesh/.env"
    echo ""
fi

# ---------------------------------------------------------------------------
# TLS Certificates
# ---------------------------------------------------------------------------
echo "--- TLS Certificates ---"
echo "Run the following command to obtain TLS certificates:"
echo ""
echo "  certbot --nginx -d api.agoramesh.ai -d bridge.agoramesh.ai -d agoramesh.ai -d www.agoramesh.ai"
echo ""
echo "Certbot will modify nginx configs to add SSL blocks and set up auto-renewal."

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Create /opt/agoramesh/.env with BRIDGE_AGENT_PRIVATE_KEY"
echo "  2. Run certbot command above for TLS"
echo "  3. Add deploy SSH key to GitHub secrets (DEPLOY_SSH_KEY, DEPLOY_HOST)"
echo "  4. Push to master to trigger first deployment"
echo "  5. After first push: make GHCR packages public in GitHub Settings > Packages"
echo ""
