# Контракты Lumen на Base

| Файл | Что это |
|---|---|
| `LMN.sol` | ERC-20 LMN: фиксированная эмиссия 1e9, 6 знаков, EIP-2612 permit |
| `LumenAMM.sol` | AMM постоянного произведения LMN/USDC, комиссия 0.3% идёт LP, доли LP (shares) |

## Тесты

Контракты покрыты Foundry-тестами (`test/foundry/`, 14 тестов):

```bash
forge test -vv
```

| Что проверяется | Тест |
|---|---|
| 60% премайна в казну, метаданные | `test_PremineToTreasury` |
| переводы, запрет перевода при нехватке, перевод в ноль | `test_Transfer*` |
| approve / transferFrom / permit (EIP-2612) | `test_ApproveAndTransferFrom`, `test_Permit*` |
| доли LP: выпуск, пропорциональность, запрет вывода чужих | `test_*Shares*`, `test_CannotWithdrawOtherShares` |
| вывод ликвидности возвращает пропорциональные резервы | `test_RemoveLiquidityReturnsProportionalReserves` |
| комиссия остаётся в пуле, цена доли растёт | `test_FeeStaysInPoolAndRaisesSharePrice` |
| покупка LMN за USDC | `test_BuyLmnSpendsUsdc` |

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
