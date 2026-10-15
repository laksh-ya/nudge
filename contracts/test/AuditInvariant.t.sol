// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {Passkey} from "./PolicyVault.t.sol";

/// Random agent payments with holds switched on, releases, guardian cancels and freezes, a stolen key
/// aimed at an unsaved address, and clock jumps. The existing invariant suite runs without holds.
contract HoldHandler is Test {
    PolicyVault public vault;
    TestUSD public token;
    address public guardian;
    address public attacker;
    address[3] public agents; // two real agents and one address that was never registered
    bytes32[2] public contactIds; // a saved shop, and an id nobody saved
    bytes32[] public ids;
    uint256[] public times;
    uint256[] public amounts;
    uint256 public refusedUnknown;
    /// Largest sum of accepted requests seen in any 24 hours, updated as each one lands.
    uint256 public maxWindow;
    uint256 n;

    constructor(PolicyVault v, TestUSD t, address g, address a, address b, bytes32 shopId, address att) {
        (vault, token, guardian, attacker) = (v, t, g, att);
        agents = [a, b, att];
        contactIds = [shopId, keccak256("attacker-contact")];
    }

    function pay(uint256 who, uint256 which, uint256 amount) external {
        // Mostly honest traffic; one call in six comes from the stolen key or aims at an unsaved contact,
        // so strikes don't freeze both agents in the first few steps.
        address agent = who % 6 == 0 ? agents[2] : agents[who % 2];
        bytes32 contact = which % 6 == 0 ? contactIds[1] : contactIds[0];
        amount = bound(amount, 1, 12e6); // a little above Agent A's $10 limit, so some refusals
        bytes32 id = bytes32(++n);
        vm.prank(agent);
        try vault.agentPay(contact, amount, id, 0) returns (bool ok) {
            if (ok) {
                ids.push(id);
                times.push(block.timestamp);
                amounts.push(amount);
                uint256 sum;
                for (uint256 j = times.length; j > 0 && times[j - 1] + 24 hours > block.timestamp; --j) {
                    sum += amounts[j - 1];
                }
                if (sum > maxWindow) maxWindow = sum;
            } else if (contact != contactIds[0]) {
                refusedUnknown++;
            }
        } catch {}
    }

    function release(uint256 i) external {
        if (ids.length == 0) return;
        try vault.release(ids[i % ids.length]) {} catch {}
    }

    function cancel(uint256 i) external {
        if (ids.length == 0) return;
        vm.prank(guardian);
        try vault.cancelHeld(ids[i % ids.length]) {} catch {}
    }

    /// Rare, so most runs keep paying after one agent is frozen.
    function freezeOne(uint256 who) external {
        if (who % 25 != 0) return;
        vm.prank(guardian);
        vault.freezeAgent(agents[who % 2]);
    }

    function wait(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 12 hours));
    }

    function count() external view returns (uint256) {
        return times.length;
    }

    function idAt(uint256 i) external view returns (bytes32) {
        return ids[i];
    }
}

contract AuditInvariant is Passkey {
    PolicyVault vault;
    TestUSD token;
    HoldHandler handler;
    uint256 ownerPk = 0xA11CE;
    uint256 nonce;
    address guardian = makeAddr("guardian");
    address attacker = makeAddr("attacker");
    address shop = makeAddr("shop");

    function setUp() public {
        vm.warp(1_790_000_000);
        token = new TestUSD();
        VaultFactory factory = new VaultFactory(guardian);
        (uint256 x, uint256 y) = vm.publicKeyP256(ownerPk);
        vault = factory.createVault(token, bytes32(x), bytes32(y), sha256(bytes(RP_ID)), 50e6, 40e6, 0, 0);
        token.faucet(address(vault), 200e6);
        address a = makeAddr("a");
        address b = makeAddr("b");
        bytes32 shopId = keccak256("shop");
        sign(PolicyVault.Op.SetAgent, abi.encode(a, uint128(10e6), uint128(25e6), uint64(block.timestamp + 365 days)));
        sign(PolicyVault.Op.SetAgent, abi.encode(b, uint128(20e6), uint128(30e6), uint64(block.timestamp + 365 days)));
        sign(PolicyVault.Op.AddContact, abi.encode(shopId, shop, true));
        // Holds above $5 for 10 minutes.
        sign(PolicyVault.Op.SetPolicy, abi.encode(uint256(50e6), uint256(40e6), uint64(0), uint64(0), uint256(5e6), uint64(10 minutes)));
        handler = new HoldHandler(vault, token, guardian, a, b, shopId, attacker);
        targetContract(address(handler));
    }

    function sign(PolicyVault.Op op, bytes memory data) internal {
        PolicyVault.Action memory act =
            PolicyVault.Action({op: op, data: data, nonce: ++nonce, deadline: uint64(block.timestamp + 600)});
        (uint256 x, uint256 y) = vm.publicKeyP256(ownerPk);
        vault.execute(act, vault.keyIdOf(bytes32(x), bytes32(y)), assertion(ownerPk, vault.digest(act), RP_ID, 0x05));
    }

    /// Agents and releases never take the vault below the protected amount (protection is not raised here).
    /// forge-config: default.invariant.depth = 256
    function invariant_protectedHoldsWithHolds() public view {
        assertGe(token.balanceOf(address(vault)), 50e6);
    }

    /// Money only ever leaves to the saved shop; never to the attacker or anyone else.
    /// forge-config: default.invariant.depth = 256
    function invariant_onlySavedContactsGetPaid() public view {
        assertEq(token.balanceOf(attacker), 0);
        assertEq(token.balanceOf(shop) + token.balanceOf(address(vault)), 200e6);
    }

    /// heldTotal equals the sum of payments still held.
    /// forge-config: default.invariant.depth = 256
    function invariant_heldTotalMatchesHeldPayments() public view {
        uint256 sum;
        uint256 c = handler.count();
        for (uint256 i; i < c; ++i) {
            (,,, uint128 amount,) = vault.held(handler.idAt(i));
            sum += amount;
        }
        assertEq(sum, vault.heldTotal());
    }

    /// Requests accepted in any 24 hours stay under the ceiling, holds included.
    /// forge-config: default.invariant.depth = 256
    function invariant_requestCeilingHoldsWithHolds() public view {
        assertLe(handler.maxWindow(), 40e6);
    }
}
