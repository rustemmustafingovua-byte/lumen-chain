// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {LMN} from "../contracts/LMN.sol";
import {LumenAMM} from "../contracts/LumenAMM.sol";

/**
 * Деплой Lumen в сеть Base.
 *
 *   forge script script/Deploy.s.sol:Deploy --rpc-url $BASE_RPC --broadcast --verify \
 *     --private-key $PRIVATE_KEY
 *
 * Переменные окружения:
 *   TREASURY      адрес казны (куда уходит 60% премайна)   — по умолчанию msg.sender
 *   USDC          адрес USDC в сети Base (для AMM)          — по умолчанию USDC Base
 *
 * После деплоя печатаются адреса и хеши транзакций — их нужно записать
 * в ~/.lumen/keeper.json ("lmn") и в README.
 */
contract Deploy is Script {
    address constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address treasury = vm.envOr("TREASURY", msg.sender);
        address usdc = vm.envOr("USDC", USDC_BASE);

        vm.startBroadcast(pk);

        LMN lmn = new LMN(treasury);
        LumenAMM amm = new LumenAMM(lmn, usdc);

        vm.stopBroadcast();

        console.log("=== Lumen deployed ===");
        console.log("LMN (ERC-20)  :", address(lmn));
        console.log("LumenAMM      :", address(amm));
        console.log("Treasury      :", treasury);
        console.log("USDC (AMM)    :", usdc);
        console.log("Decimals      :", lmn.decimals());
        console.log("Premine (60%) :", lmn.balanceOf(treasury) / 1e6);
        console.log("");
        console.log("Next steps:");
        console.log("1. put the LMN address into keeper.json (\"lmn\")");
        console.log("2. fill the AMM: amm.addLiquidity(base, quote) - this is the exchange-free market");
        console.log("3. the keeper starts buying LMN with USDC automatically");
    }
}
