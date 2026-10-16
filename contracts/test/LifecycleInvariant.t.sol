// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {Passkey} from "./PolicyVault.t.sol";

/// The whole lifecycle at random: agent payments (one key stolen), releases, guardian cancels and
/// freezes, and passkey-signed owner actions: payments, policy changes (tightening applies at once,
/// loosening waits), removing and re-adding agents, withdrawals, unfreezes, and finalizing whatever is
/// queued. Ghost variables record any step that broke a rule; the invariants check they never did.
contract LifecycleHandler is Passkey {
    PolicyVault public vault;
    TestUSD public token;
    address public guardian;
    address public shop;
    address public owner = makeAddr("owner-wallet");
    address public attacker = makeAddr("attacker");
    address[3] public agents; // two real agents and the attacker, never registered
    bytes32 public shopId;
    uint256 ownerPk;
    uint256 nonce = 1000;
    uint256 n;

    struct Queued {
        PolicyVault.Op op;
        bytes data;
        uint256 nonce;
    }

    Queued[] queue;
    bytes32[] public ids;
    uint256[] times;
    uint256[] amounts;

    // Ghosts: each counts steps that broke a rule. All must stay zero.
    uint256 public paidWhileStopped; // an agent paid, or a release moved money, while frozen or removed
    uint256 public overPerPayment; // an agent payment accepted above that agent's per-payment limit
    uint256 public unexplainedOutflow; // money left the vault without a matching event
    uint256 public agentDippedProtected; // an agent payment or release left less than the protected amount
    uint256 public maxWindow; // largest sum of accepted agent requests in any 24 hours
    uint256 public highestCeiling; // highest daily ceiling ever in force
    uint256 public withdrawn;
    uint256 public minted;
    // Coverage: how often each kind of step actually did something.
    uint256 public accepted;
    uint256 public ownerOk;
    uint256 public finalized;
    uint256 public releasedMoney;
    uint256 public refused;
    uint256 public reverted;
    uint256 public stoppedTries;

    constructor(PolicyVault v, TestUSD t, address g, address s, bytes32 sid, address a, address b, uint256 pk) {
        (vault, token, guardian, shop, shopId, ownerPk) = (v, t, g, s, sid, pk);
        agents = [a, b, attacker];
        highestCeiling = v.dailyCeiling();
    }

    // ------------------------------------------------------------ helpers

    function _sign(PolicyVault.Op op, bytes memory data) internal returns (bool ok) {
        PolicyVault.Action memory act = PolicyVault.Action({op: op, data: data, nonce: ++nonce, deadline: uint64(block.timestamp + 600)});
        (uint256 x, uint256 y) = vm.publicKeyP256(ownerPk);
        bytes32 keyId = vault.keyIdOf(bytes32(x), bytes32(y));
        try vault.execute(act, keyId, assertion(ownerPk, vault.digest(act), RP_ID, 0x05)) {
            ok = true;
            ownerOk++;
            if (vault.queued(vault.changeIdOf(op, data, nonce)) != 0) queue.push(Queued(op, data, nonce));
        } catch {}
    }

    /// Runs `f`'s effects and checks that every token that left the vault is explained by an event.
    function _outflowExplained(uint256 before, uint256 withdrawnNow) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 explained = withdrawnNow;
        bytes32 executed = keccak256("PaymentExecuted(bytes32,address,bytes32,address,uint256,bytes32)");
        bytes32 released = keccak256("PaymentReleased(bytes32,address,uint256)");
        bytes32 ownerPaid = keccak256("OwnerPaid(bytes32,address,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == executed) {
                (, uint256 amount,) = abi.decode(logs[i].data, (address, uint256, bytes32));
                explained += amount;
            } else if (t0 == released || t0 == ownerPaid) {
                (uint256 amount) = abi.decode(_first32(logs[i].data), (uint256));
                explained += amount;
            }
        }
        uint256 afterBal = token.balanceOf(address(vault));
        uint256 left = before > afterBal ? before - afterBal : 0;
        if (left != explained) unexplainedOutflow++;
    }

    function _first32(bytes memory d) internal pure returns (bytes memory out) {
        out = new bytes(32);
        for (uint256 i; i < 32; ++i) out[i] = d[i];
    }

    function _stopped(address agent) internal view returns (bool) {
        (,,, bool active, bool agentFrozen,,) = vault.agents(agent);
        return vault.frozen() || agentFrozen || !active;
    }

    function _perPayment(address agent) internal view returns (uint128 p) {
        (p,,,,,,) = vault.agents(agent);
    }

    function _isFrozen(address agent) internal view returns (bool f) {
        (,,,, f,,) = vault.agents(agent);
    }

    // ------------------------------------------------------------ agents and anyone

    function agentPay(uint256 who, uint256 amount, bool unsaved) external {
        // Mostly honest traffic, so agents stay usable; one in ten is the stolen key, one in ten aims at an unsaved contact.
        address agent = who % 10 == 0 ? agents[2] : agents[who % 2];
        // Usually switch to the other agent if this one is stopped; still probe stopped agents now and then.
        if (agent != agents[2] && _stopped(agent) && who % 3 != 0) agent = agents[(who + 1) % 2];
        bytes32 contact = unsaved && who % 10 == 1 ? keccak256("nobody") : shopId;
        amount = who % 7 == 0 ? bound(amount, 1, 25e6) : bound(amount, 1, 9e6);
        bool stopped = _stopped(agent);
        uint128 perPayment = _perPayment(agent);
        uint256 before = token.balanceOf(address(vault));
        bytes32 id = bytes32(++n);
        vm.recordLogs();
        vm.prank(agent);
        try vault.agentPay(contact, amount, id, 0) returns (bool ok) {
            if (ok) {
                accepted++;
                if (stopped) paidWhileStopped++;
                if (amount > perPayment) overPerPayment++;
                ids.push(id);
                times.push(block.timestamp);
                amounts.push(amount);
                uint256 sum;
                for (uint256 j = times.length; j > 0 && times[j - 1] + 24 hours > block.timestamp; --j) {
                    sum += amounts[j - 1];
                }
                if (sum > maxWindow) maxWindow = sum;
            } else {
                refused++;
            }
        } catch {
            reverted++;
            if (stopped) stoppedTries++;
        }
        uint256 afterBal = token.balanceOf(address(vault));
        if (afterBal < before && afterBal < vault.protectedAmount()) agentDippedProtected++;
        _outflowExplained(before, 0);
    }

    /// Anyone may release a held payment once its hold is over; tries the most recent few.
    function release(uint256 i) external {
        uint256 len = ids.length;
        for (uint256 k; k < 5 && k < len; ++k) {
            bytes32 id = ids[len - 1 - ((i + k) % len)];
            (address agent,,, uint128 amount,,) = vault.held(id);
            if (amount == 0) continue;
            bool stopped = vault.frozen() || _isFrozen(agent);
            uint256 before = token.balanceOf(address(vault));
            vm.recordLogs();
            try vault.release(id) {} catch {}
            uint256 afterBal = token.balanceOf(address(vault));
            if (afterBal < before) releasedMoney++;
            if (afterBal < before && stopped) paidWhileStopped++;
            if (afterBal < before && afterBal < vault.protectedAmount()) agentDippedProtected++;
            _outflowExplained(before, 0);
        }
    }

    function guardianCancel(uint256 i) external {
        if (ids.length == 0) return;
        uint256 before = token.balanceOf(address(vault));
        vm.recordLogs();
        vm.prank(guardian);
        try vault.cancelHeld(ids[i % ids.length]) {} catch {}
        _outflowExplained(before, 0);
    }

    function guardianFreeze(uint256 who) external {
        if (who % 20 != 0) return;
        vm.prank(guardian);
        if (who % 100 == 0) try vault.freeze() {} catch {}
        else try vault.freezeAgent(agents[who % 2]) {} catch {}
    }

    // ------------------------------------------------------------ the owner's passkey

    function ownerPay(uint256 amount) external {
        amount = bound(amount, 1, 15e6);
        uint256 before = token.balanceOf(address(vault));
        vm.recordLogs();
        _sign(PolicyVault.Op.Pay, abi.encode(shop, amount, bytes32(++n)));
        _outflowExplained(before, 0);
    }

    function setPolicy(uint256 protectedAmount, uint256 ceiling) external {
        protectedAmount = bound(protectedAmount, 40e6, 80e6);
        ceiling = bound(ceiling, 10e6, 40e6);
        _sign(PolicyVault.Op.SetPolicy, abi.encode(protectedAmount, ceiling, uint64(1 days), uint64(1 hours), uint256(5e6), uint64(10 minutes)));
        if (vault.dailyCeiling() > highestCeiling) highestCeiling = vault.dailyCeiling();
    }

    function removeAgent(uint256 who) external {
        if (who % 8 != 0) return;
        _sign(PolicyVault.Op.RemoveAgent, abi.encode(agents[who % 2]));
    }

    function readdAgent(uint256 who) external {
        (,,, bool active,,,) = vault.agents(agents[who % 2]);
        if (active) return;
        _sign(PolicyVault.Op.SetAgent, abi.encode(agents[who % 2], uint128(who % 2 == 0 ? 10e6 : 20e6), uint128(who % 2 == 0 ? 25e6 : 30e6), uint64(block.timestamp + 365 days)));
    }

    function withdraw(uint256 amount) external {
        if (amount % 4 != 0) return; // rare, so agents keep room above the protected amount
        amount = bound(amount, 1, 5e6);
        _sign(PolicyVault.Op.Withdraw, abi.encode(owner, amount));
    }

    function unfreeze(uint256 who) external {
        // Unfreeze whatever is frozen: the vault first, else a frozen agent.
        if (!vault.frozen() && !_isFrozen(agents[0]) && !_isFrozen(agents[1])) return;
        address target = vault.frozen() ? address(0) : _isFrozen(agents[who % 2]) ? agents[who % 2] : agents[(who + 1) % 2];
        _sign(PolicyVault.Op.Unfreeze, abi.encode(target));
    }

    /// Anyone may finalize a queued change once it is ready. Applied or voided entries leave the list.
    function finalize(uint256) external {
        uint256 before = token.balanceOf(address(vault));
        uint256 ownerBefore = token.balanceOf(owner);
        vm.recordLogs();
        for (uint256 k = queue.length; k > 0; --k) {
            Queued memory q = queue[k - 1];
            bool drop = true;
            try vault.finalize(q.op, q.data, q.nonce) {
                finalized++;
            } catch (bytes memory err) {
                drop = bytes4(err) != PolicyVault.NotReady.selector && bytes4(err) != PolicyVault.AgentFrozen.selector;
            }
            if (drop) {
                queue[k - 1] = queue[queue.length - 1];
                queue.pop();
            }
        }
        uint256 out = token.balanceOf(owner) - ownerBefore;
        withdrawn += out;
        _outflowExplained(before, out);
        if (vault.dailyCeiling() > highestCeiling) highestCeiling = vault.dailyCeiling();
    }

    /// Someone sends the vault money (a top-up).
    function topUp(uint256 amount) external {
        amount = bound(amount, 1, 20e6);
        token.faucet(address(vault), amount);
        minted += amount;
    }

    function wait(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 6 hours));
    }

    function count() external view returns (uint256) {
        return ids.length;
    }
}

