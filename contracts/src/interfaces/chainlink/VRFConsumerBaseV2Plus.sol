// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IVRFCoordinatorV2Plus.sol";

/// @title VRFConsumerBaseV2Plus - Chainlink VRF v2.5 consumer base
/// @notice Abstract base contract for VRF v2.5 consumers
/// @dev Based on @chainlink/contracts v1.3.0. The coordinator calls rawFulfillRandomWords,
///      which verifies the caller and dispatches to the consumer's fulfillRandomWords.
abstract contract VRFConsumerBaseV2Plus {
    error OnlyCoordinatorCanFulfill(address have, address want);

    IVRFCoordinatorV2Plus internal immutable s_vrfCoordinator;

    constructor(address _vrfCoordinator) {
        s_vrfCoordinator = IVRFCoordinatorV2Plus(_vrfCoordinator);
    }

    /// @notice Called by the coordinator with verified random words
    /// @param requestId The ID of the VRF request
    /// @param randomWords The array of random words
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal virtual;

    /// @notice External entry point called only by the VRF coordinator
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(s_vrfCoordinator)) {
            revert OnlyCoordinatorCanFulfill(msg.sender, address(s_vrfCoordinator));
        }
        fulfillRandomWords(requestId, randomWords);
    }
}
