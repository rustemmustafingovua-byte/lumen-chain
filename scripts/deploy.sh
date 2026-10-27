#!/usr/bin/env bash
# scripts/deploy.sh — деплой lumen-chain на чистый VPS (Ubuntu/Debian)
# Использование: sudo bash scripts/deploy.sh [domain] [email]
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_DIR="/opt/lumen-chain"
APP_USER="lumen"
REPO_URL="https://github.com/rustemmustafingovua-byte/lumen-chain.git"

info()  { echo -e "\033[32m[INFO]\033[0m  $*"; }
warn()  { echo -e "\033[33m[WARN]\033[0m  $*"; }
fail()  { echo -e "\033[31m[FAIL]\033[0m  $*"; exit 1; }

# 1) Зависимости
info "Обновление пакетов"
apt-get update -qq
apt-get install -y -qq git curl docker.io docker-compose-plugin ufw fail2ban >/dev/null

# 2) Пользователь для сервиса
if ! id "$APP_USER" &>/dev/null; then
  info "Создание пользователя $APP_USER"
  useradd -m -s /usr/sbin/nologin "$APP_USER"
fi

# 3) Брандмауэр
info "Настройка UFW"
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

# 4) LetsEncrypt (опционально)
if [[ -n "$DOMAIN" && -n "$EMAIL" ]]; then
  info "Установка certbot"
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  info "Выпуск сертификата для $DOMAIN"
  certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos -n >/dev/null || warn "Не удалось выпустить сертификат"
else
  warn "Домен/email не указаны — SSL не настроен"
fi

# 5) Деплой
if [[ -d "$APP_DIR/.git" ]]; then
  info "Обновление репозитория"
  cd "$APP_DIR"
  git pull --ff-only
else
  info "Клонирование репозитория"
  git clone "$REPO_URL" "$APP_DIR"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
fi

cd "$APP_DIR"

# 6) Docker-образ
info "Сборка Docker-образа"
docker compose build

# 7) Миграции/данные
info "Создание volume"
docker compose up -d
sleep 5

info "Статус контейнера"
docker compose ps

# 8) Systemd unit (на случай если docker не нужен)
info "Установка systemd unit (опционально)"
mkdir -p /etc/systemd/system
cat > /etc/systemd/system/lumen-node.service <<'EOF'
[Unit]
Description=Lumen Chain Node
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/lumen-chain
ExecStart=/usr/bin/docker compose up
ExecStop=/usr/bin/docker compose down
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable lumen-node >/dev/null 2>&1 || true

info "Деплой завершён"
info "Explorer:  http://$DOMAIN/  (или http://<ip>:8899/)"
info "P2P:       порт 8789"
info "Health:    http://<ip>:8899/health"
