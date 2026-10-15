// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {Passkey} from "./PolicyVault.t.sol";

/// Random agent payments and clock jumps. Tracks every successful payment with its time.
contract Handler is Test {
    PolicyVault public vault;
    TestUSD public token;
    address[2] public agents;
    bytes32 public shopId;
    uint256[] public times;
    uint256[] public amounts;
    uint256 n;

    constructor(PolicyVault v, TestUSD t, address a, address b, bytes32 id) {
        vault = v;
        token = t;
        agents = [a, b];
        shopId = id;
    }

    function pay(uint256 who, uint256 amount) external {
        address agent = agents[who % 2];
        amount = bound(amount, 1, 40e6);
        vm.prank(agent);
        try vault.agentPay(shopId, amount, bytes32(++n), 0) returns (bool ok) {
            if (ok) {
                times.push(block.timestamp);
                amounts.push(amount);
            }
        } catch {}
    }

    function wait(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 6 hours));
    }

    function count() external view returns (uint256) {
        return times.length;
    }
}

contract PolicyVaultInvariant is Passkey {
    PolicyVault vault;
    TestUSD token;
    Handler handler;
    uint256 ownerPk = 0xA11CE;
    uint256 nonce;

    function setUp() public {
        vm.warp(1_790_000_000);
        token = new TestUSD();
        VaultFactory factory = new VaultFactory(makeAddr("guardian"));
        (uint256 x, uint256 y) = vm.publicKeyP256(ownerPk);
        vault = factory.createVault(token, bytes32(x), bytes32(y), sha256(bytes(RP_ID)), 50e6, 40e6, 0, 0);
        token.faucet(address(vault), 200e6);
        address a = makeAddr("a");
        address b = makeAddr("b");
        bytes32 shopId = keccak256("shop");
        sign(PolicyVault.Op.SetAgent, abi.encode(a, uint128(10e6), uint128(25e6), uint64(block.timestamp + 365 days)));
        sign(PolicyVault.Op.SetAgent, abi.encode(b, uint128(20e6), uint128(30e6), uint64(block.timestamp + 365 days)));
        sign(PolicyVault.Op.AddContact, abi.encode(shopId, makeAddr("shop"), true));
        handler = new Handler(vault, token, a, b, shopId);
        targetContract(address(handler));
    }

    function sign(PolicyVault.Op op, bytes memory data) internal {
        PolicyVault.Action memory act =
            PolicyVault.Action({op: op, data: data, nonce: ++nonce, deadline: uint64(block.timestamp + 600)});
        (uint256 x, uint256 y) = vm.publicKeyP256(ownerPk);
        vault.execute(act, vault.keyIdOf(bytes32(x), bytes32(y)), assertion(ownerPk, vault.digest(act), RP_ID, 0x05));
    }

    /// Agents can never spend into the protected amount.
    function invariant_protectedAmountHolds() public view {
        assertGe(token.balanceOf(address(vault)), 50e6);
    }

    /// In any 24-hour window, all agents together stay under the vault ceiling.
    function invariant_rollingCeilingHolds() public view {
        uint256 c = handler.count();
        for (uint256 i; i < c; ++i) {
            uint256 sum;
            uint256 start = handler.times(i);
            for (uint256 j = i; j < c && handler.times(j) < start + 24 hours; ++j) {
                sum += handler.amounts(j);
            }
            assertLe(sum, 40e6);
        }
    }
}
