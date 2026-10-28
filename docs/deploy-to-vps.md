# Deploy to VPS

Production-ready deployment guide for Lumen Chain node + explorer.

## Prerequisites

- VPS with **2 GB RAM** and **2 CPU cores** minimum (Hetzner CX22, DO droplet, etc.)
- Domain name pointed to your VPS IP (for SSL)
- SSH access with sudo privileges
- Git installed locally (for cloud-init path)

---

## 1. VPS Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| RAM | 2 GB | 4 GB |
| CPU | 2 cores | 2 cores |
| Disk | 20 GB SSD | 50 GB NVMe |
| OS | Ubuntu 22.04 / 24.04 | Ubuntu 24.04 LTS |
| Network | 1 Gbps | 1 Gbps |
| Ports | 80, 443, 8789 (P2P), 22 (SSH) | same |

---

## 2. Docker Deployment

### 2.1 Prepare the environment

```bash
# 1. SSH into your VPS
ssh root@YOUR_VPS_IP

# 2. Update and install dependencies
apt-get update && apt-get upgrade -y
apt-get install -y curl git ufw fail2ban

# 3. Enable firewall
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 8789/tcp
ufw --force enable

# 4. Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# 5. Clone the repository
git clone https://github.com/rustemmustafingovua-byte/lumen-chain.git /opt/lumen-chain
cd /opt/lumen-chain
```

### 2.2 Configure environment

```bash
# Create .env file
cat > .env <<'EOF'
NODE_ENV=production
LUMEN_HOME=/data/.lumen
LUMEN_P2P_PORT=8789
LUMEN_RPC_PORT=8899
LUMEN_PEERS=
BASE_RPC=https://mainnet.base.org
LUMEN_KEEPER_POLL_MS=300000
LUMEN_X402_PRICE_USDC=1000
EOF

chmod 600 .env
```

### 2.3 Build and launch

```bash
# Build the production image and start all services
docker compose -f deploy/docker-compose.prod.yml up -d --build

# Verify all containers are running
docker compose -f deploy/docker-compose.prod.yml ps

# Expected output: lumen-chain, nginx, cadvisor all "healthy" / "running"
```

### 2.4 Health check

```bash
# RPC health
curl -s -X POST http://127.0.0.1:8899/api/rpc \
  -H "Content-Type: application/json" \
  -d '{"method":"lumen_blockNumber"}' | jq .

# Explorer (via nginx)
curl -s http://localhost/
```

### 2.5 Useful commands

```bash
# Logs
docker compose -f deploy/docker-compose.prod.yml logs -f lumen-chain

# Restart after config change
docker compose -f deploy/docker-compose.prod.yml restart lumen-chain

# Stop
docker compose -f deploy/docker-compose.prod.yml down
```

---

## 3. Cloud-init Deployment

Use this for fully automated VPS provisioning (DigitalOcean, Hetzner, AWS, GCP).

### 3.1 Prepare cloud-init file

```bash
# Copy the template
cp deploy/cloud-init.yml cloud-init-custom.yml

# Edit placeholders:
# - ${lumen_domain} → your domain (e.g. lumen.example.com)
# - ${lumen_validator_key} → your lmn1... validator address
```

### 3.2 Provision VPS

- **DigitalOcean**: Create Droplet → "User Data" → paste cloud-init-custom.yml
- **Hetzner**: Create Server → "User Data" → paste cloud-init-custom.yml
- **AWS**: Launch Instance → "Advanced Details" → "User data" → paste

### 3.3 Post-provision

The script will:
1. Install Docker, Node.js, nginx, fail2ban
2. Clone `lumen-chain` to `/opt/lumen-chain`
3. Create `.env` with your domain and validator key
4. Build and start the stack via `docker compose`
5. Set up log rotation and firewall

Verify:

```bash
ssh deploy@YOUR_VPS_IP
cd /opt/lumen-chain
docker compose -f deploy/docker-compose.prod.yml ps
journalctl -u lumen-chain -f
```

---

## 4. SSL Setup with Let's Encrypt

### 4.1 Using certbot container (recommended for Docker)

```bash
# Replace YOUR_DOMAIN with your actual domain
export LUMEN_DOMAIN=lumen.example.com

# Obtain certificate
docker compose -f deploy/docker-compose.prod.yml run --rm certbot certonly \
  --webroot --webroot-path=/var/www/certbot \
  -d $LUMEN_DOMAIN -d www.$LUMEN_DOMAIN \
  --email admin@$LUMEN_DOMAIN \
  --agree-tos --no-eff-email

# Restart nginx to pick up the cert
docker compose -f deploy/docker-compose.prod.yml restart nginx
```

