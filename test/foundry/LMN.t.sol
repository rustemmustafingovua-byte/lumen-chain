// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LMN} from "../../contracts/LMN.sol";

contract LMNTest is Test {
    LMN lmn;
    address treasury = address(0x7EA);
    /// Тестовый ключ (well-known, публичный): 0x59c6…690d
    uint256 internal constant ALICE_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant BOB_PK = 0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba;
    address alice;
    address bob;

    function setUp() public {
        alice = vm.addr(ALICE_PK);
        bob = vm.addr(BOB_PK);
        vm.label(alice, "alice");
        vm.label(bob, "bob");
        lmn = new LMN(treasury);
    }

    function test_PremineToTreasury() public view {
        assertEq(lmn.totalSupply(), 600_000_000e6, "60% of premine goes to the treasury");
        assertEq(lmn.balanceOf(treasury), 600_000_000e6);
        assertEq(lmn.name(), "Lumen");
        assertEq(lmn.symbol(), "LMN");
        assertEq(lmn.decimals(), 6);
    }

    function test_TransferWorks() public {
        vm.prank(treasury);
        lmn.transfer(alice, 1_000e6);
        assertEq(lmn.balanceOf(alice), 1_000e6);
        assertEq(lmn.balanceOf(treasury), 600_000_000e6 - 1_000e6);
    }

    function test_TransferRejectsInsufficientBalance() public {
        vm.prank(alice);
        vm.expectRevert(LMN.InsufficientBalance.selector);
        lmn.transfer(bob, 1e6);
    }

    function test_TransferToZeroRejected() public {
        vm.prank(treasury);
        vm.expectRevert(LMN.TransferToZero.selector);
        lmn.transfer(address(0), 1e6);
    }

    function test_ApproveAndTransferFrom() public {
        vm.prank(treasury);
        lmn.transfer(alice, 1_000e6);
        vm.prank(alice);
        lmn.approve(bob, 100e6);
        vm.prank(bob);
        lmn.transferFrom(alice, bob, 40e6);
        assertEq(lmn.balanceOf(bob), 40e6);
        assertEq(lmn.allowance(alice, bob), 60e6);
    }

    function test_PermitSetsAllowance() public {
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alice, bob, 100e6);
        lmn.permit(alice, bob, 100e6, block.timestamp + 1 hours, v, r, s);
        assertEq(lmn.allowance(alice, bob), 100e6);
    }

    function test_PermitRejectsExpired() public {
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(alice, bob, 100e6);
        vm.expectRevert(LMN.Expired.selector);
        lmn.permit(alice, bob, 100e6, block.timestamp - 1, v, r, s);
    }

    function _signPermit(address owner, address spender, uint256 value)
        private
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                spender,
                value,
                lmn.nonces(owner),
                block.timestamp + 1 hours
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", lmn.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(owner == alice ? ALICE_PK : BOB_PK, digest);
    }
}
