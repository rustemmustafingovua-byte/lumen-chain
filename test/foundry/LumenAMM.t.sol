// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LMN} from "../../contracts/LMN.sol";
import {LumenAMM} from "../../contracts/LumenAMM.sol";

/// Минимальный USDC для тестов: те же 6 знаков, что у настоящего.
contract MockUSDC {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract LumenAMMTest is Test {
    LMN lmn;
    MockUSDC usdc;
    LumenAMM amm;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        lmn = new LMN(address(this));
        usdc = new MockUSDC();
        amm = new LumenAMM(lmn, address(usdc));

        lmn.transfer(alice, 1_000_000e6);
        lmn.transfer(bob, 1_000_000e6);
        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob, 1_000_000e6);

        vm.startPrank(alice);
        lmn.approve(address(amm), type(uint256).max);
        usdc.approve(address(amm), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(bob);
        lmn.approve(address(amm), type(uint256).max);
        usdc.approve(address(amm), type(uint256).max);
        vm.stopPrank();
    }

    function test_AddLiquidityMintsShares() public {
        vm.prank(alice);
        uint256 minted = amm.addLiquidity(1_000e6, 2_000e6);
        assertEq(minted, 1_000e6, "first provider gets 1:1 shares");
        assertEq(amm.sharesOf(alice), 1_000e6);
        assertEq(amm.totalShares(), 1_000e6);
        assertEq(amm.baseReserve(), 1_000e6);
        assertEq(amm.quoteReserve(), 2_000e6);
    }

    function test_SecondProviderGetsProportionalShares() public {
        vm.prank(alice);
        amm.addLiquidity(1_000e6, 2_000e6);

        vm.prank(bob);
        uint256 minted = amm.addLiquidity(500e6, 1_000e6);
        assertEq(minted, 500e6, "shares are proportional to the deposit");
        assertEq(amm.totalShares(), 1_500e6);
        assertEq(amm.sharesOf(bob), 500e6);
    }

    function test_CannotWithdrawOtherShares() public {
        vm.prank(alice);
        amm.addLiquidity(1_000e6, 2_000e6);

        vm.prank(bob);
        vm.expectRevert(LumenAMM.InsufficientShares.selector);
        amm.removeLiquidity(1_000e6);

        vm.prank(alice);
        vm.expectRevert(LumenAMM.InsufficientShares.selector);
        amm.removeLiquidity(2_000e6);
    }

    function test_RemoveLiquidityReturnsProportionalReserves() public {
        vm.prank(alice);
        amm.addLiquidity(1_000e6, 2_000e6);
        vm.prank(bob);
        amm.addLiquidity(1_000e6, 2_000e6);

        uint256 lmnBefore = lmn.balanceOf(alice);
        uint256 usdcBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        (uint256 baseOut, uint256 quoteOut) = amm.removeLiquidity(1_000e6);

        assertEq(baseOut, 1_000e6, "base asset returned");
        assertEq(quoteOut, 2_000e6, "quote asset returned");
        assertEq(lmn.balanceOf(alice) - lmnBefore, 1_000e6);
        assertEq(usdc.balanceOf(alice) - usdcBefore, 2_000e6);
        assertEq(amm.sharesOf(alice), 0);
        assertEq(amm.sharesOf(bob), 1_000e6);
    }

    function test_FeeStaysInPoolAndRaisesSharePrice() public {
        vm.prank(alice);
        amm.addLiquidity(1_000e6, 1_000e6);
        uint256 priceBefore = amm.baseReserve() * 1e6 / amm.totalShares();

        vm.prank(bob);
        uint256 out = amm.sellLmn(100e6);
        assertGt(out, 0, "sell returns USDC");

        uint256 priceAfter = amm.baseReserve() * 1e6 / amm.totalShares();
        assertGt(priceAfter, priceBefore, "share price grew thanks to the fee");
        assertEq(amm.totalShares(), 1_000e6, "shares do not change on swaps");
    }

    function test_BuyLmnSpendsUsdc() public {
        vm.prank(alice);
        amm.addLiquidity(1_000e6, 1_000e6);

        uint256 lmnBefore = lmn.balanceOf(bob);
        uint256 usdcBefore = usdc.balanceOf(bob);

        vm.prank(bob);
        uint256 out = amm.buyLmn(100e6);

        assertGt(out, 0);
        assertEq(lmn.balanceOf(bob) - lmnBefore, out);
        assertEq(usdcBefore - usdc.balanceOf(bob), 100e6);
    }

    function test_RevertOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(LumenAMM.ZeroAmount.selector);
        amm.addLiquidity(0, 1_000e6);
    }
}
