// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {LMN} from "../contracts/LMN.sol";
import {LumenAMM} from "../contracts/LumenAMM.sol";

interface IFactory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IPool {
    function initialize(uint160 sqrtPriceX96) external;
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
}

interface INonfungiblePositionManager {
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

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/**
 * Создаёт рынок LMN/USDC прямо в Uniswap V3 на Base.
 *
 * Это и есть «биржа без биржи»: пул создаётся нашим же токеном, ликвидность
 * кладёт казна, а keeper потом покупает LMN за USDC через этот пул.
 *
 *   forge script script/CreatePool.s.sol:CreatePool --rpc-url $BASE_RPC --broadcast \
 *     --private-key $PRIVATE_KEY
 */
contract CreatePool is Script {
    address constant FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address constant POSITION_MANAGER = 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint24 constant FEE = 3000; // 0.3%
    uint256 constant SQRT_1_1 = 79228162514264337593543950336; // tick 0 → 1 LMN = 1 USDC

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address lmn = vm.envAddress("LMN");
        address treasury = vm.envOr("TREASURY", msg.sender);

        vm.startBroadcast(pk);

        (address token0, address token1) = lmn < USDC ? (lmn, USDC) : (USDC, lmn);

        IFactory factory = IFactory(FACTORY);
        address pool = factory.getPool(token0, token1, FEE);
        if (pool == address(0)) {
            pool = factory.createPool(token0, token1, FEE);
        }
        IPool poolContract = IPool(pool);
        (uint160 sqrtPriceX96,, , , , ,) = poolContract.slot0();
        if (sqrtPriceX96 == 0) {
            poolContract.initialize(uint160(SQRT_1_1));
        }

        // ликвидность: сколько есть у казны, столько и кладём
        (uint256 amount0, uint256 amount1) = lmn < USDC
            ? (IERC20(lmn).balanceOf(treasury), IERC20(USDC).balanceOf(treasury))
            : (IERC20(USDC).balanceOf(treasury), IERC20(lmn).balanceOf(treasury));

        if (amount0 > 0 && amount1 > 0) {
            IERC20(lmn).approve(POSITION_MANAGER, type(uint256).max);
            IERC20(USDC).approve(POSITION_MANAGER, type(uint256).max);
            IERC20(lmn).transfer(address(this), amount0);
            IERC20(USDC).transfer(address(this), amount1);

            (uint256 tokenId, uint128 liquidity,,) = INonfungiblePositionManager(POSITION_MANAGER).mint(
                    INonfungiblePositionManager.MintParams({
                        token0: token0,
                        token1: token1,
                        fee: FEE,
                        tickLower: -60000,
                        tickUpper: 60000,
                        amount0Desired: amount0,
                        amount1Desired: amount1,
                        amount0Min: 0,
                        amount1Min: 0,
                        recipient: treasury,
                        deadline: block.timestamp + 600
                    })
                );
            console.log("position minted:", tokenId);
            console.log("liquidity:", uint256(liquidity));
        } else {
            console.log("no liquidity in the treasury - add LMN and USDC, then run again");
        }

        vm.stopBroadcast();

        console.log("pool:", pool);
        console.log("next: keeper will buy LMN for USDC through this pool");
    }
}
