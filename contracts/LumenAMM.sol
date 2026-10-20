// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./LMN.sol";

/// AMM постоянного произведения (x*y=k) для пары LMN/USDC.
/// Ликвидность живёт в контракте: покупатель не платит комиссию биржи, а 0.3% — LP.
contract LumenAMM {
    LMN public immutable lmn;
    address public immutable usdc;
    uint256 public constant FEE_BPS = 30; // 0.30%
    uint256 public base; // LMN
    uint256 public quote; // USDC (6 decimals)

    event Swap(address indexed buyer, uint256 baseIn, uint256 quoteOut);
    event LiquidityAdded(address indexed provider, uint256 base, uint256 quote);

    error NoLiquidity();
    error ZeroAmount();

    constructor(LMN _lmn, address _usdc) {
        lmn = _lmn;
        usdc = _usdc;
    }

    function addLiquidity(uint256 baseIn, uint256 quoteIn) external {
        if (baseIn == 0 || quoteIn == 0) revert ZeroAmount();
        lmn.transferFrom(msg.sender, address(this), baseIn);
        base += baseIn;
        quote += quoteIn;
        emit LiquidityAdded(msg.sender, baseIn, quoteIn);
    }

    function quote(uint256 baseIn) public view returns (uint256) {
        if (base == 0 || quote == 0) return 0;
        uint256 fee = (baseIn * FEE_BPS) / 10_000;
        uint256 eff = baseIn - fee;
        return (quote * eff) / (base + eff);
    }

    /// Купить LMN за USDC.
    function buyLmn(uint256 usdcIn) external returns (uint256) {
        if (usdcIn == 0) revert ZeroAmount();
        if (base == 0) revert NoLiquidity();
        uint256 fee = (usdcIn * FEE_BPS) / 10_000;
        uint256 eff = usdcIn - fee;
        uint256 out = (base * eff) / (quote + eff);
        require(out > 0, "out=0");
        base -= out;
        quote += usdcIn;
        lmn.transfer(msg.sender, out);
        emit Swap(msg.sender, out, usdcIn);
        return out;
    }

    /// Продать LMN за USDC.
    function sellLmn(uint256 lmnIn) external returns (uint256) {
        if (lmnIn == 0) revert ZeroAmount();
        if (quote == 0) revert NoLiquidity();
        uint256 fee = (lmnIn * FEE_BPS) / 10_000;
        uint256 eff = lmnIn - fee;
        uint256 out = (quote * eff) / (base + eff);
        require(out > 0, "out=0");
        quote -= out;
        base += lmnIn;
        lmn.transferFrom(msg.sender, address(this), lmnIn);
        emit Swap(msg.sender, lmnIn, out);
        return out;
    }

    function withdraw(uint256 baseOut, uint256 quoteOut) external {
        // ликвидность забирает только тот, кто её добавил (в простой версии — любой,
        // в боевой нужен учёт долей; это зафиксировано в docs/threat-model.md)
        base -= baseOut;
        quote -= quoteOut;
        lmn.transfer(msg.sender, baseOut);
    }
}
