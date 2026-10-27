# Деплой Lumen Node

## Публичный узел

Минимальные требования: Node.js ≥ 20, 2+ GB RAM, открытые TCP-порты.

```bash
git clone https://github.com/rustemmustafingovua-byte/lumen-chain
cd lumen-chain && npm install && npm run build
```

Создайте кошелёк и застейкайте минимум 10 000 LMN:

```bash
npx tsx cli/lumen.ts wallet new /opt/lumen/wallet.json
# Переведите LMN на адрес
npx tsx cli/lumen.ts stake 10000
```

Запустите узел с фиксированными портами:

```bash
npx tsx cli/lumen.ts node --port=8789 --peers=peer1:port,peer2:port
```

### JSON-RPC поверх HTTP (опционально)

```bash
npx tsx cli/lumen.ts serve --port=8899 --peers=peer1:port
```

Эксплоер и API доступны на `http://0.0.0.0:8899/`.

---

## Systemd unit

`/etc/systemd/system/lumen-node.service`:

```ini
[Unit]
Description=Lumen Chain Node
After=network.target

[Service]
Type=simple
User=lumen
WorkingDirectory=/opt/lumen-chain
Environment=NODE_ENV=production
ExecStart=/usr/bin/npx tsx cli/lumen.ts node --port=8789
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lumen-node
journalctl -u lumen-node -f
```

---

## PM2

`ecosystem.config.js`:

```js
module.exports = {
  apps: [{
    name: 'lumen-node',
    script: 'npx',
    args: 'tsx cli/lumen.ts node --port=8789',
    cwd: '/opt/lumen-chain',
    env: { NODE_ENV: 'production' },
    restart_delay: 5000,
    watch: false,
    log_file: '/var/log/lumen/node.log',
    out_file: '/var/log/lumen/out.log',
    error_file: '/var/log/lumen/error.log',
  }]
}
```

```bash
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

---

## Docker

`Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production=false
COPY . .

EXPOSE 8789 8899

CMD ["npx", "tsx", "cli/lumen.ts", "node", "--port=8789"]
```

```bash
docker build -t lumen-node .
docker run -d --name lumen \
  -v /opt/lumen/data:/root/.lumen \
  -p 8789:8789 -p 8899:8899 \
  --restart unless-stopped \
  lumen-node \
  npx tsx cli/lumen.ts node --port=8789
```

---

## Переменные окружения

| Переменная | Обязательная | Значение по умолчанию | Описание |
|---|---|---|---|
| `LUMEN_WALLET_PATH` | нет | `~/.lumen/wallet.json` | Путь к кошельку |
| `LUMEN_RPC_PORT` | нет | `8899` | Порт HTTP/RPC (serve) |
| `LUMEN_P2P_PORT` | нет | `0` (случайный) | TCP-порт P2P-транспорта |
| `LUMEN_X402_PRICE_USDC` | нет | — | Цена x402-вызова в микро-USDC (1e6 = 1 USDC) |
| `LUMEN_PEERS` | нет | `""` | Список пиров `host:port,host:port` |
| `BASE_RPC` | нет | `https://mainnet.base.org` | RPC Base для keeper |
| `LUMEN_KEEPER_POLL_MS` | нет | `300000` | Интервал проверки keeper, мс |

---

## Healthcheck

```bash
curl -s -X POST http://127.0.0.1:8899/api/rpc \
  -H "Content-Type: application/json" \
  -d '{"method":"lumen_blockNumber","params":[]}' | jq .
# Ожидаем: число (высота блока)
```

---

## Обновление

```bash
cd /opt/lumen-chain
git pull
npm install && npm run build
sudo systemctl restart lumen-node
```
