# Деплой Lumen в Base

Контракты проверены тестами и работают на форке Base — деплой в сеть отличается
только наличием газа.

## 1. Подготовка

```bash
cd lumen-chain
forge build
forge test --fork-url https://mainnet.base.org    # полный путь на форке
```

## 2. Деплой

```bash
export PRIVATE_KEY=0x...            # ключ казны
export TREASURY=0x...               # адрес казны (по умолчанию — тот, кто деплоит)
export BASE_RPC=https://mainnet.base.org

forge script script/Deploy.s.sol:Deploy \
  --rpc-url $BASE_RPC --broadcast --verify \
  --private-key $PRIVATE_KEY
```

Скрипт напечатает:

```
LMN (ERC-20)  : 0x…
LumenAMM      : 0x…
Treasury      : 0x…
Premine (60%) : 600000000
```

## 3. Рынок: наливаем ликвидность в свой AMM

```bash
cast send $AMM "addLiquidity(uint256,uint256)" <base> <quote> \
  --rpc-url $BASE_RPC --private-key $PRIVATE_KEY
```

После этого LMN можно покупать за USDC прямо в контракте — без биржи и без
списка листингов.

## 4. Включаем keeper

```bash
cat > ~/.lumen/keeper.json <<JSON
{
  "treasury": "$TREASURY",
  "lumenAddress": "lmn1…",
  "lmn": "0x…адрес LMN…",
  "policy": { "minAmount": "5000000", "maxPerSwap": "500000000", "maxPerDay": "2000000000" }
}
JSON

lumen keeper check   # проверить, что пулы живые
lumen keeper run     # автономная покупка LMN за USDC
```

Keeper покупает через Uniswap V3 (USDC → WETH → LMN) — то есть рынок для LMN
может быть и в нашем AMM, и в Uniswap, а keeper сам выбирает, где выгоднее.

## 5. Проверка

```bash
cast call $LMN "totalSupply()(uint256)" --rpc-url $BASE_RPC
cast call $AMM "baseReserve()(uint256)" --rpc-url $BASE_RPC
lumen keeper scan
```

## Что может пойти не так

| Симптом | Причина | Что делать |
|---|---|---|
| `STF` при свапе | у казны нет USDC или нет аппрува к роутеру | `cast send $USDC "approve(address,uint256)" $ROUTER ...` |
| `SPL` | неверный sqrtPriceLimit | использовать `0` (маршрутизатор подставит границы) |
| `404` в npm | npm откладывает первую публикацию нового аккаунта | подождать, повторяет `com.opencode.npmretry` |
