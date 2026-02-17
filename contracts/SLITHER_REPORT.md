# Slither Analysis Report
Total findings: 73 (excluding lib/)

## Medium (13)
- **divide-before-multiply**: NFTBoundReputation._calculateTrustDetails(uint256) (src/NFTBoundReputation.sol#365-383) performs a multiplication on the
- **divide-before-multiply**: NFTBoundReputation.calculateReputationScore(uint256) (src/NFTBoundReputation.sol#331-359) performs a multiplication on t
- **divide-before-multiply**: TrustRegistry._calculateTrustDetails(bytes32) (src/TrustRegistry.sol#477-501) performs a multiplication on the result of
- **divide-before-multiply**: TrustRegistry._calculateReputationScore(bytes32) (src/TrustRegistry.sol#438-469) performs a multiplication on the result
- **incorrect-equality**: StreamingPayments._isPaused(uint256) (src/StreamingPayments.sol#389-391) uses a dangerous strict equality:
- **incorrect-equality**: StreamingPayments.isActive(uint256) (src/StreamingPayments.sol#362-364) uses a dangerous strict equality:
- **incorrect-equality**: StreamingPayments.withdrawMax(uint256) (src/StreamingPayments.sol#191-208) uses a dangerous strict equality:
- **incorrect-equality**: StreamingPayments.withdrawMax(uint256) (src/StreamingPayments.sol#191-208) uses a dangerous strict equality:
- **unused-return**: NFTBoundReputation._requireTokenExists(uint256) (src/NFTBoundReputation.sol#387-396) ignores return value by agentToken.
- **unused-return**: ERC8004Adapter.getSummary(uint256,address[],string,string) (src/ERC8004Adapter.sol#149-168) ignores return value by (sco
- **unused-return**: ERC8004Adapter.getMetadata(uint256,string) (src/ERC8004Adapter.sol#88-114) ignores return value by (None,capabilityCID,N
- **unused-return**: ERC8004Adapter._getDidHash(uint256) (src/ERC8004Adapter.sol#303-308) ignores return value by (didHash,None,None,None) = 
- **unused-return**: ERC8004Adapter.getMetadata(uint256,string) (src/ERC8004Adapter.sol#88-114) ignores return value by (None,None,None,activ

## Low (30)
- **calls-loop**: NFTBoundReputation._requireTokenExists(uint256) (src/NFTBoundReputation.sol#387-396) has external calls inside a loop: a
- **timestamp**: StreamingPayments.topUp(uint256,uint256) (src/StreamingPayments.sol#213-232) uses timestamp for comparisons
- **timestamp**: TieredDisputeResolution.finalizeRuling(uint256) (src/TieredDisputeResolution.sol#295-350) uses timestamp for comparisons
- **timestamp**: TrustRegistry.executeWithdraw(bytes32) (src/TrustRegistry.sol#261-282) uses timestamp for comparisons
- **timestamp**: StreamingPayments.pause(uint256) (src/StreamingPayments.sol#237-246) uses timestamp for comparisons
- **timestamp**: StreamingPayments._isPaused(uint256) (src/StreamingPayments.sol#389-391) uses timestamp for comparisons
- **timestamp**: TieredDisputeResolution.checkAutoResolution(uint256) (src/TieredDisputeResolution.sol#430-463) uses timestamp for compar
- **timestamp**: TrustRegistry._requireRegistered(bytes32) (src/TrustRegistry.sol#553-557) uses timestamp for comparisons
- **timestamp**: TieredDisputeResolution.appeal(uint256) (src/TieredDisputeResolution.sol#355-395) uses timestamp for comparisons
- **timestamp**: TieredDisputeResolution.executeSettlement(uint256) (src/TieredDisputeResolution.sol#400-425) uses timestamp for comparis
- **timestamp**: TieredDisputeResolution.castVote(uint256,IDisputeResolution.Vote,uint256,bytes32) (src/TieredDisputeResolution.sol#243-2
- **timestamp**: TieredDisputeResolution.submitAIAnalysis(uint256,bytes32,uint256) (src/TieredDisputeResolution.sol#212-238) uses timesta
- **timestamp**: AgentMeshEscrow.createEscrow(bytes32,bytes32,address,address,uint256,bytes32,uint256) (src/AgentMeshEscrow.sol#83-137) u
- **timestamp**: AgentMeshEscrow.releaseEscrow(uint256) (src/AgentMeshEscrow.sol#177-206) uses timestamp for comparisons
- **timestamp**: TieredDisputeResolution.executeAutoResolution(uint256) (src/TieredDisputeResolution.sol#466-500) uses timestamp for comp
- **timestamp**: StreamingPayments.cancel(uint256) (src/StreamingPayments.sol#268-302) uses timestamp for comparisons
- **timestamp**: TrustRegistry.registerAgent(bytes32,string) (src/TrustRegistry.sol#117-141) uses timestamp for comparisons
- **timestamp**: StreamingPayments.resume(uint256) (src/StreamingPayments.sol#249-263) uses timestamp for comparisons
- **timestamp**: TrustRegistry.endorse(bytes32,string) (src/TrustRegistry.sol#326-362) uses timestamp for comparisons
- **timestamp**: StreamingPayments.isActive(uint256) (src/StreamingPayments.sol#362-364) uses timestamp for comparisons
- **timestamp**: StreamingPayments.withdraw(uint256,uint256) (src/StreamingPayments.sol#170-188) uses timestamp for comparisons
- **timestamp**: NFTBoundReputation.executeWithdraw(uint256) (src/NFTBoundReputation.sol#254-267) uses timestamp for comparisons
- **timestamp**: StreamingPayments.withdrawMax(uint256) (src/StreamingPayments.sol#191-208) uses timestamp for comparisons
- **timestamp**: StreamingPayments.createStreamWithTimestamps(bytes32,address,address,uint256,uint256,uint256,bool,bool) (src/StreamingPa
- **timestamp**: StreamingPayments.streamedAmountOf(uint256) (src/StreamingPayments.sol#323-353) uses timestamp for comparisons
- **timestamp**: TrustRegistry._requireOwner(bytes32) (src/TrustRegistry.sol#537-541) uses timestamp for comparisons
- **timestamp**: CrossChainTrustSync.isCacheStale(bytes32) (src/CrossChainTrustSync.sol#244-250) uses timestamp for comparisons
- **timestamp**: TieredDisputeResolution.submitEvidence(uint256,bytes32) (src/TieredDisputeResolution.sol#184-207) uses timestamp for com
- **timestamp**: AgentMeshEscrow.claimTimeout(uint256) (src/AgentMeshEscrow.sol#283-305) uses timestamp for comparisons
- **timestamp**: TrustRegistry._calculateEndorsementScore(bytes32) (src/TrustRegistry.sol#506-533) uses timestamp for comparisons

## Informational (22)
- **costly-loop**: TieredDisputeResolution.unregisterArbiter(address) (src/TieredDisputeResolution.sol#655-666) has costly operations insid
- **costly-loop**: TieredDisputeResolution.unregisterArbiter(address) (src/TieredDisputeResolution.sol#655-666) has costly operations insid
- **cyclomatic-complexity**: AgentMeshEscrow.createEscrow(bytes32,bytes32,address,address,uint256,bytes32,uint256) (src/AgentMeshEscrow.sol#83-137) h
- **dead-code**: AgentToken._increaseBalance(address,uint128) (src/AgentToken.sol#348-350) is never used and should be removed
- **dead-code**: CrossChainTrustSync._handleTrustSync(uint32,bytes) (src/CrossChainTrustSync.sol#179-188) is never used and should be rem
- **naming-convention**: Parameter TrustRegistry.setTreasury(address)._treasury (src/TrustRegistry.sol#318) is not in mixedCase
- **naming-convention**: Parameter NFTBoundReputation.setTreasury(address)._treasury (src/NFTBoundReputation.sol#412) is not in mixedCase
- **naming-convention**: Parameter AgentToken.setTreasury(address)._treasury (src/AgentToken.sol#268) is not in mixedCase
- **redundant-statements**: Redundant expression "requestHash (src/ERC8004Adapter.sol#241)" inERC8004Adapter (src/ERC8004Adapter.sol#14-309)
- **redundant-statements**: Redundant expression "validatorAddresses (src/ERC8004Adapter.sol#261)" inERC8004Adapter (src/ERC8004Adapter.sol#14-309)
- **redundant-statements**: Redundant expression "clientAddress (src/ERC8004Adapter.sol#210)" inERC8004Adapter (src/ERC8004Adapter.sol#14-309)
- **redundant-statements**: Redundant expression "tag2 (src/ERC8004Adapter.sol#157)" inERC8004Adapter (src/ERC8004Adapter.sol#14-309)
- **redundant-statements**: Redundant expression "clientAddresses (src/ERC8004Adapter.sol#155)" inERC8004Adapter (src/ERC8004Adapter.sol#14-309)
- **redundant-statements**: Redundant expression "feedbackIndex (src/ERC8004Adapter.sol#189)" inERC8004Adapter (src/ERC8004Adapter.sol#14-309)
- **redundant-statements**: Redundant expression "tag (src/ERC8004Adapter.sol#262)" inERC8004Adapter (src/ERC8004Adapter.sol#14-309)
- **redundant-statements**: Redundant expression "agentId (src/ERC8004Adapter.sol#199)" inERC8004Adapter (src/ERC8004Adapter.sol#14-309)
- **redundant-statements**: Redundant expression "agentId (src/ERC8004Adapter.sol#283)" inERC8004Adapter (src/ERC8004Adapter.sol#14-309)
- **redundant-statements**: Redundant expression "agentId (src/ERC8004Adapter.sol#187)" inERC8004Adapter (src/ERC8004Adapter.sol#14-309)
- **redundant-statements**: Redundant expression "agentId (src/ERC8004Adapter.sol#209)" inERC8004Adapter (src/ERC8004Adapter.sol#14-309)
- **redundant-statements**: Redundant expression "tag1 (src/ERC8004Adapter.sol#156)" inERC8004Adapter (src/ERC8004Adapter.sol#14-309)
- **redundant-statements**: Redundant expression "clientAddress (src/ERC8004Adapter.sol#188)" inERC8004Adapter (src/ERC8004Adapter.sol#14-309)
- **unindexed-event-address**: Event AgentToken.TreasurySet(address) (src/AgentToken.sol#80) has address parameters but no indexed parameters

## Optimization (8)
- **cache-array-length**: Loop condition i < _peerEids.length (src/CrossChainTrustSync.sol#280) should use cached array length instead of referenc
- **cache-array-length**: Loop condition i_scope_0 < _peerEids.length (src/CrossChainTrustSync.sol#289) should use cached array length instead of 
- **cache-array-length**: Loop condition i_scope_0 < _chainIds.length (src/ChainRegistry.sol#203) should use cached array length instead of refere
- **cache-array-length**: Loop condition i < _chainIds.length (src/ChainRegistry.sol#195) should use cached array length instead of referencing `l
- **cache-array-length**: Loop condition i < _chainIds.length (src/ChainRegistry.sol#174) should use cached array length instead of referencing `l
- **cache-array-length**: Loop condition i_scope_0 < _chainIds.length (src/ChainRegistry.sol#182) should use cached array length instead of refere
- **cache-array-length**: Loop condition i_scope_0 < _chainIds.length (src/ChainRegistry.sol#224) should use cached array length instead of refere
- **cache-array-length**: Loop condition i < _chainIds.length (src/ChainRegistry.sol#216) should use cached array length instead of referencing `l

