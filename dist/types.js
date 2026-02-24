/**
 * AgoraMesh SDK Types
 *
 * Core type definitions for the AgoraMesh TypeScript SDK.
 *
 * @packageDocumentation
 */
// =============================================================================
// Escrow Types
// =============================================================================
/**
 * Escrow state machine states.
 */
export var EscrowState;
(function (EscrowState) {
    /** Escrow created, waiting for client to fund */
    EscrowState[EscrowState["AWAITING_DEPOSIT"] = 0] = "AWAITING_DEPOSIT";
    /** Client has deposited funds */
    EscrowState[EscrowState["FUNDED"] = 1] = "FUNDED";
    /** Provider has confirmed delivery */
    EscrowState[EscrowState["DELIVERED"] = 2] = "DELIVERED";
    /** Either party has initiated a dispute */
    EscrowState[EscrowState["DISPUTED"] = 3] = "DISPUTED";
    /** Funds released to provider */
    EscrowState[EscrowState["RELEASED"] = 4] = "RELEASED";
    /** Funds refunded to client */
    EscrowState[EscrowState["REFUNDED"] = 5] = "REFUNDED";
})(EscrowState || (EscrowState = {}));
/**
 * Human-readable escrow state names.
 */
export const EscrowStateNames = {
    [EscrowState.AWAITING_DEPOSIT]: 'Awaiting Deposit',
    [EscrowState.FUNDED]: 'Funded',
    [EscrowState.DELIVERED]: 'Delivered',
    [EscrowState.DISPUTED]: 'Disputed',
    [EscrowState.RELEASED]: 'Released',
    [EscrowState.REFUNDED]: 'Refunded',
};
// =============================================================================
// Constants
// =============================================================================
/** Base Mainnet chain ID */
export const BASE_MAINNET_CHAIN_ID = 8453;
/** Base Sepolia chain ID */
export const BASE_SEPOLIA_CHAIN_ID = 84532;
/** USDC contract on Base Mainnet */
export const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** USDC contract on Base Sepolia */
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
/** Base Mainnet RPC URL */
export const BASE_MAINNET_RPC = 'https://mainnet.base.org';
/** Base Sepolia RPC URL */
export const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
/** Basis points denominator (100%) */
export const BASIS_POINTS = 10000;
/** USDC decimals */
export const USDC_DECIMALS = 6;
//# sourceMappingURL=types.js.map