# Контракты Lumen на Base

| Файл | Что это |
|---|---|
| `LMN.sol` | ERC-20 LMN: фиксированная эмиссия 1e9, 6 знаков, EIP-2612 permit |
| `LumenAMM.sol` | AMM постоянного произведения LMN/USDC, комиссия 0.3% идёт LP |

Развёртывание (Base, нужен ETH на газ):

```bash
# foundry
forge create contracts/LMN.sol:LMN --rpc-url $BASE_RPC --broadcast \
  --constructor-args $TREASURY
forge create contracts/LumenAMM.sol:LumenAMM --rpc-url $BASE_RPC --broadcast \
  --constructor-args $LMN $USDC
```

После развёртывания:

1. `keeper/keeper.ts` начинает покупать LMN за любой поступивший USDC/ETH — биржа не нужна.
2. Обратный путь: `lumen-keeper sell <lmn>` продаёт LMN обратно в USDC.
3. В сети Lumen (нативная) комиссии нет: переводы бесплатны, газ платит оператор.
