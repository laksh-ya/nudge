// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {TestUSD} from "../src/TestUSD.sol";

/// @dev Builds WebAuthn assertions exactly as a browser does, signed with a real P-256 key.
abstract contract Passkey is Test {
    uint256 internal constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    string internal constant RP_ID = "agent-wallet-approve.vercel.app";

    function assertion(uint256 pk, bytes32 challenge, string memory rpId, bytes1 flags)
        internal
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        bytes memory authenticatorData = abi.encodePacked(sha256(bytes(rpId)), flags, uint32(1));
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"https://',
            rpId,
            '","crossOrigin":false}'
        );
        bytes32 h = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, h);
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s));
        auth = WebAuthn.WebAuthnAuth({
            r: r,
            s: s,
            challengeIndex: 23,
            typeIndex: 1,
            authenticatorData: authenticatorData,
            clientDataJSON: clientDataJSON
        });
    }
}

contract PolicyVaultTest is Passkey {
    TestUSD token;
    VaultFactory factory;
    PolicyVault vault;

    uint256 ownerPk = 0xA11CE;
    bytes32 qx;
    bytes32 qy;
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
        qx = bytes32(x);
        qy = bytes32(y);
        vault = factory.createVault(token, qx, qy, sha256(bytes(RP_ID)), 50e6, 40e6, 1 days, bytes32(0));
        keyId = vault.keyIdOf(qx, qy);
        token.faucet(address(vault), 250e6);

        sign(
            PolicyVault.Op.SetAgent, abi.encode(claude, uint128(10e6), uint128(15e6), uint64(block.timestamp + 30 days))
        );
        sign(
            PolicyVault.Op.SetAgent,
            abi.encode(chatgpt, uint128(10e6), uint128(30e6), uint64(block.timestamp + 30 days))
        );
        sign(PolicyVault.Op.AddContact, abi.encode(shopId, shop, true));
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

    // -------------------------------------------------------------- passkey

    function test_predictedAddressMatches() public view {
        address predicted = factory.predict(token, qx, qy, sha256(bytes(RP_ID)), 50e6, 40e6, 1 days, bytes32(0));
        assertEq(predicted, address(vault));
    }

    function test_ownerPaysWithPasskey() public {
        sign(PolicyVault.Op.Pay, abi.encode(shop, 120e6, bytes32("invoice-1")));
        assertEq(token.balanceOf(shop), 120e6);
        assertTrue(vault.paymentUsed(bytes32("invoice-1")));
    }

    function test_tamperedActionIsRejected() public {
        PolicyVault.Action memory a = action(PolicyVault.Op.Pay, abi.encode(shop, 1e6, bytes32("p")));
        WebAuthn.WebAuthnAuth memory auth = assertion(ownerPk, vault.digest(a), RP_ID, 0x05);
        a.data = abi.encode(makeAddr("attacker"), 1e6, bytes32("p"));
        vm.expectRevert(PolicyVault.BadSignature.selector);
        vault.execute(a, keyId, auth);
    }

    function test_otherKeyIsRejected() public {
        PolicyVault.Action memory a = action(PolicyVault.Op.Pay, abi.encode(shop, 1e6, bytes32("p")));
        WebAuthn.WebAuthnAuth memory auth = assertion(0xB0B, vault.digest(a), RP_ID, 0x05);
        vm.expectRevert(PolicyVault.BadSignature.selector);
        vault.execute(a, keyId, auth);
    }

    function test_replayIsRejected() public {
        PolicyVault.Action memory a = action(PolicyVault.Op.Pay, abi.encode(shop, 1e6, bytes32("p")));
        WebAuthn.WebAuthnAuth memory auth = assertion(ownerPk, vault.digest(a), RP_ID, 0x05);
        vault.execute(a, keyId, auth);
        vm.expectRevert(PolicyVault.NonceUsed.selector);
        vault.execute(a, keyId, auth);
    }

    function test_passkeyFromAnotherSiteIsRejected() public {
        PolicyVault.Action memory a = action(PolicyVault.Op.Pay, abi.encode(shop, 1e6, bytes32("p")));
        WebAuthn.WebAuthnAuth memory auth = assertion(ownerPk, vault.digest(a), "evil.example", 0x05);
        vm.expectRevert(PolicyVault.WrongSite.selector);
        vault.execute(a, keyId, auth);
    }

    function test_userVerificationIsRequired() public {
        PolicyVault.Action memory a = action(PolicyVault.Op.Pay, abi.encode(shop, 1e6, bytes32("p")));
        WebAuthn.WebAuthnAuth memory auth = assertion(ownerPk, vault.digest(a), RP_ID, 0x01);
        vm.expectRevert(PolicyVault.BadSignature.selector);
        vault.execute(a, keyId, auth);
    }

    function test_expiredApprovalIsRejected() public {
        PolicyVault.Action memory a = action(PolicyVault.Op.Pay, abi.encode(shop, 1e6, bytes32("p")));
        WebAuthn.WebAuthnAuth memory auth = assertion(ownerPk, vault.digest(a), RP_ID, 0x05);
        vm.warp(block.timestamp + 11 minutes);
        vm.expectRevert(PolicyVault.Expired.selector);
        vault.execute(a, keyId, auth);
    }

    function test_approvalForOneVaultFailsOnAnother() public {
        PolicyVault other = factory.createVault(token, qx, qy, sha256(bytes(RP_ID)), 0, 40e6, 0, bytes32(uint256(1)));
        PolicyVault.Action memory a = action(PolicyVault.Op.Pay, abi.encode(shop, 1e6, bytes32("p")));
        WebAuthn.WebAuthnAuth memory auth = assertion(ownerPk, vault.digest(a), RP_ID, 0x05);
        vm.expectRevert(PolicyVault.BadSignature.selector);
        other.execute(a, keyId, auth);
    }

    function test_batchSetsUpInOneApproval() public {
        address gemini = makeAddr("gemini");
        bytes32 cafeId = keccak256("contact:cafe");
        uint8[] memory ops = new uint8[](2);
        bytes[] memory datas = new bytes[](2);
        ops[0] = uint8(PolicyVault.Op.SetAgent);
        datas[0] = abi.encode(gemini, uint128(2e6), uint128(4e6), uint64(block.timestamp + 1 days));
        ops[1] = uint8(PolicyVault.Op.AddContact);
        datas[1] = abi.encode(cafeId, makeAddr("cafe"), true);
        sign(PolicyVault.Op.Batch, abi.encode(ops, datas));
        vm.prank(gemini);
        assertTrue(vault.agentPay(cafeId, 2e6, "b1", 0));
    }

    function test_batchCannotNest() public {
        uint8[] memory ops = new uint8[](1);
        bytes[] memory datas = new bytes[](1);
        ops[0] = uint8(PolicyVault.Op.Batch);
        datas[0] = "";
        PolicyVault.Action memory a = action(PolicyVault.Op.Batch, abi.encode(ops, datas));
        WebAuthn.WebAuthnAuth memory auth = assertion(ownerPk, vault.digest(a), RP_ID, 0x05);
        vm.expectRevert(PolicyVault.BadAction.selector);
        vault.execute(a, keyId, auth);
    }

    function test_cannotRemoveLastKey() public {
        PolicyVault.Action memory a = action(PolicyVault.Op.RemoveOwnerKey, abi.encode(keyId));
        WebAuthn.WebAuthnAuth memory auth = assertion(ownerPk, vault.digest(a), RP_ID, 0x05);
        vm.expectRevert(PolicyVault.LastKey.selector);
        vault.execute(a, keyId, auth);
    }

    // --------------------------------------------------------------- agents

    function test_agentPaysWithinLimits() public {
        assertTrue(pay(claude, 8e6, "a1"));
        assertEq(token.balanceOf(shop), 8e6);
        assertEq(vault.spentToday(claude), 8e6);
    }

    function test_unknownAgentReverts() public {
        vm.expectRevert(PolicyVault.NotAgent.selector);
        pay(makeAddr("stranger"), 1e6, "x");
    }

    function test_overPerPaymentIsRefusedOnChain() public {
        vm.expectEmit(true, true, true, true);
        emit PolicyVault.PaymentRefused("big", claude, shopId, 18e6, 2003);
        assertFalse(pay(claude, 18e6, "big"));
        assertEq(token.balanceOf(shop), 0);
    }

    function test_agentDailyCap() public {
        assertTrue(pay(claude, 10e6, "a1"));
        assertFalse(pay(claude, 6e6, "a2")); // 16 > 15
        assertTrue(pay(claude, 5e6, "a3"));
    }

    function test_sharedCeilingAcrossAgents() public {
        assertTrue(pay(claude, 10e6, "c1"));
        assertTrue(pay(chatgpt, 10e6, "g1"));
        assertTrue(pay(chatgpt, 10e6, "g2"));
        assertTrue(pay(claude, 5e6, "c2")); // 35 of the 40 shared ceiling
        // ChatGPT is still inside its own 30 cap (20 + 6), but the vault-wide ceiling is not.
        vm.expectEmit(true, true, true, true);
        emit PolicyVault.PaymentRefused("g3", chatgpt, shopId, 6e6, 2004);
        assertFalse(pay(chatgpt, 6e6, "g3"));
        assertEq(vault.agentHeadroom(), 5e6);
    }

    function test_protectedAmountIsUntouchable() public {
        sign(PolicyVault.Op.Withdraw, abi.encode(address(this), 195e6)); // leaves 55, protected 50
        assertTrue(pay(claude, 5e6, "p1"));
        assertFalse(pay(chatgpt, 1e6, "p2"));
        assertEq(token.balanceOf(address(vault)), 50e6);
    }

    function test_duplicatePaymentIdIsRefused() public {
        assertTrue(pay(claude, 1e6, "inv-7"));
        assertFalse(pay(chatgpt, 1e6, "inv-7"));
    }

    function test_newContactWaits() public {
        address fresh = makeAddr("fresh");
        bytes32 freshId = keccak256("contact:fresh");
        sign(PolicyVault.Op.AddContact, abi.encode(freshId, fresh, false));
        vm.prank(claude);
        assertFalse(vault.agentPay(freshId, 1e6, "n1", 0));
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(claude);
        assertTrue(vault.agentPay(freshId, 1e6, "n2", 0));
    }

    function test_unknownContactIsRefused() public {
        vm.prank(claude);
        assertFalse(vault.agentPay(keccak256("nobody"), 1e6, "u1", 0));
    }

    function test_windowRollsAfter24Hours() public {
        assertTrue(pay(claude, 10e6, "w1"));
        vm.warp(block.timestamp + 23 hours);
        assertFalse(pay(claude, 10e6, "w2"));
        vm.warp(block.timestamp + 1 hours + 1);
        assertTrue(pay(claude, 10e6, "w3"));
    }

    function test_noMidnightDoubleSpend() public {
        // A calendar-day cap would reset at 00:00. A rolling window doesn't.
        vm.warp(1_790_121_600 - 60); // one minute before UTC midnight
        assertTrue(pay(claude, 10e6, "m1"));
        vm.warp(1_790_121_600 + 60);
        assertFalse(pay(claude, 10e6, "m2")); // 20 > 15 within 24 hours
        assertTrue(pay(claude, 5e6, "m3"));
    }

    function test_paymentCountLimit() public {
        sign(
            PolicyVault.Op.SetAgent,
            abi.encode(claude, uint128(1e6), uint128(1_000e6), uint64(block.timestamp + 30 days))
        );
        policy(0, 1_000e6, 0, 0, 0, 0);
        for (uint256 i; i < 16; ++i) {
            assertTrue(pay(claude, 1, bytes32(i + 1)));
        }
        assertFalse(pay(claude, 1, bytes32(uint256(99))));
    }

    function test_expiredAgentIsRefused() public {
        vm.warp(block.timestamp + 31 days);
        assertFalse(pay(claude, 1e6, "e1"));
    }

    // ------------------------------------------------------------- freezing

    function test_guardianFreezesButCannotUnfreeze() public {
        vm.prank(guardian);
        vault.freezeAgent(claude);
        vm.expectRevert(PolicyVault.AgentFrozen.selector);
        pay(claude, 1e6, "f1");
        sign(PolicyVault.Op.Unfreeze, abi.encode(claude));
        assertTrue(pay(claude, 1e6, "f2"));
    }

    function test_vaultFreezeStopsEveryAgent() public {
        vm.prank(guardian);
        vault.freeze();
        vm.expectRevert(PolicyVault.AgentFrozen.selector);
        pay(chatgpt, 1e6, "f3");
        assertEq(vault.agentHeadroom(), 0);
    }

    function test_onlyGuardianFreezesVault() public {
        vm.prank(claude);
        vm.expectRevert(PolicyVault.NotGuardian.selector);
        vault.freeze();
    }

    function test_agentCanFreezeItselfOnly() public {
        vm.prank(claude);
        vault.freezeAgent(claude);
        vm.prank(claude);
        vm.expectRevert(PolicyVault.NotGuardian.selector);
        vault.freezeAgent(chatgpt);
    }

    // ----------------------------------------------------------------- fuzz

    /// A stolen agent key can move at most its daily cap in any 24 hours, whatever it tries.
    function testFuzz_stolenKeyIsBounded(uint256[12] memory amounts, uint256[12] memory gaps) public {
        uint256 moved;
        uint256 start = block.timestamp;
        for (uint256 i; i < 12; ++i) {
            vm.warp(block.timestamp + bound(gaps[i], 0, 3 hours));
            uint256 before = token.balanceOf(shop);
            vm.prank(claude);
            // Five refusals freeze the key; after that every call reverts, which only helps the owner.
            try vault.agentPay(shopId, bound(amounts[i], 1, 20e6), bytes32(i + 1), 0) {} catch {}
            moved += token.balanceOf(shop) - before;
            if (block.timestamp - start < 24 hours) assertLe(moved, 15e6);
        }
    }

    // ------------------------------------------------------ protected amount

    function test_ownerPaymentLeavesProtectedAmount() public {
        PolicyVault.Action memory a = action(PolicyVault.Op.Pay, abi.encode(shop, 201e6, bytes32("big")));
        WebAuthn.WebAuthnAuth memory auth = assertion(ownerPk, vault.digest(a), RP_ID, 0x05);
        vm.expectRevert(PolicyVault.BreachesProtected.selector);
        vault.execute(a, keyId, auth);
        sign(PolicyVault.Op.Pay, abi.encode(shop, 200e6, bytes32("ok")));
        assertEq(token.balanceOf(address(vault)), 50e6);
    }

    function test_onlyWithdrawGoesBelowProtected() public {
        sign(PolicyVault.Op.Withdraw, abi.encode(address(this), 250e6));
        assertEq(token.balanceOf(address(vault)), 0);
    }

    // -------------------------------------------------------------- strikes

    function test_fiveRefusalsFreezeTheAgent() public {
        for (uint256 i; i < 4; ++i) {
            assertFalse(pay(claude, 11e6, bytes32(i + 100)));
        }
        (,,,, bool frozenBefore,,) = vault.agents(claude);
        assertFalse(frozenBefore);
        assertFalse(pay(claude, 11e6, "s5"));
        (,,,, bool frozenAfter, uint8 strikes,) = vault.agents(claude);
        assertTrue(frozenAfter);
        assertEq(strikes, 5);
        vm.expectRevert(PolicyVault.AgentFrozen.selector);
        pay(claude, 1e6, "s6");
        assertTrue(pay(chatgpt, 1e6, "other")); // only that agent stops
        sign(PolicyVault.Op.Unfreeze, abi.encode(claude));
        (,,,,, uint8 reset,) = vault.agents(claude);
        assertEq(reset, 0);
        assertTrue(pay(claude, 1e6, "s7"));
    }

    function test_strikesFadeAfterAQuietDay() public {
        for (uint256 i; i < 4; ++i) {
            pay(claude, 11e6, bytes32(i + 200));
        }
        vm.warp(block.timestamp + 25 hours);
        pay(claude, 11e6, "late");
        (,,,, bool frozen_, uint8 strikes,) = vault.agents(claude);
        assertFalse(frozen_);
        assertEq(strikes, 1);
    }

    function test_changingLimitsDoesNotUnfreeze() public {
        vm.prank(guardian);
        vault.freezeAgent(claude);
        sign(PolicyVault.Op.SetAgent, abi.encode(claude, uint128(5e6), uint128(5e6), uint64(block.timestamp + 1 days)));
        vm.expectRevert(PolicyVault.AgentFrozen.selector);
        pay(claude, 1e6, "x");
    }

    // ------------------------------------------------- delayed loosening

    function test_looseningWaitsAndTighteningIsInstant() public {
        policy(50e6, 40e6, 1 days, 1 hours, 0, 0); // a longer delay is tightening: instant
        assertEq(vault.changeDelay(), 1 hours);

        sign(
            PolicyVault.Op.SetAgent, abi.encode(claude, uint128(20e6), uint128(30e6), uint64(block.timestamp + 30 days))
        );
        (uint128 per,,,,,,) = vault.agents(claude);
        assertEq(per, 10e6, "raise is queued, not applied");

        bytes memory data = abi.encode(claude, uint128(20e6), uint128(30e6), uint64(block.timestamp + 30 days));
        vm.expectRevert(PolicyVault.NotReady.selector);
        vault.finalize(PolicyVault.Op.SetAgent, data, nonce);
        vm.warp(block.timestamp + 1 hours);
        vault.finalize(PolicyVault.Op.SetAgent, data, nonce);
        (per,,,,,,) = vault.agents(claude);
        assertEq(per, 20e6);

        sign(PolicyVault.Op.SetAgent, abi.encode(claude, uint128(1e6), uint128(2e6), uint64(block.timestamp + 1 days)));
        (per,,,,,,) = vault.agents(claude);
        assertEq(per, 1e6, "lowering applies at once");
    }

    function test_guardianCancelsAQueuedLoosening() public {
        policy(50e6, 40e6, 1 days, 1 hours, 0, 0);
        policy(0, 40e6, 1 days, 1 hours, 0, 0); // lower the protected amount: queued
        bytes memory data =
            abi.encode(uint256(0), uint256(40e6), uint64(1 days), uint64(1 hours), uint256(0), uint64(0));
        bytes32 id = vault.changeIdOf(PolicyVault.Op.SetPolicy, data, nonce);
        vm.prank(claude);
        vm.expectRevert(PolicyVault.NotGuardian.selector);
        vault.cancelChange(id);
        vm.prank(guardian);
        vault.cancelChange(id);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(PolicyVault.NotQueued.selector);
        vault.finalize(PolicyVault.Op.SetPolicy, data, nonce);
        assertEq(vault.protectedAmount(), 50e6);
    }

    function test_frozenVaultOnlyLetsUnfreezeApply() public {
        policy(50e6, 40e6, 1 days, 1 hours, 0, 0);
        sign(PolicyVault.Op.Withdraw, abi.encode(address(this), 10e6));
        uint256 withdrawNonce = nonce;
        vm.prank(guardian);
        vault.freeze();
        sign(PolicyVault.Op.Unfreeze, abi.encode(address(0)));
        uint256 unfreezeNonce = nonce;
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(PolicyVault.AgentFrozen.selector);
        vault.finalize(PolicyVault.Op.Withdraw, abi.encode(address(this), 10e6), withdrawNonce);
        vault.finalize(PolicyVault.Op.Unfreeze, abi.encode(address(0)), unfreezeNonce);
        assertFalse(vault.frozen());
    }

    function test_ownerCancelsAQueuedChangeWithPasskey() public {
        policy(50e6, 40e6, 1 days, 1 hours, 0, 0);
        bytes memory data = abi.encode(address(this), 10e6);
        sign(PolicyVault.Op.Withdraw, data);
        bytes32 id = vault.changeIdOf(PolicyVault.Op.Withdraw, data, nonce);
        sign(PolicyVault.Op.CancelChange, abi.encode(id)); // tightening: instant
        assertEq(vault.queued(id), 0);
    }

    function test_setupBatchIsInstantBeforeADelayExists() public {
        bytes[] memory datas = new bytes[](2);
        uint8[] memory raw = new uint8[](2);
        address gemini = makeAddr("gemini");
        raw[0] = uint8(PolicyVault.Op.SetAgent);
        datas[0] = abi.encode(gemini, uint128(2e6), uint128(4e6), uint64(block.timestamp + 1 days));
        raw[1] = uint8(PolicyVault.Op.SetPolicy);
        datas[1] =
            abi.encode(uint256(50e6), uint256(40e6), uint64(1 days), uint64(1 hours), uint256(5e6), uint64(10 minutes));
        sign(PolicyVault.Op.Batch, abi.encode(raw, datas));
        (,,, bool active,,,) = vault.agents(gemini);
        assertTrue(active);
        assertEq(vault.changeDelay(), 1 hours);
        assertEq(vault.holdFor(), 10 minutes);
    }

    // ---------------------------------------------------------------- holds

    function test_largeAgentPaymentWaitsThenReleases() public {
        policy(50e6, 40e6, 1 days, 0, 5e6, 1 hours);
        assertTrue(pay(claude, 8e6, "h1"));
        assertEq(token.balanceOf(shop), 0, "held, not sent");
        assertEq(vault.heldTotal(), 8e6);
        assertTrue(pay(claude, 4e6, "small")); // at or under the threshold goes now
        assertEq(token.balanceOf(shop), 4e6);
        vm.expectRevert(PolicyVault.NotReady.selector);
        vault.release("h1");
        vm.warp(block.timestamp + 1 hours);
        vault.release("h1");
        assertEq(token.balanceOf(shop), 12e6);
        assertEq(vault.heldTotal(), 0);
    }

    function test_ownerCancelsAHeldPayment() public {
        policy(50e6, 40e6, 1 days, 0, 5e6, 1 hours);
        pay(claude, 8e6, "h2");
        vm.prank(claude);
        vm.expectRevert(PolicyVault.NotGuardian.selector);
        vault.cancelHeld("h2");
        vm.prank(guardian);
        vault.cancelHeld("h2");
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(PolicyVault.NotQueued.selector);
        vault.release("h2");
        assertEq(token.balanceOf(shop), 0);
        assertEq(vault.spentToday(claude), 8e6, "cancelled spend still counts");
    }

    function test_freezeOrRemovedContactBlocksRelease() public {
        policy(50e6, 40e6, 1 days, 0, 5e6, 1 hours);
        pay(claude, 8e6, "h3");
        pay(chatgpt, 9e6, "h4");
        vm.prank(guardian);
        vault.freezeAgent(claude);
        sign(PolicyVault.Op.RemoveContact, abi.encode(shopId));
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(PolicyVault.AgentFrozen.selector);
        vault.release("h3");
        vm.expectRevert(PolicyVault.BadAction.selector);
        vault.release("h4");
    }

    function test_heldMoneyCountsAgainstProtected() public {
        policy(50e6, 1_000e6, 1 days, 0, 5e6, 1 hours);
        sign(
            PolicyVault.Op.SetAgent,
            abi.encode(chatgpt, uint128(100e6), uint128(500e6), uint64(block.timestamp + 30 days))
        );
        assertTrue(pay(chatgpt, 100e6, "big1"));
        assertTrue(pay(chatgpt, 90e6, "big2"));
        assertEq(vault.agentHeadroom(), 10e6);
        assertFalse(pay(chatgpt, 11e6, "big3")); // would dip into protected once holds settle
        PolicyVault.Action memory a = action(PolicyVault.Op.Pay, abi.encode(shop, 11e6, bytes32("own")));
        WebAuthn.WebAuthnAuth memory auth = assertion(ownerPk, vault.digest(a), RP_ID, 0x05);
        vm.expectRevert(PolicyVault.BreachesProtected.selector);
        vault.execute(a, keyId, auth);
    }
}
