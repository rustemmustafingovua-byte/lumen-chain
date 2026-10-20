// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

/// Интеграционная проверка пути обмена, который использует keeper:
/// Uniswap V3 на Base (SwapRouter02 + реальные пулы USDC/WETH).
/// Тест работает на форке Base: токены выдаются через deal.
contract UniV3SwapTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant QUOTER = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org"));
        vm.createSelectFork(rpc);
        deal(USDC, address(this), 1_000e6);
        IERC20(USDC).approve(SWAP_ROUTER, type(uint256).max);
    }

    function test_QuoteUsdcToWeth() public {
        uint256 out = IQuoter(QUOTER).quoteExactInputSingle(
            IQuoter.QuoteExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                amountIn: 100e6,
                fee: 500,
                sqrtPriceLimitX96: 0
            })
        );
        assertGt(out, 0, "quote must be non-zero");
        emit log_named_uint("100 USDC -> WETH (wei)", out);
    }

    function test_SwapUsdcToWethThroughRouter() public {
        uint256 before = IERC20(WETH).balanceOf(address(this));
        uint256 out = ISwapRouter(SWAP_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: 500,
                recipient: address(this),
                amountIn: 100e6,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        assertGt(out, 0, "swap must return WETH");
        assertGt(IERC20(WETH).balanceOf(address(this)), before, "WETH balance grew");
    }
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}

interface IQuoter {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut);
}
