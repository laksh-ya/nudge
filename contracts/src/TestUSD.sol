// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSD
/// @notice Test-network dollar for demos. Worthless by design: anyone can mint up to 1,000 per call.
contract TestUSD is ERC20 {
    uint256 public constant FAUCET_LIMIT = 1_000e6;

    error OverLimit();

    constructor() ERC20("Test USD (agent wallet demo)", "tUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(address to, uint256 amount) external {
        if (amount > FAUCET_LIMIT) revert OverLimit();
        _mint(to, amount);
    }
}
