// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PolicyVault} from "../src/PolicyVault.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {Passkey} from "./PolicyVault.t.sol";

/// Same world as PolicyVaultTest, without inheriting (and re-running) its 44 tests.
abstract contract AuditBase is Passkey {
    TestUSD token;
    VaultFactory factory;
    PolicyVault vault;

    uint256 ownerPk = 0xA11CE;
    bytes32 keyId;
    address guardian = makeAddr("guardian");
    address claude = makeAddr("claude");
    address chatgpt = makeAddr("chatgpt");
    address shop = makeAddr("shop");
    bytes32 shopId = keccak256("contact:shop");
    uint256 nonce;

    function setUp() public {
        vm.warp(1_790_000_000);
        token = new TestUSD();
        factory = new VaultFactory(guardian);
        (uint256 x, uint256 y) = vm.publicKeyP256(ownerPk);
        vault = factory.createVault(token, bytes32(x), bytes32(y), sha256(bytes(RP_ID)), 50e6, 40e6, 1 days, bytes32(0));
        keyId = vault.keyIdOf(bytes32(x), bytes32(y));
        token.faucet(address(vault), 250e6);
        sign(PolicyVault.Op.SetAgent, abi.encode(claude, uint128(10e6), uint128(15e6), uint64(block.timestamp + 30 days)));
        sign(PolicyVault.Op.SetAgent, abi.encode(chatgpt, uint128(10e6), uint128(30e6), uint64(block.timestamp + 30 days)));
        sign(PolicyVault.Op.AddContact, abi.encode(shopId, shop, true, uint128(0)));
    }

    function action(PolicyVault.Op op, bytes memory data) internal returns (PolicyVault.Action memory) {
        return PolicyVault.Action({op: op, data: data, nonce: ++nonce, deadline: uint64(block.timestamp + 10 minutes)});
    }

    function sign(PolicyVault.Op op, bytes memory data) internal {
        PolicyVault.Action memory a = action(op, data);
        vault.execute(a, keyId, assertion(ownerPk, vault.digest(a), RP_ID, 0x05));
    }

    function policy(uint256 p, uint256 c, uint64 cd, uint64 d, uint256 ha, uint64 hf) internal {
        sign(PolicyVault.Op.SetPolicy, abi.encode(p, c, cd, d, ha, hf));
    }

    function pay(address agent, uint256 amount, bytes32 paymentId) internal returns (bool ok) {
        vm.prank(agent);
        ok = vault.agentPay(shopId, amount, paymentId, keccak256("coffee"));
    }
}

