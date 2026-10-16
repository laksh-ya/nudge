// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/console2.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {HotWallet} from "./baselines/HotWallet.sol";
import {CapWallet} from "./baselines/CapWallet.sol";
import {Passkey} from "./PolicyVault.t.sol";

/// @notice The same attacks, run against three wallet designs, with the attacker holding stolen
/// agent keys and going straight to the chain (our server bypassed). Each scenario is modelled on
/// an incident or attack class from the research report. Results go to evals/results/contract-attacks.csv.
///
/// Owner intent in every scenario: agent A may pay up to $10 a payment and $15 a day, agent B $10
/// and $30; all agents together at most $20 a day; keep $50 that agents can never spend. Each wallet
/// starts with $250. A design that can't express a rule simply doesn't have it.
///
/// Every scenario also runs one legitimate $8 payment first, so a design that blocks everything
/// can't look safe.
contract AttacksTest is Passkey {
    TestUSD token;
    HotWallet hot;
    CapWallet cap;
    PolicyVault vault;

    uint256 ownerPk = 0xA11CE;
    bytes32 keyId;
    uint256 nonce;

    address server = makeAddr("server"); // holds CapWallet's owner key and PolicyVault's guardian key
    address agentA = makeAddr("agentA");
    address agentB = makeAddr("agentB");
    address shop = makeAddr("shop"); // a saved merchant
    address attacker = makeAddr("attacker");
    bytes32 shopId = keccak256("contact:shop");

    string constant OUT = "../evals/results/contract-attacks.csv";
    uint256 constant START = 250e6;

    function setUp() public {
        vm.warp(1_790_000_000);
        token = new TestUSD();

        hot = new HotWallet(token, agentA);
        token.faucet(address(hot), START);

        cap = new CapWallet(token, server);
        token.faucet(address(cap), START);
        vm.startPrank(server);
        cap.setAgent(agentA, 10e6, 15e6);
        cap.setAgent(agentB, 10e6, 30e6);
        cap.allow(shop, true);
        vm.stopPrank();

        VaultFactory factory = new VaultFactory(server);
        (uint256 x, uint256 y) = vm.publicKeyP256(ownerPk);
        vault = factory.createVault(token, bytes32(x), bytes32(y), sha256(bytes(RP_ID)), 50e6, 20e6, 1 days, bytes32(0));
        keyId = vault.keyIdOf(bytes32(x), bytes32(y));
        token.faucet(address(vault), START);
        sign(PolicyVault.Op.SetAgent, abi.encode(agentA, uint128(10e6), uint128(15e6), uint64(block.timestamp + 365 days)));
        sign(PolicyVault.Op.SetAgent, abi.encode(agentB, uint128(10e6), uint128(30e6), uint64(block.timestamp + 365 days)));
        sign(PolicyVault.Op.AddContact, abi.encode(shopId, shop, true, uint128(0)));
    }

    // ------------------------------------------------------------- helpers

    function action(PolicyVault.Op op, bytes memory data) internal returns (PolicyVault.Action memory) {
        return PolicyVault.Action({op: op, data: data, nonce: ++nonce, deadline: uint64(block.timestamp + 10 minutes)});
    }

    function sign(PolicyVault.Op op, bytes memory data) internal {
        PolicyVault.Action memory a = action(op, data);
        vault.execute(a, keyId, assertion(ownerPk, vault.digest(a), RP_ID, 0x05));
    }

    function hotPay(address to, uint256 amount) internal {
        if (token.balanceOf(address(hot)) < amount) return;
        vm.prank(agentA);
        hot.pay(to, amount);
    }

    function capPay(address agent, address to, uint256 amount) internal {
        vm.prank(agent);
        cap.agentPay(to, amount);
    }

    /// Reverts (a frozen or unknown key) count as "nothing moved", which is what happens on-chain.
    function vaultPay(address agent, bytes32 contact, uint256 amount, bytes32 id) internal {
        vm.prank(agent);
        try vault.agentPay(contact, amount, id, 0) {} catch {}
    }

    /// One honest $8 payment through each design before the attack.
    function legit() internal returns (uint256 ok) {
        uint256 before = token.balanceOf(shop);
        hotPay(shop, 8e6);
        if (token.balanceOf(shop) == before + 8e6) ok++;
        before = token.balanceOf(shop);
        capPay(agentA, shop, 8e6);
        if (token.balanceOf(shop) == before + 8e6) ok++;
        before = token.balanceOf(shop);
        vaultPay(agentA, shopId, 8e6, "legit");
        if (token.balanceOf(shop) == before + 8e6) ok++;
        // Start the attack from a clean day so legit spend doesn't hide the attack's reach.
        vm.warp(block.timestamp + 2 days);
    }

    function lost(address w, uint256 startAfterLegit) internal view returns (uint256) {
        return startAfterLegit - token.balanceOf(w);
    }

    function record(string memory scenario, string memory source, int256 h, int256 c, int256 v, uint256 legitOk) internal {
        string memory line = string.concat(
            scenario, ",", source, ",", _usd(h), ",", _usd(c), ",", _usd(v), ",", vm.toString(legitOk), "/3"
        );
        console2.log(line);
        vm.writeLine(OUT, line);
    }

    function _usd(int256 units) internal pure returns (string memory) {
        if (units < 0) return "n/a";
        return vm.toString(uint256(units) / 1e6);
    }

    struct Start {
        uint256 hot;
        uint256 cap;
        uint256 vault;
        uint256 legit;
    }

    function begin() internal returns (Start memory s) {
        s.legit = legit();
        s.hot = token.balanceOf(address(hot));
        s.cap = token.balanceOf(address(cap));
        s.vault = token.balanceOf(address(vault));
    }

    // ------------------------------------------------------------ scenarios

    /// Hidden text on a page or a poisoned skill tells the agent to pay the attacker (Unit 42, Zscaler, OpenClaw).
    function test_attack_payAttackerAddress() public {
        Start memory s = begin();
        bytes32 attackerId = keccak256("contact:attacker");
        for (uint256 i; i < 25; ++i) {
            hotPay(attacker, 10e6);
            capPay(agentA, attacker, 10e6);
            vaultPay(agentA, attackerId, 10e6, bytes32(i + 1));
            vm.warp(block.timestamp + 2 hours);
        }
        uint256 v = token.balanceOf(attacker);
        uint256 h = s.hot - token.balanceOf(address(hot));
        record("Pay the attacker's own address, every 2h for 48h", "Unit 42 / Zscaler / OpenClaw", int256(h), int256(s.cap - token.balanceOf(address(cap))), int256(s.vault - token.balanceOf(address(vault))), s.legit);
        assertEq(s.vault - token.balanceOf(address(vault)), 0);
        v;
    }

    /// The attacker controls a merchant the owner saved, and drains it within the limits for 48 hours.
    function test_attack_compromisedContact48h() public {
        Start memory s = begin();
        // Start an hour before midnight, the best time for a calendar-day design.
        uint256 midnight = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(midnight - 1 hours);
        for (uint256 i; i < 96; ++i) {
            hotPay(shop, 10e6);
            capPay(agentA, shop, 10e6);
            vaultPay(agentA, shopId, 10e6, bytes32(i + 100));
            vm.warp(block.timestamp + 30 minutes);
        }
        uint256 v = s.vault - token.balanceOf(address(vault));
        record("Drain a compromised saved merchant for 48h", "Bankr 14 wallets", int256(s.hot - token.balanceOf(address(hot))), int256(s.cap - token.balanceOf(address(cap))), int256(v), s.legit);
        assertLe(v, 15e6); // the strikes freeze the key after its first day's refusals
    }

    /// Spend the whole cap at 23:58 and again at 00:01.
    function test_attack_midnightDoubleSpend() public {
        Start memory s = begin();
        uint256 midnight = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(midnight - 2 minutes);
        capPay(agentA, shop, 10e6);
        capPay(agentA, shop, 5e6);
        vaultPay(agentA, shopId, 10e6, "m1");
        vaultPay(agentA, shopId, 5e6, "m2");
        vm.warp(midnight + 1 minutes);
        capPay(agentA, shop, 10e6);
        capPay(agentA, shop, 5e6);
        vaultPay(agentA, shopId, 10e6, "m3");
        vaultPay(agentA, shopId, 5e6, "m4");
        uint256 v = s.vault - token.balanceOf(address(vault));
        record("Spend the daily cap twice around midnight", "Calendar-day caps in rival entries", -1, int256(s.cap - token.balanceOf(address(cap))), int256(v), s.legit);
        assertEq(v, 15e6);
    }

    /// The same invoice submitted ten times ($5 each); every copy after the first is a loss.
    function test_attack_duplicateInvoice() public {
        Start memory s = begin();
        for (uint256 i; i < 10; ++i) {
            hotPay(shop, 5e6);
            capPay(agentA, shop, 5e6);
            vaultPay(agentA, shopId, 5e6, "invoice-2026-0042");
        }
        uint256 extraHot = s.hot - token.balanceOf(address(hot)) - 5e6;
        uint256 extraCap = s.cap - token.balanceOf(address(cap)) - 5e6;
        uint256 extraVault = s.vault - token.balanceOf(address(vault)) - 5e6;
        record("Same invoice paid ten times (extra paid)", "Retry storms; duplicate bills", int256(extraHot), int256(extraCap), int256(extraVault), s.legit);
        assertEq(extraVault, 0);
    }

    /// An honest model meant $2.50 and sent the whole balance to a saved contact (Lobstar Wilde).
    function test_attack_unitError() public {
        Start memory s = begin();
        hotPay(shop, token.balanceOf(address(hot)));
        capPay(agentA, shop, token.balanceOf(address(cap)));
        vaultPay(agentA, shopId, token.balanceOf(address(vault)), "oops");
        uint256 v = s.vault - token.balanceOf(address(vault));
        record("Whole balance sent instead of $2.50", "Lobstar Wilde", int256(s.hot - token.balanceOf(address(hot))), int256(s.cap - token.balanceOf(address(cap))), int256(v), s.legit);
        assertEq(v, 0);
    }

    /// Two agents' keys stolen at once; the owner wanted at most $20 a day across all agents.
    function test_attack_twoStolenKeys24h() public {
        Start memory s = begin();
        for (uint256 i; i < 48; ++i) {
            capPay(agentA, shop, 10e6);
            capPay(agentB, shop, 10e6);
            vaultPay(agentA, shopId, 10e6, bytes32(i + 200));
            vaultPay(agentB, shopId, 10e6, bytes32(i + 300));
            vm.warp(block.timestamp + 30 minutes);
            if (i == 47) break;
        }
        uint256 v = s.vault - token.balanceOf(address(vault));
        record("Two stolen agent keys for 24h (owner wants $20/day total)", "Several connected assistants", -1, int256(s.cap - token.balanceOf(address(cap))), int256(v), s.legit);
        assertLe(v, 20e6);
    }

    /// Slow drain within every limit for ten days by two agents to a compromised merchant.
    function test_attack_slowDrainTenDays() public {
        Start memory s = begin();
        for (uint256 d; d < 10; ++d) {
            for (uint256 k; k < 3; ++k) {
                capPay(agentA, shop, 5e6);
                capPay(agentB, shop, 10e6);
                capPay(agentB, shop, 10e6);
                vaultPay(agentA, shopId, 5e6, keccak256(abi.encode("slowA", d, k)));
                vaultPay(agentB, shopId, 5e6, keccak256(abi.encode("slowB", d, k)));
            }
            hotPay(shop, 45e6);
            vm.warp(block.timestamp + 1 days + 1);
        }
        uint256 v = s.vault - token.balanceOf(address(vault));
        record("Slow drain inside the limits for 10 days", "Denial of wallet", int256(s.hot - token.balanceOf(address(hot))), int256(s.cap - token.balanceOf(address(cap))), int256(v), s.legit);
        assertGe(token.balanceOf(address(vault)), 50e6);
    }

    /// The app server is compromised: its keys are used directly (AIXBT, Leash's server-held owner key).
    function test_attack_serverCompromise() public {
        Start memory s = begin();
        // CapWallet: the server's owner key allows the attacker and pays out.
        vm.startPrank(server);
        cap.allow(attacker, true);
        cap.ownerPay(attacker, token.balanceOf(address(cap)));
        vm.stopPrank();
        // PolicyVault: the server holds only the guardian key. It can freeze and cancel, nothing else.
        uint256 before = token.balanceOf(address(vault));
        vm.startPrank(server);
        (bool okPay,) = address(vault).call(abi.encodeWithSignature("agentPay(bytes32,uint256,bytes32,bytes32)", shopId, 10e6, bytes32("srv"), bytes32(0)));
        okPay;
        vault.freeze();
        vm.stopPrank();
        uint256 v = before - token.balanceOf(address(vault));
        record("App server compromised; its keys used directly", "AIXBT; server-held owner keys", -1, int256(s.cap - token.balanceOf(address(cap))), int256(v), s.legit);
        assertEq(v, 0);
    }

    /// The owner approved $20 to the shop; the attacker swaps in $200 to themselves before it runs (Loopjacking).
    function test_attack_approvalSubstitution() public {
        Start memory s = begin();
        // CapWallet: approval is the server pressing a button; whoever controls the server decides what runs.
        vm.prank(server);
        cap.ownerPay(attacker, 200e6);
        // PolicyVault: the passkey signed the exact action; the swapped one fails the signature check.
        PolicyVault.Action memory a = action(PolicyVault.Op.Pay, abi.encode(shop, 20e6, bytes32("approved")));
        WebAuthn.WebAuthnAuth memory auth = assertion(ownerPk, vault.digest(a), RP_ID, 0x05);
        a.data = abi.encode(attacker, 200e6, bytes32("approved"));
        try vault.execute(a, keyId, auth) {} catch {}
        uint256 v = token.balanceOf(attacker);
        record("Approved $20 to the shop, executed as $200 to the attacker", "Loopjacking; Bybit", -1, int256(s.cap - token.balanceOf(address(cap))), int256(s.vault - token.balanceOf(address(vault))), s.legit);
        assertEq(v, 200e6); // only CapWallet's payout reached the attacker
    }
}
