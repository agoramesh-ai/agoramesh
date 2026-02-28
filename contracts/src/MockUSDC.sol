// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC - Test-only ERC20 with public mint
/// @notice Used for local Anvil development. DO NOT deploy to mainnet.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin (Mock)", "USDC") { }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint tokens to any address (test only)
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
