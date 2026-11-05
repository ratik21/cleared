// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Script} from "forge-std/Script.sol";
import {ClearedSettlement, IUSDT3009} from "../src/ClearedSettlement.sol";

contract Deploy is Script {
    function run() external returns (ClearedSettlement settlement) {
        vm.startBroadcast(vm.envUint("RELAYER_PRIVATE_KEY"));
        settlement = new ClearedSettlement(IUSDT3009(vm.envAddress("USDT_ADDRESS")), vm.envAddress("TREASURY_ADDRESS"));
        vm.stopBroadcast();
    }
}
