// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PolicyVault} from "./PolicyVault.sol";

/// @title VaultFactory
/// @notice Deploys one PolicyVault per owner passkey at a predictable address. Anyone may call it:
/// a new vault holds nothing and has no agents until its owner signs them in.
contract VaultFactory {
    address public immutable guardian;

    event VaultCreated(address indexed vault, bytes32 indexed keyId, address token);

    constructor(address guardian_) {
        guardian = guardian_;
    }

    function createVault(
        IERC20 token,
        bytes32 x,
        bytes32 y,
        bytes32 rpIdHash,
        uint256 protectedAmount,
        uint256 dailyCeiling,
        uint64 newContactDelay,
        bytes32 salt
    ) external returns (PolicyVault vault) {
        vault = new PolicyVault{salt: _salt(x, y, salt)}(token, guardian, x, y, rpIdHash, protectedAmount, dailyCeiling, newContactDelay);
        emit VaultCreated(address(vault), keccak256(abi.encode(x, y)), address(token));
    }

    function predict(
        IERC20 token,
        bytes32 x,
        bytes32 y,
        bytes32 rpIdHash,
        uint256 protectedAmount,
        uint256 dailyCeiling,
        uint64 newContactDelay,
        bytes32 salt
    ) external view returns (address) {
        bytes memory init = abi.encodePacked(
            type(PolicyVault).creationCode,
            abi.encode(token, guardian, x, y, rpIdHash, protectedAmount, dailyCeiling, newContactDelay)
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(x, y, salt), keccak256(init))))));
    }

    function _salt(bytes32 x, bytes32 y, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(x, y, salt));
    }
}