contract LifecycleInvariant is Passkey {
    PolicyVault vault;
    TestUSD token;
    LifecycleHandler handler;
    uint256 ownerPk = 0xB0B;
    uint256 nonce;
    address guardian = makeAddr("guardian");
    address shop = makeAddr("shop");

    function setUp() public {
        vm.warp(1_790_000_000);
        token = new TestUSD();
        VaultFactory factory = new VaultFactory(guardian);
        (uint256 x, uint256 y) = vm.publicKeyP256(ownerPk);
        vault = factory.createVault(token, bytes32(x), bytes32(y), sha256(bytes(RP_ID)), 50e6, 40e6, 0, 0);
        token.faucet(address(vault), 200e6);
        address a = makeAddr("agent-a");
        address b = makeAddr("agent-b");
        bytes32 shopId = keccak256("shop");
        sign(PolicyVault.Op.SetAgent, abi.encode(a, uint128(10e6), uint128(25e6), uint64(block.timestamp + 365 days)));
        sign(PolicyVault.Op.SetAgent, abi.encode(b, uint128(20e6), uint128(30e6), uint64(block.timestamp + 365 days)));
        sign(PolicyVault.Op.AddContact, abi.encode(shopId, shop, true, uint128(0)));
        // Holds above $5 for 10 minutes; loosening waits an hour; new contacts a day.
        sign(PolicyVault.Op.SetPolicy, abi.encode(uint256(50e6), uint256(40e6), uint64(1 days), uint64(1 hours), uint256(5e6), uint64(10 minutes)));
        handler = new LifecycleHandler(vault, token, guardian, shop, shopId, a, b, ownerPk);
        targetContract(address(handler));
    }

    function sign(PolicyVault.Op op, bytes memory data) internal {
        PolicyVault.Action memory act = PolicyVault.Action({op: op, data: data, nonce: ++nonce, deadline: uint64(block.timestamp + 600)});
        (uint256 x, uint256 y) = vm.publicKeyP256(ownerPk);
        vault.execute(act, vault.keyIdOf(bytes32(x), bytes32(y)), assertion(ownerPk, vault.digest(act), RP_ID, 0x05));
    }

    /// A frozen, removed or never-registered agent moves no money, and nothing held is released while frozen.
    /// forge-config: default.invariant.depth = 128
    function invariant_noAgentMoneyWhileFrozenOrRemoved() public view {
        assertEq(handler.paidWhileStopped(), 0);
    }

    /// No agent payment is accepted above that agent's per-payment limit at the time.
    /// forge-config: default.invariant.depth = 128
    function invariant_agentPaymentsWithinPerPayment() public view {
        assertEq(handler.overPerPayment(), 0);
    }

    /// Every token that leaves the vault is accounted for by a PaymentExecuted, PaymentReleased or
    /// OwnerPaid event, or an owner withdrawal.
    /// forge-config: default.invariant.depth = 128
    function invariant_everyOutflowHasAnEvent() public view {
        assertEq(handler.unexplainedOutflow(), 0);
    }

    /// No agent payment or release leaves the vault below the protected amount in force.
    /// forge-config: default.invariant.depth = 128
    function invariant_agentsNeverBreachProtected() public view {
        assertEq(handler.agentDippedProtected(), 0);
    }

    /// Money only goes to the saved shop or, by the owner's withdrawal, to the owner; never the attacker.
    /// forge-config: default.invariant.depth = 128
    function invariant_moneyOnlyToSavedContactOrOwner() public view {
        assertEq(token.balanceOf(handler.attacker()), 0);
        assertEq(token.balanceOf(address(vault)) + token.balanceOf(shop) + token.balanceOf(handler.owner()), 200e6 + handler.minted());
        assertEq(token.balanceOf(handler.owner()), handler.withdrawn());
    }

    /// Accepted agent requests in any 24 hours stay under the highest ceiling ever in force, through
    /// policy changes, removals and re-adds.
    /// forge-config: default.invariant.depth = 128
    function invariant_ceilingAcrossPolicyChanges() public view {
        assertLe(handler.maxWindow(), handler.highestCeiling());
    }

    /// Fails the run if the random steps never reached the paths these invariants are about.
    function afterInvariant() public view {
        assertGt(handler.accepted() + handler.ownerOk() + handler.finalized(), 0, "nothing happened");
    }

    /// heldTotal never exceeds the vault's balance.
    /// forge-config: default.invariant.depth = 128
    function invariant_heldIsBacked() public view {
        assertLe(vault.heldTotal(), token.balanceOf(address(vault)));
    }
}
