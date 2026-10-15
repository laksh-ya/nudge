// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Baseline 1: the agent's key controls the money outright. Any limits live in a prompt or
/// in a server the attacker has bypassed. Test-only.
contract HotWallet {
    IERC20 public immutable token;
    address public immutable agent;

    constructor(IERC20 token_, address agent_) {
        token = token_;
        agent = agent_;
    }

    function pay(address to, uint256 amount) external {
        require(msg.sender == agent, "not agent");
        require(token.transfer(to, amount), "transfer");
    }
}
