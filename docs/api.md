# JSON-RPC API

Эксплорер exposes JSON-RPC на `/api/rpc`. Все методы возвращают `{"result": ...}` или `{"error": ...}`.

## Endpoints

| Метод | Описание | Платно (x402) |
|---|---|---|
| `lumen_chainId` | Идентификатор сети | Нет |
| `lumen_blockNumber` | Текущая высота | Нет |
| `lumen_blockByNumber` | Блок по номеру | Нет |
| `lumen_blockByHash` | Блок по хешу | Нет |
| `lumen_totalSupply` | Эмиссия LMN | Нет |
| `lumen_stateRoot` | Корень состояния | Нет |
| `lumen_accounts` | Топ-20 счетов | Нет |
| `lumen_contracts` | Список контрактов | Нет |
| `lumen_sendRawTransaction` | Отправить tx | 1000 LMN |
| `lumen_contracts` | Контракты | 500 LMN |
| `lumen_contract` | Один контракт | 200 LMN |

## x402

Оплачиваемые методы требуют заголовок `x-payment: <LMN>`.

```bash
curl -X POST http://127.0.0.1:8899/api/rpc \
  -H 'content-type: application/json' \
  -H 'x-payment: 1500' \
  -d '{"method":"lumen_sendRawTransaction","params":[...]}'
```

Недостаточная оплата → `402 Payment Required`.

## API-ключ

Добавьте `x-api-key: <key>` для учёта usage.

```bash
lumen api-key create my-service
```

## Использование

```bash
curl -H 'x-api-key: <key>' http://127.0.0.1:8899/api/usage
```

Ответ:

```json
{
  "keys": { "<key>": { "calls": 10, "paid": 5000 } },
  "total": { "calls": 42, "paid": 21000 }
}
```

## Примеры

```bash
# получить высоту
curl -s http://127.0.0.1:8899/api/rpc \
  -d '{"method":"lumen_blockNumber"}' | jq .

# состояние
curl -s http://127.0.0.1:8899/api/state | jq .

# отправка tx
curl -X POST http://127.0.0.1:8899/api/rpc \
  -H 'content-type: application/json' \
  -H 'x-payment: 1000' \
  -d '{"method":"lumen_sendRawTransaction","params":[{...}]}'
```
