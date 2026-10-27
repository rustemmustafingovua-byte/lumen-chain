# Быстрый старт

## Требования

- Node.js >= 18
- npm или pnpm
- Git

## 1. Установка

```bash
git clone https://github.com/rustemmustafingovua-byte/lumen-chain
cd lumen-chain
npm install
```

## 2. Кошелёк

```bash
npx tsx cli/lumen.ts wallet new
```

Создаётся `~/.lumen/wallet.json` (chmod 600). Склейте на него LMN через explorer.

## 3. Запуск узла

```bash
npx tsx cli/lumen.ts serve --port=8899
```

Откройте `http://127.0.0.1:8899` — это explorer с живым состоянием.

## 4. Первая транзакция

```bash
# проверка баланса
npx tsx cli/lumen.ts balance <адрес>

# отправка LMN
npx tsx cli/lumen.ts send <to> 1000000
```

## 5. Стейкинг и AMM

```bash
# застейкать
npx tsx cli/lumen.ts stake 1000000

# добавить ликвидность
npx tsx cli/lumen.ts lp add 1000000 1000000

# свап
npx tsx cli/lumen.ts swap LMN/USDC 1000
```

## 6. Keeper

```bash
lumen keeper scan    # что будет куплено
lumen keeper run     # автономная покупка LMN за USDC
```

## Структура проекта

```
lumen-chain/
├── core/           # chain, ledger, vm, p2p, rpc
├── cli/            # CLI + explorer server
├── explorer/       # статические HTML-страницы
├── keeper/         # UniV3Swapper, политики
├── contracts/      # Solidity для Base
├── docs/           # документация
└── test/           # e2e и unit-тесты
```

## Дальше

- [CLI](cli.md) — все команды
- [API](api.md) — JSON-RPC и x402
- [Деплой](deploy.md) — продакшн
