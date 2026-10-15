// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Baseline 2: the common hackathon design. Per-agent per-payment and calendar-day caps,
/// a payee allowlist and a pause, all set by an owner key the app server holds. No shared ceiling,
/// no protected amount, no payment ids, no signed owner approvals. Test-only.
contract CapWallet {
    IERC20 public immutable token;
    address public owner; // held by the web server, as in the rival entries reviewed

    struct Agent {
        uint256 perPayment;
        uint256 dailyCap;
        uint256 day;
        uint256 spent;
    }

    mapping(address => Agent) public agents;
    mapping(address => bool) public allowed;
    bool public paused;

    constructor(IERC20 token_, address owner_) {
        token = token_;
        owner = owner_;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function setAgent(address agent, uint256 perPayment, uint256 dailyCap) external onlyOwner {
        agents[agent] = Agent(perPayment, dailyCap, 0, 0);
    }

    function allow(address payee, bool ok) external onlyOwner {
        allowed[payee] = ok;
    }

    function pause(bool p) external onlyOwner {
        paused = p;
    }

    /// The owner's "approval" for anything above the caps is the server pressing this.
    function ownerPay(address to, uint256 amount) external onlyOwner {
        require(token.transfer(to, amount), "transfer");
    }

    function agentPay(address to, uint256 amount) external returns (bool) {
        Agent storage a = agents[msg.sender];
        require(a.perPayment > 0, "not agent");
        require(!paused, "paused");
        if (!allowed[to] || amount > a.perPayment) return false;
        uint256 today = block.timestamp / 1 days; // calendar-day bucket
        if (a.day != today) (a.day, a.spent) = (today, 0);
        if (a.spent + amount > a.dailyCap) return false;
        if (token.balanceOf(address(this)) < amount) return false;
        a.spent += amount;
        require(token.transfer(to, amount), "transfer");
        return true;
    }
}