/// @notice Security properties found missing in the 16 Oct 2026 review (docs/TESTING.md, "Findings").
/// Each test states the property the vault SHOULD have, so it fails today and passes once fixed.
/// The green baseline is `forge test --no-match-contract AuditFindings`.
///
/// F1-F3 were first reproduced by the Codex review (as observed-behaviour probes); they are restated
/// here as requirements. F4-F8 are new. All use the PolicyVaultTest world: $250 in the vault, $50
/// protected, $40 ceiling, Claude $10/$15, ChatGPT $10/$30, one saved shop.
contract AuditFindings is AuditBase {
    function signWith(uint256 pk, bytes32 kid, PolicyVault.Op op, bytes memory data)
        internal
        returns (uint256 n)
    {
        PolicyVault.Action memory a = action(op, data);
        n = a.nonce;
        vault.execute(a, kid, assertion(pk, vault.digest(a), RP_ID, 0x05));
    }

    function holds() internal {
        // Holds above $5 for 2 minutes; loosening waits 2 minutes.
        policy(50e6, 40e6, 1 days, 120, 5e6, 2 minutes);
    }

    // ------------------------------------------------------------ revocation

    /// F1. Disconnect = guardian freeze + owner RemoveAgent. RemoveAgent deletes the agent record,
    /// frozen flag included, so its held payment releases afterwards.
    function test_F1_removedAgentsHeldPaymentMustNotRelease() public {
        holds();
        pay(claude, 8e6, bytes32("held"));
        vm.prank(guardian);
        vault.freezeAgent(claude);
        sign(PolicyVault.Op.RemoveAgent, abi.encode(claude));
        vm.warp(block.timestamp + 121);
        try vault.release(bytes32("held")) {} catch {}
        assertEq(token.balanceOf(shop), 0, "a disconnected agent's held payment still paid out");
    }

    /// F3. A grant queued before revocation still applies after it.
    function test_F3_queuedGrantMustNotRestoreRemovedAgent() public {
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        bytes memory grant = abi.encode(claude, uint128(10e6), uint128(15e6), uint64(block.timestamp + 60 days));
        sign(PolicyVault.Op.SetAgent, grant); // longer expiry = loosening, queued
        uint256 grantNonce = nonce;
        vm.prank(guardian);
        vault.freezeAgent(claude);
        sign(PolicyVault.Op.RemoveAgent, abi.encode(claude));
        vm.warp(block.timestamp + 121);
        try vault.finalize(PolicyVault.Op.SetAgent, grant, grantNonce) {} catch {}
        (,,, bool active,,,) = vault.agents(claude);
        assertFalse(active, "a removed agent came back through a grant signed before its removal");
    }

    // ------------------------------------------------------------ protected amount

    /// F2. Raising the protected amount after a hold: the release still takes the vault below it.
    function test_F2_releaseMustNotBreachRaisedProtectedAmount() public {
        holds();
        pay(claude, 8e6, bytes32("held"));
        policy(248e6, 40e6, 1 days, 120, 5e6, 2 minutes); // tighter, applies at once
        vm.warp(block.timestamp + 121);
        try vault.release(bytes32("held")) {} catch {}
        assertGe(token.balanceOf(address(vault)), vault.protectedAmount(), "release went below the protected amount");
    }

    // ------------------------------------------------------------ stale queued authority (new)

    /// F4. The owner signs an unfreeze (queued). Before it applies, the guardian freezes the vault again
    /// because of a new incident. The older unfreeze still applies, and `finalize` lets exactly that op
    /// through a frozen vault.
    function test_F4_staleUnfreezeMustNotUndoALaterFreeze() public {
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        vm.prank(guardian);
        vault.freeze();
        sign(PolicyVault.Op.Unfreeze, abi.encode(address(0))); // queued for 2 minutes
        uint256 unfreezeNonce = nonce;
        vm.warp(block.timestamp + 60);
        vm.prank(guardian);
        vault.freeze(); // new incident after the owner signed
        vm.warp(block.timestamp + 61);
        try vault.finalize(PolicyVault.Op.Unfreeze, abi.encode(address(0)), unfreezeNonce) {} catch {}
        assertTrue(vault.frozen(), "a freeze made after the unfreeze was signed was undone by it");
    }

    /// F5. Lost phone. The thief signs a Withdraw of everything with the stolen passkey (queued). The owner
    /// removes that passkey with the backup key. The thief's Withdraw still applies after the delay,
    /// because queued changes don't record which key signed them.
    function test_F5_actionsQueuedByARemovedPasskeyMustNotApply() public {
        uint256 backupPk = 0xB4C;
        (uint256 bx, uint256 by) = vm.publicKeyP256(backupPk);
        sign(PolicyVault.Op.AddOwnerKey, abi.encode(bytes32(bx), bytes32(by), sha256(bytes(RP_ID))));
        bytes32 backupId = vault.keyIdOf(bytes32(bx), bytes32(by));
        policy(50e6, 40e6, 1 days, 1 days, 0, 0); // 24h loosening delay

        address thief = makeAddr("thief");
        bytes memory steal = abi.encode(thief, uint256(250e6));
        uint256 stealNonce = signWith(ownerPk, keyId, PolicyVault.Op.Withdraw, steal); // stolen phone
        signWith(backupPk, backupId, PolicyVault.Op.RemoveOwnerKey, abi.encode(keyId)); // owner reacts

        vm.warp(block.timestamp + 1 days + 1);
        vault.finalize(PolicyVault.Op.RemoveOwnerKey, abi.encode(keyId), stealNonce + 1);
        (,,, bool stillActive) = vault.ownerKeys(keyId);
        assertFalse(stillActive);
        try vault.finalize(PolicyVault.Op.Withdraw, steal, stealNonce) {} catch {}
        assertEq(token.balanceOf(thief), 0, "a withdrawal signed by a since-removed passkey still paid out");
    }

    /// F6. The owner queues a looser ceiling, then (worried) raises the protected amount, which applies at
    /// once. SetPolicy carries all six fields, so the older queued change later resets protection.
    function test_F6_staleQueuedPolicyMustNotUndoALaterTightening() public {
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        bytes memory looser = abi.encode(uint256(50e6), uint256(100e6), uint64(1 days), uint64(120), uint256(0), uint64(0));
        sign(PolicyVault.Op.SetPolicy, looser); // queued
        uint256 looserNonce = nonce;
        policy(200e6, 40e6, 1 days, 120, 0, 0); // tighter: applies now
        assertEq(vault.protectedAmount(), 200e6);
        vm.warp(block.timestamp + 121);
        try vault.finalize(PolicyVault.Op.SetPolicy, looser, looserNonce) {} catch {}
        assertEq(vault.protectedAmount(), 200e6, "an older queued change silently lowered the protected amount");
    }

    /// F5b. Same lost phone, realistic order: the thief's Withdraw was queued first, so it is ready before
    /// the owner's removal of that key. Signing the removal has to stop the key's queued changes at once,
    /// not only when the removal itself applies.
    function test_F5b_signingAPasskeyRemovalStopsItsQueuedChangesAtOnce() public {
        uint256 backupPk = 0xB4C;
        (uint256 bx, uint256 by) = vm.publicKeyP256(backupPk);
        sign(PolicyVault.Op.AddOwnerKey, abi.encode(bytes32(bx), bytes32(by), sha256(bytes(RP_ID))));
        bytes32 backupId = vault.keyIdOf(bytes32(bx), bytes32(by));
        policy(50e6, 40e6, 1 days, 1 days, 0, 0);

        address thief = makeAddr("thief");
        bytes memory steal = abi.encode(thief, uint256(250e6));
        uint256 stealNonce = signWith(ownerPk, keyId, PolicyVault.Op.Withdraw, steal);
        vm.warp(block.timestamp + 1 hours); // the owner notices an hour later
        signWith(backupPk, backupId, PolicyVault.Op.RemoveOwnerKey, abi.encode(keyId));

        vm.warp(block.timestamp + 23 hours + 1); // the thief's change is ready; the removal isn't yet
        vm.prank(thief);
        try vault.finalize(PolicyVault.Op.Withdraw, steal, stealNonce) {} catch {}
        assertEq(token.balanceOf(thief), 0, "the stolen passkey's withdrawal applied after the owner signed its removal");
    }

    /// F6b. The owner queues a bigger allowance for Claude, then cuts Claude's limits (applies at once).
    /// The older queued grant later restores the bigger allowance.
    function test_F6b_staleQueuedGrantMustNotUndoALaterCut() public {
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        bytes memory bigger = abi.encode(claude, uint128(10e6), uint128(25e6), uint64(block.timestamp + 30 days));
        sign(PolicyVault.Op.SetAgent, bigger); // looser: queued
        uint256 biggerNonce = nonce;
        sign(PolicyVault.Op.SetAgent, abi.encode(claude, uint128(2e6), uint128(5e6), uint64(block.timestamp + 30 days)));
        vm.warp(block.timestamp + 121);
        try vault.finalize(PolicyVault.Op.SetAgent, bigger, biggerNonce) {} catch {}
        (uint128 perPayment, uint128 dailyCap,,,,,) = vault.agents(claude);
        assertEq(perPayment, 2e6, "an older queued grant undid the owner's later cut");
        assertEq(dailyCap, 5e6, "an older queued grant undid the owner's later cut");
    }

    // ------------------------------------------------------------ who can void owner changes

    /// F9. Only revocations by the owner, the guardian or a registered agent's own key may void the
    /// owner's queued changes. An address that was never an agent must not be able to, or anyone could
    /// keep a frozen vault frozen by voiding every unfreeze the owner signs.
    function test_F9_aStrangerCannotVoidTheOwnersQueuedUnfreeze() public {
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        vm.prank(guardian);
        vault.freeze();
        sign(PolicyVault.Op.Unfreeze, abi.encode(address(0))); // queued
        uint256 unfreezeNonce = nonce;
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        try vault.freezeAgent(stranger) {} catch {} // v2 allowed it; v3 refuses non-agents
        vm.warp(block.timestamp + 121);
        try vault.finalize(PolicyVault.Op.Unfreeze, abi.encode(address(0)), unfreezeNonce) {} catch {}
        assertFalse(vault.frozen(), "a stranger kept the vault frozen by voiding the owner's unfreeze");
    }

    // ------------------------------------------------------------ contact aliases (review C5)

    /// C5. v3 keeps one contact per address, so a second, cooling alias can't sit next to a mature one.
    function test_C5_secondContactForSameAddressIsRefused() public {
        PolicyVault.Action memory a = action(PolicyVault.Op.AddContact, abi.encode(keccak256("alias"), shop, false, uint128(0)));
        WebAuthn.WebAuthnAuth memory auth = assertion(ownerPk, vault.digest(a), RP_ID, 0x05);
        vm.expectRevert(PolicyVault.BadAction.selector);
        vault.execute(a, keyId, auth);
    }

    /// C5. An owner payment to an address whose only contact is still waiting queues; it doesn't pay at once.
    function test_C5_ownerPayToCoolingContactQueues() public {
        address fresh = makeAddr("fresh-payee");
        sign(PolicyVault.Op.AddContact, abi.encode(keccak256("fresh"), fresh, false, uint128(0)));
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        sign(PolicyVault.Op.Pay, abi.encode(fresh, uint256(3e6), bytes32("fresh-pay")));
        assertEq(token.balanceOf(fresh), 0, "owner payment to a cooling contact must queue");
    }

    /// C5. Removing a mature contact and adding the same address again restarts the wait.
    function test_C5_removeThenReAddRestartsTheWait() public {
        sign(PolicyVault.Op.RemoveContact, abi.encode(shopId));
        sign(PolicyVault.Op.AddContact, abi.encode(keccak256("again"), shop, false, uint128(0)));
        policy(50e6, 40e6, 1 days, 120, 0, 0);
        sign(PolicyVault.Op.Pay, abi.encode(shop, uint256(3e6), bytes32("again-pay")));
        assertEq(token.balanceOf(shop), 0, "re-added contact must wait again");
        assertFalse(pay(claude, 1e6, bytes32("agent-again")), "agent can't pay a contact still waiting");
    }

    // ------------------------------------------------------------ griefing (new)

    /// F7. Owner and agent payment ids share one namespace. An agent that learns the id of a payment
    /// waiting for the owner's passkey (the approval link it is handed exposes the signed bytes) can
    /// spend it first on a tiny in-limit payment, and the owner's approved payment then reverts.
    function test_F7_agentMustNotBeAbleToBurnAnOwnerPaymentId() public {
        bytes32 approvalId = keccak256("task:needs-owner");
        pay(claude, 1, approvalId); // one micro-unit, in limits
        // The owner now signs the $12 the agent asked for.
        PolicyVault.Action memory a = action(PolicyVault.Op.Pay, abi.encode(shop, uint256(12e6), approvalId));
        try vault.execute(a, keyId, assertion(ownerPk, vault.digest(a), RP_ID, 0x05)) {} catch {}
        assertEq(token.balanceOf(shop), 12e6 + 1, "the owner's approved payment was blocked by the agent");
    }

    // ------------------------------------------------------------ window semantics (new)

    /// F8. The rolling ceiling counts a held payment when it is requested, but the money leaves when it is
    /// released. Holds at the end of one window plus instant payments at the start of the next move twice
    /// the ceiling within 24 hours.
    function test_F8_outflowInAny24HoursMustStayUnderTheCeiling() public {
        holds(); // payments above $5 are held for 2 minutes
        uint256 t0 = block.timestamp;
        pay(chatgpt, 10e6, bytes32("h1"));
        pay(chatgpt, 10e6, bytes32("h2"));
        pay(chatgpt, 10e6, bytes32("h3"));
        pay(claude, 10e6, bytes32("h4"));
        vm.warp(t0 + 121);
        uint256 firstRelease = block.timestamp;
        vault.release(bytes32("h1"));
        vault.release(bytes32("h2"));
        vault.release(bytes32("h3"));
        vault.release(bytes32("h4"));
        vm.warp(t0 + 24 hours + 1); // window rolled for the requests, not for the releases
        for (uint256 i; i < 5; ++i) pay(chatgpt, 5e6, keccak256(abi.encode("c", i)));
        for (uint256 i; i < 3; ++i) pay(claude, 5e6, keccak256(abi.encode("d", i)));
        assertLt(block.timestamp - firstRelease, 24 hours);
        assertLe(token.balanceOf(shop), 40e6, "agents moved more than the daily ceiling within 24 hours");
    }
}
