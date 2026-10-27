# Lumen Chain

<div align="center">

<img src="docs/social-preview.png" alt="Lumen" width="100%">

# Lumen Chain

**PoS-блокчейн с встроенным AMM-рынком и автономным keeper'ом: храните ценность, стейкайте и свопайте без посредников.**

[![CI](https://github.com/rustemmustafingovua-byte/lumen-chain/actions/workflows/ci.yml/badge.svg)](https://github.com/rustemmustafingovua-byte/lumen-chain/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-8b949e?logo=opensourceinitiative)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-3c873a?logo=node.js)](https://nodejs.org)
[![paid](https://img.shields.io/badge/USDC-0x8aC6a229f254980CCd3Dd35CF5E1B7c08880B40E-2775ca?logo=ethereum)](https://base.org)

[Docs](docs/) · [Архитектура](docs/ARCHITECTURE.md) · [Токеномика](docs/TOKENOMICS.md) · [Фандинг](docs/FUNDING.md) · [Threat model](docs/THREAT-MODEL.md) · [Issues](https://github.com/rustemmustafingovua-byte/lumen-chain/issues)

</div>

---

## Что такое Lumen Chain

Lumen Chain — это открытый proof-of-stake блокчейн с собственной валютой LMN, который решает две проблемы криптоэкономики одновременно: ликвидность и выход на биржу. AMM (автоматический маркет-мейкер) встроен в протокол — пул LMN/USDC существует с блока ноль, а keeper — автономный демон — конвертирует любой актив (USDC, ETH) в LMN без централизованной биржи. Цепочка управляется сообществом через PoS-валидацию с детерминированным выбором продюсера и финальностью 2/3, а вся логика свопа и стейкинга доступна из CLI без внешних сервисов. MIT-лицензия, без VC, без фонда.

---

## Быстрый старт

```bash
git clone https://github.com/rustemmustafingovua-byte/lumen-chain
cd lumen-chain && npm install && npm test
```

---

## Запуск узла

```bash
# Создать кошелёк
npx tsx cli/lumen.ts wallet new

# Запустить валидатор-узел
npx tsx cli/lumen.ts node --port=8789 --peers=host1:port,host2:port

# Или через npm-скрипт (запускает тот же lumen node)
npm run node -- --port=8789
```

**Требования для валидатора:** застейкать минимум 10 000 LMN.

### Параметры запуска

| Флаг | Значение | Описание |
|---|---|---|
| `--port=N` | `0` (случайный) | TCP-порт для P2P-транспорта |
| `--peers=...` | `""` | Список пиров через запятую: `host:port,host:port` |

---

## Как зарабатывать

### 1. Валидатор (стейкинг)

Запустите узел и застейкайте минимум 10 000 LMN. Валидаторы получают 3% годовых от комиссий сети. Награды начисляются за каждый предложенный блок пропорционально весу стейка.

```bash
lumen stake 10000
lumen node --port=8789
```

### 2. LP-провайдер (ликвидность AMM)

Добавьте ликвидность в пул LMN/USDC и получайте 0.30% с каждого свопа. Комиссия остаётся в пуле — доход пропорционален вашей доле.

```bash
# В коде: ledger.addLiquidity("LMN", "USDC", base, quote)
# На практике: через keeper или напрямую в AMM
```

### 3. Keeper-оператор

Запустите keeper на своём сервере — демон, который автоматически покупает LMN за USDC (через Uniswap V3 на Base) и зачисляет на адрес в сети Lumen. Keeper берёт 0.5% сервисного сбора с каждой своп-операции.

```bash
cat > ~/.lumen/keeper.json <<'JSON'
{
  "treasury": "0x...казна на Base...",
  "lumenAddress": "lmn1...",
  "lmn": "0x...LMN на Base...",
  "rpcUrl": "https://mainnet.base.org"
}
JSON

lumen keeper scan   # проверка состояния
lumen keeper check  # живой маршрут на Base
lumen keeper run    # автономный режим
```

Политика по умолчанию: минимум 5 USDC, максимум 500 USDC/сделка, 2000 USDC/сутки, проскальзывание не более 1%.

### 4. Реферальная программа

Приводите проекты, сервисы и ноды в экосистему Lumen. Получайте **5% от всех x402-комиссий**, которые генерирует привлечённый вами API-трафик, в USDC на Base. Реферальные выплаты производятся автоматически раз в 7 дней. Ссылка и статистика: после регистрации в партнёрском кабинете (скоро).

### 5. API-ключи и хостинг

Запустите публичный JSON-RPC или inference-сервис и продавайте доступ через x402 (HTTP 402, оплата USDC). Без аккаунтов, без ключей — оплата за вызов. Настройка:

```bash
export LUMEN_RPC_PORT=8899
export LUMEN_X402_PRICE_USDC=100000  # 0.1 USDC за вызов (6 знаков)
lumen serve --port=$LUMEN_RPC_PORT
```

Полные цены на API-доступ: [MONETIZATION.md](MONETIZATION.md).

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────────┐
│                        lumen serve / node                        │
├──────────────┬──────────────┬──────────────┬────────────────────┤
│  CLI (lumen) │   Chain      │    P2P       │   Explorer + RPC   │
│  wallet,     │  ledger,     │  gossip,     │   HTTP-сервер,     │
│  send,       │  chain,      │  TCP-трансп. │   блоки, счета,    │
│  stake,      │  mempool,    │  getBlocks,  │   пулы AMM,        │
│  swap        │  vm          │  blocks      │   JSON-RPC API     │
├──────────────┴──────────────┴──────────────┴────────────────────┤
│  Keeper (keeper.ts)                                            │
│  USDC/ETH на Base ──► Uniswap V3 ──► LMN ──► Lumen-адрес      │
├─────────────────────────────────────────────────────────────────┤
│  Контракты (contracts/)                                        │
│  LMN (ERC-20 на Base) + LumenAMM + Foundry-тесты               │
└─────────────────────────────────────────────────────────────────┘

Блок:
  header: { height, prevHash, timestamp, proposer, merkleRoot, txCount, slot }
  txs:    Transaction[]
  signature: base64(ed25519 от ключа продюсера)
  hash:   sha256(header)

Поток:
  TX в мемпуле → proposer (по весу стейка) → блок → подпись → gossip →
  2/3 валидаторов подтвердили → ledger применяет → награда 3% годовых
```

---

## Развёртывание в production

Полное руководство: [DEPLOY.md](DEPLOY.md).

Кратко:

1. Собрать бинарник: `npm run build`
2. Настроить systemd или PM2
3. Выделить 10 000+ LMN на стейк
4. Открыть порт P2P и порт RPC (если публичный узел)
5. Добавить пиров через `--peers=`

---

## Поддержка

MIT, бесплатно. USDC (Base): `0x8aC6a229f254980CCd3Dd35CF5E1B7c08880B40E`

---

## Лицензия

MIT © rustemmustafingovua-byte
