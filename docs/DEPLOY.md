# Продакшн-деплой

## Вариант 1: systemd

`/etc/systemd/system/lumen.service`

```ini
[Unit]
Description=Lumen Node
After=network.target

[Service]
Type=simple
User=deploy
WorkingDir=/opt/lumen-chain
ExecStart=/usr/bin/npx tsx cli/lumen.ts serve --port=8899
Restart=always
RestartSec=5
Environment=HOME=/home/deploy
Environment=LUMEN_API_KEYS=key1,key2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lumen
journalctl -u lumen -f
```

## Вариант 2: Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 8899
CMD ["npx","tsx","cli/lumen.ts","serve","--port=8899"]
```

```bash
docker build -t lumen-node .
docker run -d --restart=always -p 8899:8899 lumen-node
```

## Обратный прокси

`nginx.conf` (фрагмент):

```nginx
server {
  listen 80;
  server_name lumen.example.com;

  location / {
    proxy_pass http://127.0.0.1:8899;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:8899/api/;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

## Безопасность

- Отдельный пользователь `deploy`
- Файрвол: только 80/443 и 8899 на localhost
- `x-api-key` для всех внешних потребителей
- Ротация `LUMEN_API_KEYS`
- Резервное копирование `~/.lumen/` (wallet, api-keys, referrals)

## Резерв

```bash
tar czf lumen-backup-$(date +%F).tar.gz ~/.lumen
```

## Масштабирование

- Несколько нод: разные порты, `--peers=host:port`
- Балансировщик на `nginx` / `caddy`
- Общий `AnalyticsStore` только через внешний бэкенд (в текущей версии in-memory)
