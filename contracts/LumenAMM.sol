// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./LMN.sol";

/**
 * @title LumenAMM
 * @notice AMM постоянного произведения (x*y=k) для пары LMN/USDC.
 *         Ликвидность живёт в контракте, её доля принадлежит внесшим (shares).
 *         Комиссия 0.30% остаётся в пуле и идёт владельцам долей.
 *         Вывести можно только свои доли — чужие резервы неприкосновенны.
 */
contract LumenAMM {
    LMN public immutable lmn;
    address public immutable usdc;

    uint256 public constant FEE_BPS = 30; // 0.30%
    uint256 public constant BPS = 10_000;

    /// @notice Резерв базового актива (LMN).
    uint256 public baseReserve;
    /// @notice Резерв котируемого актива (USDC, 6 знаков).
    uint256 public quoteReserve;
    /// @notice Всего выпущено долей LP.
    uint256 public totalShares;
    /// @notice Доли LP по владельцам.
    mapping(address => uint256) public shares;

    event LiquidityAdded(address indexed provider, uint256 baseIn, uint256 quoteIn, uint256 sharesMinted);
    event LiquidityRemoved(address indexed provider, uint256 sharesBurned, uint256 baseOut, uint256 quoteOut);
    event Swap(address indexed buyer, bool soldBase, uint256 amountIn, uint256 amountOut);

    error NoLiquidity();
    error ZeroAmount();
    error InsufficientShares();
    error ZeroAddress();
    error TransferFailed();

    constructor(LMN _lmn, address _usdc) {
        if (address(_lmn) == address(0) || _usdc == address(0)) revert ZeroAddress();
        lmn = _lmn;
        usdc = _usdc;
    }

    // --- доли LP -------------------------------------------------------------

    /// @notice Добавить ликвидность и получить доли пропорционально внесённому.
    function addLiquidity(uint256 baseIn, uint256 quoteIn) external returns (uint256 minted) {
        if (baseIn == 0 || quoteIn == 0) revert ZeroAmount();
        minted = totalShares == 0 ? baseIn : (baseIn * totalShares) / baseReserve;
        if (minted == 0) revert ZeroAmount();

        baseReserve += baseIn;
        quoteReserve += quoteIn;
        totalShares += minted;
        shares[msg.sender] += minted;

        _pullLmn(msg.sender, baseIn);
        _pullUsdc(msg.sender, quoteIn);
        emit LiquidityAdded(msg.sender, baseIn, quoteIn, minted);
    }

    /// @notice Забрать ликвидность по своим долям.
    function removeLiquidity(uint256 shareAmount) external returns (uint256 baseOut, uint256 quoteOut) {
        uint256 owned = shares[msg.sender];
        if (owned == 0 || shareAmount == 0) revert InsufficientShares();
        if (shareAmount > owned) revert InsufficientShares();

        baseOut = (baseReserve * shareAmount) / totalShares;
        quoteOut = (quoteReserve * shareAmount) / totalShares;

        baseReserve -= baseOut;
        quoteReserve -= quoteOut;
        totalShares -= shareAmount;
        shares[msg.sender] = owned - shareAmount;

        _sendLmn(msg.sender, baseOut);
        _sendUsdc(msg.sender, quoteOut);
        emit LiquidityRemoved(msg.sender, shareAmount, baseOut, quoteOut);
    }

    /// @notice Доли LP владельца.
    function sharesOf(address owner) external view returns (uint256) {
        return shares[owner];
    }

    // --- обмен ---------------------------------------------------------------

    /// @notice Сколько USDC получит покупатель за baseIn LMN.
    function quoteOut(uint256 baseIn) public view returns (uint256) {
        if (baseReserve == 0 || quoteReserve == 0) return 0;
        uint256 effIn = baseIn - (baseIn * FEE_BPS) / BPS;
        return (quoteReserve * effIn) / (baseReserve + effIn);
    }

    /// @notice Сколько LMN получит покупатель за quoteIn USDC.
    function quoteLmn(uint256 quoteIn) public view returns (uint256) {
        if (baseReserve == 0 || quoteReserve == 0) return 0;
        uint256 effIn = quoteIn - (quoteIn * FEE_BPS) / BPS;
        return (baseReserve * effIn) / (quoteReserve + effIn);
    }

    /// @notice Купить LMN за USDC.
    function buyLmn(uint256 quoteIn) external returns (uint256 out) {
        if (quoteIn == 0) revert ZeroAmount();
        if (baseReserve == 0) revert NoLiquidity();
        uint256 effIn = quoteIn - (quoteIn * FEE_BPS) / BPS;
        out = (baseReserve * effIn) / (quoteReserve + effIn);
        if (out == 0) revert ZeroAmount();

        baseReserve -= out;
        quoteReserve += quoteIn;
        _pullUsdc(msg.sender, quoteIn);
        _sendLmn(msg.sender, out);
        emit Swap(msg.sender, false, quoteIn, out);
    }

    /// @notice Продать LMN за USDC.
    function sellLmn(uint256 baseIn) external returns (uint256 out) {
        if (baseIn == 0) revert ZeroAmount();
        if (quoteReserve == 0) revert NoLiquidity();
        uint256 effIn = baseIn - (baseIn * FEE_BPS) / BPS;
        out = (quoteReserve * effIn) / (baseReserve + effIn);
        if (out == 0) revert ZeroAmount();

        baseReserve += baseIn;
        quoteReserve -= out;
        _pullLmn(msg.sender, baseIn);
        _sendUsdc(msg.sender, out);
        emit Swap(msg.sender, true, baseIn, out);
    }

    // --- внутреннее ---------------------------------------------------------

    function _pullLmn(address from, uint256 amount) private {
        if (!lmn.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _pullUsdc(address from, uint256 amount) private {
        (bool ok, bytes memory data) = usdc.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", from, address(this), amount));
        if (!ok || !_isTrue(data)) revert TransferFailed();
    }

    function _sendLmn(address to, uint256 amount) private {
        if (!lmn.transfer(to, amount)) revert TransferFailed();
    }

    function _sendUsdc(address to, uint256 amount) private {
        (bool ok, bytes memory data) = usdc.call(abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        if (!ok || !_isTrue(data)) revert TransferFailed();
    }

    /// @dev ERC-20 возвращает bool; пустой ответ тоже считаем успехом.
    function _isTrue(bytes memory data) private pure returns (bool) {
        if (data.length == 0) return true;
        if (data.length < 32) return false;
        return abi.decode(data, (bool));
    }
}