### 4.2 Auto-renewal

The `certbot` container in `docker-compose.prod.yml` runs a 12-hour renewal loop automatically. Verify:

```bash
docker compose -f deploy/docker-compose.prod.yml logs certbot
```

### 4.3 Verify SSL

```bash
curl -I https://$LUMEN_DOMAIN
# Expect: HTTP/2 200
```

---

## 5. Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | no | `production` | Runtime mode |
| `LUMEN_HOME` | no | `/data/.lumen` | Data directory |
| `LUMEN_P2P_PORT` | no | `8789` | P2P gossip port |
| `LUMEN_RPC_PORT` | no | `8899` | JSON-RPC + explorer port |
| `LUMEN_PEERS` | no | empty | Comma-separated peer addresses |
| `BASE_RPC` | no | `https://mainnet.base.org` | Base chain RPC for keeper |
| `LUMEN_KEEPER_POLL_MS` | no | `300000` | Keeper poll interval (ms) |
| `LUMEN_X402_PRICE_USDC` | no | `1000` | x402 minimum payment (USDC units) |
| `LUMEN_VALIDATOR_KEY` | yes | — | Your `lmn1...` validator address |
| `LUMEN_DOMAIN` | yes | — | Domain for SSL (cloud-init only) |

**Security notes:**
- Never commit `.env` to version control
- Restrict `.env` to `chmod 600`
- Rotate `LUMEN_API_KEYS` periodically
- Use a dedicated `deploy` user, never run as root

---

## 6. Backup Strategy

### 6.1 What to back up

```
/opt/lumen-chain/.env          # secrets, config
/opt/lumen-chain/data          # chain state, wallet
```

### 6.2 Local snapshots (daily cron)

```bash
# Add to deploy user crontab: crontab -e
0 3 * * * /usr/local/bin/lumen-backup.sh
```

`/usr/local/bin/lumen-backup.sh`:

```bash
#!/bin/bash
set -euo pipefail
BACKUP_DIR=/opt/backups/lumen-chain
mkdir -p $BACKUP_DIR
TIMESTAMP=$(date +%F-%H%M)
tar czf $BACKUP_DIR/lumen-$TIMESTAMP.tar.gz \
  -C /opt/lumen-chain .env data
# Keep last 14 days
find $BACKUP_DIR -type f -name "lumen-*.tar.gz" -mtime +14 -delete
```

### 6.3 Offsite backup (recommended)

```bash
# Copy to remote server via rsync/ssh
rsync -az /opt/backups/lumen-chain/ deploy@backup-server:/backups/lumen-chain/

# Or upload to S3-compatible storage
aws s3 sync /opt/backups/lumen-chain/ s3://your-bucket/lumen-chain/
```

### 6.4 Recovery

```bash
# 1. Stop the node
docker compose -f deploy/docker-compose.prod.yml stop lumen-chain

# 2. Restore
tar xzf /opt/backups/lumen-chain/lumen-2026-10-29-0300.tar.gz \
  -C /opt/lumen-chain

# 3. Restart
docker compose -f deploy/docker-compose.prod.yml up -d lumen-chain
```

### 6.5 Rotation policy

- Local: 14 daily snapshots
- Offsite: 30 daily, 12 monthly
- Test restore quarterly

---

## Post-Deployment Checklist

- [ ] Explorer reachable at `https://YOUR_DOMAIN`
- [ ] JSON-RPC responds to `lumen_blockNumber`
- [ ] Health endpoint returns 200: `https://YOUR_DOMAIN/health`
- [ ] SSL certificate auto-renews (check certbot logs)
- [ ] Backup cron job exists and runs daily
- [ ] Firewall allows only 22, 80, 443, 8789
- [ ] `fail2ban` is active
- [ ] Node resource limits set (2 GB RAM, 2 CPU)

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Port 8789 blocked | Open in VPS firewall and cloud provider security group |
| SSL cert fails | Ensure port 80 is reachable from internet for ACME challenge |
| Node OOM | Increase swap or upgrade to 4 GB RAM VPS |
| Slow sync | Add more peers in `LUMEN_PEERS` |
| RPC 502 | `docker compose logs lumen-chain` — check if process crashed |

---

## Upgrades

```bash
cd /opt/lumen-chain
git pull
docker compose -f deploy/docker-compose.prod.yml up -d --build
docker compose -f deploy/docker-compose.prod.yml ps
```
