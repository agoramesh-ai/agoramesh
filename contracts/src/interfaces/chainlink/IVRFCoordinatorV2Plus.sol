// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./VRFV2PlusClient.sol";

/// @title IVRFCoordinatorV2Plus - Chainlink VRF v2.5 Coordinator interface
/// @notice Minimal interface for requesting random words from VRF Coordinator v2.5
/// @dev Based on @chainlink/contracts v1.3.0
interface IVRFCoordinatorV2Plus {
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req)
        external
        returns (uint256 requestId);
}
