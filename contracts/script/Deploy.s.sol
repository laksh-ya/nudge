// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {TestUSD} from "../src/TestUSD.sol";

/// forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
/// The relayer that deploys is also the guardian: it may freeze, never move money.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("RELAYER_PRIVATE_KEY");
        address guardian = vm.addr(pk);
        // Reuse an existing test token when TOKEN_ADDRESS is set (redeploying only the factory).
        address existing = vm.envOr("TOKEN_ADDRESS", address(0));
        vm.startBroadcast(pk);
        TestUSD token = existing == address(0) ? new TestUSD() : TestUSD(existing);
        VaultFactory factory = new VaultFactory(guardian);
        vm.stopBroadcast();
        console.log("TestUSD", address(token));
        console.log("VaultFactory", address(factory));
        console.log("Guardian", guardian);
    }
}
