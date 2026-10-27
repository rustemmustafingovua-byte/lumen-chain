# CLI

Установка: `npm install -g lumen-chain` или `npx tsx cli/lumen.ts <cmd>`.

## Кошелёк

```bash
lumen wallet new [file]      # создать кошелёк
lumen wallet address [file]  # показать адрес
```

## Баланс и переводы

```bash
lumen balance <addr>
lumen send <to> <amount>
```

## Стейкинг и фарминг

```bash
lumen stake <amount>
lumen unstake <amount>
lumen farm <pool> <amount>
lumen rewards
```

## AMM

```bash
lumen swap <pool> <amount>         # своп
lumen lp add <lmN> <usdc>          # добавить LP
lumen lp remove <shares>           # убрать LP
```

## Узел

```bash
lumen serve --port=8899            # explorer + RPC + P2P
lumen serve --port=8789 --peers=host:port,host:port
lumen node status                  # аптайм, блоки, комиссии
```

## Смарт-контракты

```bash
lumen contract list
lumen contract deploy <hex>
lumen contract call <addr> [hex]
```

## API-ключи

```bash
lumen api-key create <name>
```

## Рефералы

```bash
lumen referral generate
lumen referral <code>
```

## Управление

```bash
lumen governance propose <title> <description>
lumen governance vote <id> <yes|no>
```

## Keeper

```bash
lumen keeper scan            # проверка политик
lumen keeper check           # маршрут на Base
lumen keeper run             # автономная покупка
lumen keeper sell <amount>   # продажа LMN
```

## Пример: минимальный цикл

```bash
npm install
npx tsx cli/lumen.ts wallet new
npx tsx cli/lumen.ts serve --port=8899
lumen lp add 500000 500000
lumen swap LMN/USDC 1000
```
