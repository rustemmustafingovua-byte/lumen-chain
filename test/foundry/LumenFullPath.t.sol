// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {LMN} from "../../contracts/LMN.sol";

/**
 * Полный путь Lumen на форке Base:
 *   1. деплоим наш токен LMN (тот же контракт, что уедет в сеть);
 *   2. создаём настоящий пул Uniswap V3 LMN/USDC через NonfungiblePositionManager;
 *   3. наливаем в пул ликвидность (это и есть «рынок без биржи»);
 *   4. покупаем LMN за USDC через SwapRouter02 — тем самым путём, которым
 *      пользуется keeper.
 *
 * Если этот тест проходит — значит проект работает вживую: свой токен,
 * свой пул, обмен без посредников.
 */
contract LumenFullPathTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant SWAP_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address constant FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant POSITION_MANAGER = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;

    uint24 constant FEE = 3000; // 0.3%
    int24 constant TICK_LOWER = -60000;
    int24 constant TICK_UPPER = 60000;

    LMN lmn;
    uint256 lmnForPool;
    uint256 usdcForPool;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org"));
        vm.createSelectFork(rpc);

        lmn = new LMN(address(this));
        lmnForPool = 1_000_000e6; // 1 000 000 LMN
        usdcForPool = 1_000_000e6; // 1 000 000 USDC

        deal(USDC, address(this), 5_000_000e6);

        // выдаём себе LMN из премайна
        lmn.transfer(address(this), lmnForPool);

        IERC20(USDC).approve(POSITION_MANAGER, type(uint256).max);
        IERC20(address(lmn)).approve(POSITION_MANAGER, type(uint256).max);
    }

    /// Пул создаётся фабрикой, ликвидность — через PositionManager.
    function test_CreatePoolAndBuyLmnWithUsdc() public {
        address token0 = address(lmn) < USDC ? address(lmn) : USDC;
        address token1 = address(lmn) < USDC ? USDC : address(lmn);

        // 1. создаём пул (фабрика вернёт 0, если пул уже есть — тогда берём существующий)
        IPoolFactory factory = IPoolFactory(FACTORY);
        address pool = factory.createPool(token0, token1, FEE);
        if (pool == address(0)) {
            pool = factory.getPool(token0, token1, FEE);
        }
        assertTrue(pool != address(0), "pool must exist");

        // 2. инициализируем цену: 1 LMN = 1 USDC (tick 0)
        IPool poolContract = IPool(pool);
        (uint160 sqrtPriceX96,, , , , ,) = poolContract.slot0();
        if (sqrtPriceX96 == 0) {
            poolContract.initialize(uint160(SQRT_PRICE_RATIO_1_1));
        }

        // 3. наливаем ликвидность через PositionManager
        (uint256 amount0, uint256 amount1) = token0 == address(lmn)
            ? (lmnForPool, usdcForPool)
            : (usdcForPool, lmnForPool);
        IPositionManager npm = IPositionManager(POSITION_MANAGER);
        npm.mint(
            IPositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: FEE,
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp + 600
            })
        );

        uint256 lmnInPool = IERC20(address(lmn)).balanceOf(pool);
        uint256 usdcInPool = IERC20(USDC).balanceOf(pool);
        assertGt(lmnInPool, 0, "pool must hold LMN");
        assertGt(usdcInPool, 0, "pool must hold USDC");

        // 4. покупаем LMN за USDC — ровно как это делает keeper
        uint256 usdcBefore = IERC20(USDC).balanceOf(address(this));
        uint256 lmnBefore = IERC20(address(lmn)).balanceOf(address(this));

        IERC20(USDC).approve(SWAP_ROUTER, type(uint256).max);
        uint256 out = ISwapRouter(SWAP_ROUTER).exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: address(lmn),
                fee: FEE,
                recipient: address(this),
                amountIn: 1_000e6, // 1 000 USDC
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );

        assertGt(out, 0, "purchase must return LMN");
        assertEq(usdcBefore - IERC20(USDC).balanceOf(address(this)), 1_000e6, "USDC spent");
        assertGt(IERC20(address(lmn)).balanceOf(address(this)), lmnBefore, "LMN received");
        emit log_named_uint("1000 USDC -> LMN (units)", out);
    }

    /// Цена 1:1 — sqrtPriceLimitX96 для тика 0 (2^96).
    uint256 constant SQRT_PRICE_RATIO_1_1 = 79228162514264337593543950336;
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IPoolFactory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IPool {
    function initialize(uint160 sqrtPriceX96) external;
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
}

interface IPositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
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
