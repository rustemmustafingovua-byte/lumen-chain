// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Lumen (LMN) — фиксированная эмиссия 1 000 000 000, без минта после генезиса.
/// ERC-20 с поддержкой permit (EIP-2612), чтобы кошелёк мог подписывать переводы без газа.
contract LMN {
    string public constant name = "Lumen";
    string public constant symbol = "LMN";
    uint8 public constant decimals = 6;
    uint256 public constant MAX_SUPPLY = 1_000_000_000 * 10 ** 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    bytes32 public constant DOMAIN_SEPARATOR_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    mapping(address => uint256) public nonces;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error TransferToZero();
    error OverflowSupply();
    error Expired();
    error BadSignature();

    constructor(address treasury) {
        require(treasury != address(0), "treasury=0");
        uint256 amount = MAX_SUPPLY * 60 / 100; // 60% — premine
        balanceOf[treasury] = amount;
        totalSupply = amount;
        emit Transfer(address(0), treasury, amount);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
        return true;
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        // EIP-2612: дедлайн проверяется по block.timestamp — так же, как в Uniswap Permit2;
        // валидатор может сдвинуть время на секунды, поэтому дедлайны берут с запасом.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert Expired();
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), structHash)
        );
        // отсекаем malleable-подписи (s > secp256k1n/2) ДО восстановления —
        // иначе одну подпись можно переиграть в другую и оплатить лишний раз
        // forge-lint: disable-next-line(ecrecover)
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != owner) revert BadSignature();
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return domainSeparator();
    }

    function domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_SEPARATOR_TYPEHASH, keccak256(bytes(name)), block.chainid, address(this))
        );
    }

    function _move(address from, address to, uint256 value) internal {
        if (to == address(0)) revert TransferToZero();
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance();
        balanceOf[from] = bal - value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
