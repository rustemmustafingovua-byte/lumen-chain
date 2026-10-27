# Lumen Chain — Быстрый старт

PoS-блокчейн со встроенным AMM и автономным keeper'ом. Храните ценность, стейкайте и свопайте без посредников.

---

## 1. Запуск за 1 минуту

```bash
cd /private/tmp/lumen-chain
npm install
npx tsx cli/lumen.ts wallet new
```

Создастся кошелёк в `~/.config/lumen-chain/wallet.json`. Пополните его LMN (или USDC на Base) и запустите ноду:

```bash
npx tsx cli/lumen.ts node --port=8789
```

Проверьте, что нода отвечает:

```bash
curl http://127.0.0.1:8789/health
```

---

## 5-минутный тур

### Шаг 1 — Кошелёк и баланс

```bash
lumen wallet new          # создать новый кошелёк
lumen balance             # баланс LMN
```

### Шаг 2 — Стейкинг

```bash
lumen stake 10000         # застейкать 10 000 LMN
```

### Шаг 3 — АMM (встроенный обмен)

```bash
lumen swap USDC 100       # обменять 100 USDC на LMN
lumen liquidity add       # добавить ликвидность в пул
```

### Шаг 4 — Keeper (автоконвертер)

```bash
lumen keeper run          # запустить демон-конвертер
```

### Шаг 5 — Проверка тестами

```bash
npm test
```

---

## Дальнейшие шаги

- **Валидатор**: запустите ноду с достаточным стейком и получайте 3% годовых.
- **LP-провайдер**: добавляйте ликвидность в пул LMN/USDC и получайте 0.30% с каждого свопа.
- **Keeper-оператор**: запускайте демон-конвертер и получайте 0.5% с операций.
- **Контракты**: изучите `contracts/` — LMN-токен на Base + on-chain AMM.
- **Архитектура**: `docs/ARCHITECTURE.md`, `docs/TOKENOMICS.md`.

---

## Устранение неполадок

| Проблема | Решение |
|---|---|
| `Node.js >=20` не установлен | `brew install node` или `nvm install 20` |
| `npm test` падает с `better-sqlite3` | `npm rebuild better-sqlite3` или переустановите зависимости |
| Порт `8789` занят | `lumen node --port=8788` |
| Нет LMN для стейкинга | используйте тестовый режим или запросите тестовые токены |
| `forge` не найден (тесты контрактов) | `curl -L https://foundry.paradigm.xyz \| bash` |

---

*MIT © rustemmustafingovua-byte*
