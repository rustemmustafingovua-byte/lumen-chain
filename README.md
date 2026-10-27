<div align="center">

# Lumen Chain

[![CI](https://github.com/rustemmustafingovua-byte/lumen-chain/actions/workflows/ci.yml/badge.svg)](https://github.com/rustemmustafingovua-byte/lumen-chain/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/lumen-chain?color=cb3837&logo=npm)](https://www.npmjs.com/package/lumen-chain) [![license](https://img.shields.io/badge/license-MIT-8b949e?logo=opensourceinitiative)](./LICENSE)

</div>

---

**PoS-блокчейн с встроенным AMM-рынком и автономным keeper'ом: храните ценность, стейкайте и свопайте без посредников.**

---

⭐ **Star us on GitHub** if this project helps you build better agents!

---

## 🚀 Быстрый старт

```bash
git clone https://github.com/rustemmustafingovua-byte/lumen-chain
cd lumen-chain && npm install
npx tsx cli/lumen.ts wallet new
```

---

## 🎯 Демо

```bash
lumen stake 10000
lumen node --port=8789
lumen keeper run
```

---

## 💰 Монетизация

| Способ | Что нужно | Доход |
|---|---|---|
| Валидатор (стейкинг) | Запустить узел, застейкать ≥10 000 LMN | 3% годовых от комиссий сети |
| LP-провайдер | Добавить ликвидность в пул LMN/USDC | 0.30% с каждого свопа |
| Keeper-оператор | Запустить keeper на своём сервере | 0.5% с каждой своп-операции |
| Рефералы | Приводить проекты и ноды | 5% от x402-комиссий трафика |
| API-хостинг | Запустить JSON-RPC/inference-сервис | Оплата за вызов через x402 (USDC) |

---

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/amazing-thing`)
3. Commit your changes (`git commit -m 'feat: add amazing thing'`)
4. Push to the branch (`git push origin feat/amazing-thing`)
5. Open a Pull Request

Bug reports and feature requests are welcome on the [Issues](https://github.com/rustemmustafingovua-byte/lumen-chain/issues) page.

MIT © rustemmustafingovua-byte
