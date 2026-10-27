# Документация Lumen Chain

Lumen — PoS-блокчейн с встроенным AMM-рынком, автономным keeper'ом и x402-платежами за API.

## Быстрые ссылки

- [Быстрый старт](getting-started.md) — установка, запуск узла, первая транзакция
- [CLI](cli.md) — все команды `lumen` с примерами
- [JSON-RPC API](api.md) — методы, форматы запросов и x402
- [Мониторинг](monitoring.md) — учёт usage, API-ключи, аналитика
- [Деплой](deploy.md) — продакшн-развёртывание

## Что внутри

| Компонент | Назначение |
|---|---|
| `core/` | Ledger, Chain, VM, P2P, persist |
| `cli/lumen.ts` | CLI: кошелёк, узел, свап, keeper, контракты |
| `explorer/` | Веб-интерфейс, JSON-RPC, x402 |
| `keeper/` | UniV3Swapper, decide/tick/sell |
| `contracts/` | Solidity-контракты для Base |

> Подсказка: запустите `lumen serve --port=8899`, затем откройте `http://127.0.0.1:8899/docs`.
