// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {PolicyVaultTest} from "./PolicyVault.t.sol";
import {PolicyVault} from "../src/PolicyVault.sol";

/// @notice Regression tests for the lifecycle bugs found in review (issue #4). Each asserts the opposite
/// of a Codex probe (research/review-2026-10-16/codex-probes) that passed on v2 and fails on v3.
contract PolicyVaultV3Test is PolicyVaultTest {
    function _held(bytes32 id) internal view returns (uint128 amount) {
        (,,, amount,,) = vault.held(id);
    }

    // ------------------------------------------------- held payments vs revocation (S-6)

    function test_removedAgentHeldPaymentIsCancelled() public {
        policy(50e6, 40e6, 1 days, 0, 5e6, 2 minutes);
        pay(claude, 8e6, "held");
        vm.prank(guardian);
        vault.freezeAgent(claude);
        sign(PolicyVault.Op.RemoveAgent, abi.encode(claude));
        vm.warp(block.timestamp + 121);
        vault.release("held");
        assertEq(token.balanceOf(shop), 0, "a disconnected agent's payment must not leave");
        assertEq(_held("held"), 0);
        assertEq(vault.heldTotal(), 0, "the money is freed");
    }

    function test_expiredAgentHeldPaymentIsCancelled() public {
        sign(PolicyVault.Op.SetAgent, abi.encode(claude, uint128(10e6), uint128(15e6), uint64(block.timestamp + 30)));
        policy(50e6, 40e6, 1 days, 0, 5e6, 2 minutes);
        pay(claude, 8e6, "expiry");
        vm.warp(block.timestamp + 121);
        vault.release("expiry");
        assertEq(token.balanceOf(shop), 0);
        assertEq(vault.heldTotal(), 0);
    }

    function test_releaseCannotBreachARaisedProtectedAmount() public {
        policy(50e6, 40e6, 1 days, 0, 5e6, 2 minutes);
        pay(claude, 8e6, "held");
        policy(248e6, 40e6, 1 days, 0, 5e6, 2 minutes);
        vm.warp(block.timestamp + 121);
        vm.expectRevert(PolicyVault.BreachesProtected.selector);
        vault.release("held");
        assertEq(token.balanceOf(address(vault)), 250e6);
        // Lowering it again (or cancelling) settles it.
        policy(50e6, 40e6, 1 days, 0, 5e6, 2 minutes);
        vault.release("held");
        assertEq(token.balanceOf(shop), 8e6);
    }

    function test_readdedContactCancelsAnOlderHold() public {
        policy(50e6, 40e6, 1 days, 0, 5e6, 2 minutes);
        pay(claude, 8e6, "contact");
        sign(PolicyVault.Op.RemoveContact, abi.encode(shopId));
        sign(PolicyVault.Op.AddContact, abi.encode(shopId, shop, false, uint128(0)));
        vm.warp(block.timestamp + 121);
        vault.release("contact");
        assertEq(token.balanceOf(shop), 0, "a hold made before the contact was re-added must not pay it");
        assertEq(vault.heldTotal(), 0);
    }

    // ------------------------------------------------ revocation voids older approvals

    function test_revocationVoidsAnOlderQueuedGrant() public {
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        bytes memory data = abi.encode(claude, uint128(20e6), uint128(30e6), uint64(block.timestamp + 30 days));
        sign(PolicyVault.Op.SetAgent, data);
        uint256 oldNonce = nonce;
        vm.prank(guardian);
        vault.freezeAgent(claude);
        sign(PolicyVault.Op.RemoveAgent, abi.encode(claude));
        vm.warp(block.timestamp + 121);
        vm.expectRevert(PolicyVault.Stale.selector);
        vault.finalize(PolicyVault.Op.SetAgent, data, oldNonce);
        vm.prank(claude);
        vm.expectRevert(PolicyVault.NotAgent.selector);
        vault.agentPay(shopId, 20e6, "after-revoke", 0);
    }

    function test_freezeVoidsAnOlderQueuedUnfreeze() public {
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        vm.prank(guardian);
        vault.freezeAgent(claude);
        sign(PolicyVault.Op.Unfreeze, abi.encode(claude));
        uint256 n = nonce;
        // Something looks wrong again: a second freeze while the unfreeze waits.
        vm.prank(guardian);
        vault.freezeAgent(claude);
        vm.warp(block.timestamp + 121);
        vm.expectRevert(PolicyVault.Stale.selector);
        vault.finalize(PolicyVault.Op.Unfreeze, abi.encode(claude), n);
    }

    function test_removedOwnerKeyVoidsChangesItApproved() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(0xB0B);
        sign(PolicyVault.Op.AddOwnerKey, abi.encode(bytes32(x), bytes32(y), sha256(bytes(RP_ID))));
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        bytes memory data = abi.encode(claude, uint128(20e6), uint128(30e6), uint64(block.timestamp + 30 days));
        sign(PolicyVault.Op.SetAgent, data);
        uint256 grantNonce = nonce;
        sign(PolicyVault.Op.RemoveOwnerKey, abi.encode(keyId));
        uint256 removeNonce = nonce;
        vm.warp(block.timestamp + 121);
        vault.finalize(PolicyVault.Op.RemoveOwnerKey, abi.encode(keyId), removeNonce);
        vm.expectRevert(PolicyVault.Stale.selector);
        vault.finalize(PolicyVault.Op.SetAgent, data, grantNonce);
    }

    function test_removeAndReaddCannotSkipTheUnfreezeDelay() public {
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        vm.prank(guardian);
        vault.freezeAgent(claude);
        uint8[] memory ops = new uint8[](2);
        bytes[] memory datas = new bytes[](2);
        ops[0] = uint8(PolicyVault.Op.RemoveAgent);
        datas[0] = abi.encode(claude);
        ops[1] = uint8(PolicyVault.Op.SetAgent);
        datas[1] = abi.encode(claude, uint128(10e6), uint128(15e6), uint64(block.timestamp + 30 days));
        sign(PolicyVault.Op.Batch, abi.encode(ops, datas));
        vm.prank(claude);
        vm.expectRevert(PolicyVault.AgentFrozen.selector);
        vault.agentPay(shopId, 3e6, "batch-unfreeze", 0);
        assertEq(token.balanceOf(shop), 0);
    }

    // ----------------------------------------------- owner payments to new addresses (S-7)

    function test_ownerPayToUnknownAddressIsQueued() public {
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        address stranger = makeAddr("stranger");
        sign(PolicyVault.Op.Pay, abi.encode(stranger, 100e6, bytes32("new")));
        assertEq(token.balanceOf(stranger), 0, "not paid at once");
        vm.warp(block.timestamp + 121);
        vault.finalize(PolicyVault.Op.Pay, abi.encode(stranger, 100e6, bytes32("new")), nonce);
        assertEq(token.balanceOf(stranger), 100e6, "paid after the delay");
    }

    function test_guardianCancelsOwnerPayToUnknownAddress() public {
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        address stranger = makeAddr("stranger");
        bytes memory data = abi.encode(stranger, 100e6, bytes32("phished"));
        sign(PolicyVault.Op.Pay, data);
        bytes32 id = vault.changeIdOf(PolicyVault.Op.Pay, data, nonce);
        vm.prank(guardian);
        vault.cancelChange(id);
        vm.warp(block.timestamp + 121);
        vm.expectRevert(PolicyVault.NotQueued.selector);
        vault.finalize(PolicyVault.Op.Pay, data, nonce);
        assertEq(token.balanceOf(stranger), 0);
    }

    function test_ownerPayToSavedContactIsInstant() public {
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        sign(PolicyVault.Op.Pay, abi.encode(shop, 20e6, bytes32("known")));
        assertEq(token.balanceOf(shop), 20e6);
    }

    function test_removedContactAddressIsUnknownAgain() public {
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        sign(PolicyVault.Op.RemoveContact, abi.encode(shopId));
        sign(PolicyVault.Op.Pay, abi.encode(shop, 20e6, bytes32("gone")));
        assertEq(token.balanceOf(shop), 0, "queued, since the address is no longer saved");
    }

    // --------------------------------------------------------- per-contact caps (2012)

    function test_contactCapSpansAgents() public {
        bytes32 capped = keccak256("contact:capped");
        address cafe = makeAddr("cafe");
        sign(PolicyVault.Op.AddContact, abi.encode(capped, cafe, true, uint128(10e6)));
        vm.prank(claude);
        assertTrue(vault.agentPay(capped, 6e6, "c1", 0));
        vm.prank(chatgpt);
        vm.recordLogs();
        assertFalse(vault.agentPay(capped, 6e6, "c2", 0), "two agents together can't pass the contact's cap");
        assertEq(token.balanceOf(cafe), 6e6);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(chatgpt);
        assertTrue(vault.agentPay(capped, 6e6, "c3", 0), "the window rolls");
    }

    function test_raisingAContactCapWaits() public {
        bytes32 capped = keccak256("contact:capped");
        address cafe = makeAddr("cafe");
        sign(PolicyVault.Op.AddContact, abi.encode(capped, cafe, false, uint128(10e6)));
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        sign(PolicyVault.Op.AddContact, abi.encode(capped, cafe, false, uint128(50e6)));
        assertEq(vault.contactCap(capped), 10e6, "raise is queued");
        sign(PolicyVault.Op.AddContact, abi.encode(capped, cafe, false, uint128(5e6)));
        assertEq(vault.contactCap(capped), 5e6, "lowering applies at once");
    }

    function test_capChangeKeepsAnEstablishedContactPayable() public {
        policy(50e6, 40e6, 1 days, 120, 5e6, 2 minutes);
        pay(claude, 8e6, "before-cap");
        (, uint64 activeAt) = vault.contacts(shopId);
        sign(PolicyVault.Op.AddContact, abi.encode(shopId, shop, false, uint128(9e6)));
        (, uint64 after_) = vault.contacts(shopId);
        assertEq(after_, activeAt, "no new waiting period");
        assertEq(vault.contactCap(shopId), 9e6);
        vm.warp(block.timestamp + 121);
        vault.release("before-cap");
        assertEq(token.balanceOf(shop), 8e6, "an older hold still settles");
        vm.prank(claude);
        assertFalse(vault.agentPay(shopId, 2e6, "over-cap", 0), "8 + 2 passes the new 9 cap");
    }

    function test_version() public view {
        assertEq(vault.VERSION(), 3);
    }

    /// The owner-approved exception still can't be swapped (kept from v2, re-run on v3 data).
    function test_substitutedQueuedPayFailsTheSignature() public {
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        PolicyVault.Action memory a = action(PolicyVault.Op.Pay, abi.encode(shop, 20e6, bytes32("ok")));
        WebAuthn.WebAuthnAuth memory auth = assertion(ownerPk, vault.digest(a), RP_ID, 0x05);
        a.data = abi.encode(makeAddr("attacker"), 200e6, bytes32("ok"));
        vm.expectRevert(PolicyVault.BadSignature.selector);
        vault.execute(a, keyId, auth);
    }
}
