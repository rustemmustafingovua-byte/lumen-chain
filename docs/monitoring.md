# Мониторинг

## x402

Методы `/api/rpc`, помеченные как платные, требуют оплату в LMN через заголовок `x-payment`. Keeper и внешние сервисы используют этот протокол для оплаты комиссий.

## AnalyticsStore

Сервер эксплорера хранит usage в памяти:

```ts
const analytics = new AnalyticsStore()
analytics.initApiKeys(keys)
analytics.record({ method, endpoint, apiKey, payment, status })
analytics.touchKey(apiKey)
analytics.getUsageSummary()
```

## Usage endpoint

`GET /api/usage` — требует `x-api-key`.

## Keeper metrics

```bash
lumen keeper scan
```

Вывод:

- USDC баланс казны
- Порог политики
- Лимиты на сделку / сутки
- Решение: buy / wait

## Explorer метрики

- Высота, supply, validators, stake
- Mempool size
- Блоки, tx, accounts, contracts, pools
- Обновление раз в 4 сек

## Логи

```bash
lumen serve --port=8899
```

В логах видны:

- `[auth] отклонён ключ ...`
- `[analytics] метод: оплачено ... LMN`

## Деплой мониторинга

В продакшене добавляйте:

- `systemd` journal
- `nginx` access log
- Внешний uptime-бот ( `/health` → `{"status":"ok"}` )
