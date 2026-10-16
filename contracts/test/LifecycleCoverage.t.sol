// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console2} from "forge-std/console2.sol";
import {LifecycleInvariant} from "./LifecycleInvariant.t.sol";

/// One long pseudo-random sequence through the lifecycle handler, with the coverage it must reach, so
/// the invariants in LifecycleInvariant are known to run against real payments, releases and changes.
contract LifecycleCoverage is LifecycleInvariant {
    function test_lifecycleSequenceExercisesEveryPath() public {
        uint256 stoppedA;
        uint256 stoppedB;
        uint256 vaultFrozen;
        for (uint256 i; i < 1500; ++i) {
            (,,, bool aa, bool fa,,) = vault.agents(handler.agents(0));
            (,,, bool ab, bool fb,,) = vault.agents(handler.agents(1));
            if (!aa || fa) stoppedA++;
            if (!ab || fb) stoppedB++;
            if (vault.frozen()) vaultFrozen++;
            uint256 s = uint256(keccak256(abi.encode(i, "seed")));
            uint256 k = s % 14;
            if (k < 3) handler.agentPay(s >> 8, s >> 40, (s >> 80) % 6 == 0);
            else if (k == 3) handler.release(s >> 8);
            else if (k == 4) handler.guardianCancel(s >> 8);
            else if (k == 5) handler.guardianFreeze(s >> 8);
            else if (k == 6) handler.ownerPay(s >> 8);
            else if (k == 7) handler.setPolicy(s >> 8, s >> 40);
            else if (k == 8) handler.removeAgent(s >> 8);
            else if (k == 9) handler.readdAgent(s >> 8);
            else if (k == 10) handler.withdraw(s >> 8);
            else if (k == 11) handler.unfreeze(s >> 8);
            else if (k == 12) handler.topUp(s >> 8);
            else { handler.finalize(s >> 8); handler.wait(s >> 40); }
        }
        console2.log("steps with A stopped / B stopped / vault frozen", stoppedA, stoppedB, vaultFrozen);
        console2.log("accepted agent payments", handler.accepted());
        console2.log("owner actions accepted", handler.ownerOk());
        console2.log("queued changes finalized", handler.finalized());
        console2.log("releases that moved money", handler.releasedMoney());
        console2.log("withdrawn", handler.withdrawn());
        console2.log("refused / reverted / reverted because stopped", handler.refused(), handler.reverted(), handler.stoppedTries());
        assertGe(handler.accepted(), 30, "agent payments");
        assertGe(handler.refused(), 10, "refusals");
        assertGe(handler.finalized(), 30, "queued changes applied");
        assertGe(handler.releasedMoney(), 1, "releases");
        assertGe(handler.ownerOk(), 100, "owner actions");
        assertGt(handler.withdrawn(), 0, "withdrawals");
    }
}
