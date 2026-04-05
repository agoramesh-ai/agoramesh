// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../src/interfaces/chainlink/VRFV2PlusClient.sol";
import "../../src/interfaces/chainlink/IVRFCoordinatorV2Plus.sol";

/// @title VRFCoordinatorV2_5Mock - Mock VRF Coordinator for testing
/// @notice Simulates Chainlink VRF v2.5 Coordinator behavior in tests
/// @dev Call fulfillRandomWords(requestId, consumer) to simulate the VRF callback
contract VRFCoordinatorV2_5Mock is IVRFCoordinatorV2Plus {
    uint256 private _nextRequestId;
    uint256 private _nextSubId;

    struct Request {
        address consumer;
        uint256 subId;
        uint32 numWords;
        bool fulfilled;
    }

    mapping(uint256 => Request) public requests;
    mapping(uint256 => bool) public subscriptions;
    mapping(uint256 => mapping(address => bool)) public consumers;

    event RandomWordsRequested(uint256 indexed requestId, address indexed consumer, uint256 subId, uint32 numWords);
    event RandomWordsFulfilled(uint256 indexed requestId, address indexed consumer);
    event SubscriptionCreated(uint256 indexed subId);

    function createSubscription() external returns (uint256 subId) {
        subId = ++_nextSubId;
        subscriptions[subId] = true;
        emit SubscriptionCreated(subId);
    }

    function fundSubscription(uint256 subId, uint96 /* amount */ ) external view {
        require(subscriptions[subId], "sub not found");
    }

    function addConsumer(uint256 subId, address consumer) external {
        require(subscriptions[subId], "sub not found");
        consumers[subId][consumer] = true;
    }

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req)
        external
        override
        returns (uint256 requestId)
    {
        require(subscriptions[req.subId], "sub not found");
        require(consumers[req.subId][msg.sender], "consumer not added");

        requestId = ++_nextRequestId;
        requests[requestId] =
            Request({ consumer: msg.sender, subId: req.subId, numWords: req.numWords, fulfilled: false });

        emit RandomWordsRequested(requestId, msg.sender, req.subId, req.numWords);
    }

    /// @notice Simulate VRF callback with deterministic random words derived from requestId
    function fulfillRandomWords(uint256 requestId, address consumer) external {
        Request storage req = requests[requestId];
        require(req.consumer == consumer, "wrong consumer");
        require(!req.fulfilled, "already fulfilled");

        req.fulfilled = true;

        uint256[] memory words = new uint256[](req.numWords);
        for (uint256 i = 0; i < req.numWords; i++) {
            words[i] = uint256(keccak256(abi.encode(requestId, i)));
        }

        // Call rawFulfillRandomWords on the consumer
        (bool success,) =
            consumer.call(abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", requestId, words));
        require(success, "fulfillRandomWords failed");

        emit RandomWordsFulfilled(requestId, consumer);
    }

    /// @notice Simulate VRF callback with specific random words (for targeted testing)
    function fulfillRandomWordsWithOverride(uint256 requestId, address consumer, uint256[] calldata words) external {
        Request storage req = requests[requestId];
        require(req.consumer == consumer, "wrong consumer");
        require(!req.fulfilled, "already fulfilled");
        require(words.length == req.numWords, "wrong word count");

        req.fulfilled = true;

        (bool success,) =
            consumer.call(abi.encodeWithSignature("rawFulfillRandomWords(uint256,uint256[])", requestId, words));
        require(success, "fulfillRandomWords failed");

        emit RandomWordsFulfilled(requestId, consumer);
    }
}
