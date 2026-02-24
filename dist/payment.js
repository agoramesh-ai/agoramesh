/**
 * AgoraMesh Payment Client
 *
 * Client for managing escrow payments between agents.
 *
 * @packageDocumentation
 */
import { parseEventLogs } from 'viem';
import { didToHash } from './client.js';
import { EscrowStateNames } from './types.js';
import { parseUSDC, formatUSDC, toUnixTimestamp } from './utils.js';
import { ERC20_ABI } from './abis.js';
// =============================================================================
// ABI Fragments
// =============================================================================
const ESCROW_ABI = [
    {
        name: 'createEscrow',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'clientDid', type: 'bytes32' },
            { name: 'providerDid', type: 'bytes32' },
            { name: 'providerAddress', type: 'address' },
            { name: 'token', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'taskHash', type: 'bytes32' },
            { name: 'deadline', type: 'uint256' },
        ],
        outputs: [{ name: 'escrowId', type: 'uint256' }],
    },
    {
        name: 'fundEscrow',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'escrowId', type: 'uint256' }],
        outputs: [],
    },
    {
        name: 'confirmDelivery',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'escrowId', type: 'uint256' },
            { name: 'outputHash', type: 'bytes32' },
        ],
        outputs: [],
    },
    {
        name: 'releaseEscrow',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'escrowId', type: 'uint256' }],
        outputs: [],
    },
    {
        name: 'initiateDispute',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
            { name: 'escrowId', type: 'uint256' },
            { name: 'evidence', type: 'bytes' },
        ],
        outputs: [],
    },
    {
        name: 'claimTimeout',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'escrowId', type: 'uint256' }],
        outputs: [],
    },
    {
        name: 'getEscrow',
        type: 'function',
        stateMutability: 'view',
        inputs: [{ name: 'escrowId', type: 'uint256' }],
        outputs: [
            {
                name: '',
                type: 'tuple',
                components: [
                    { name: 'id', type: 'uint256' },
                    { name: 'clientDid', type: 'bytes32' },
                    { name: 'providerDid', type: 'bytes32' },
                    { name: 'clientAddress', type: 'address' },
                    { name: 'providerAddress', type: 'address' },
                    { name: 'amount', type: 'uint256' },
                    { name: 'token', type: 'address' },
                    { name: 'taskHash', type: 'bytes32' },
                    { name: 'outputHash', type: 'bytes32' },
                    { name: 'deadline', type: 'uint256' },
                    { name: 'state', type: 'uint8' },
                    { name: 'createdAt', type: 'uint256' },
                    { name: 'deliveredAt', type: 'uint256' },
                ],
            },
        ],
    },
    {
        name: 'nextEscrowId',
        type: 'function',
        stateMutability: 'view',
        inputs: [],
        outputs: [{ name: '', type: 'uint256' }],
    },
    {
        name: 'EscrowCreated',
        type: 'event',
        inputs: [
            { name: 'escrowId', type: 'uint256', indexed: true },
            { name: 'clientDid', type: 'bytes32', indexed: true },
            { name: 'providerDid', type: 'bytes32', indexed: true },
            { name: 'amount', type: 'uint256', indexed: false },
            { name: 'deadline', type: 'uint256', indexed: false },
        ],
    },
    // Custom Errors
    {
        type: 'error',
        name: 'AgentNotActive',
        inputs: [],
    },
    {
        type: 'error',
        name: 'EscrowNotFound',
        inputs: [],
    },
    {
        type: 'error',
        name: 'InvalidState',
        inputs: [],
    },
    {
        type: 'error',
        name: 'InvalidAmount',
        inputs: [],
    },
    {
        type: 'error',
        name: 'InvalidDeadline',
        inputs: [],
    },
    {
        type: 'error',
        name: 'InvalidProviderAddress',
        inputs: [],
    },
    {
        type: 'error',
        name: 'NotAuthorized',
        inputs: [],
    },
    {
        type: 'error',
        name: 'NotClient',
        inputs: [],
    },
    {
        type: 'error',
        name: 'NotProvider',
        inputs: [],
    },
    {
        type: 'error',
        name: 'DeadlineNotPassed',
        inputs: [],
    },
];
// =============================================================================
// Helpers
// =============================================================================
/**
 * Parse escrow data from contract response.
 */
function parseEscrow(data) {
    return {
        id: data.id,
        clientDid: data.clientDid,
        providerDid: data.providerDid,
        clientAddress: data.clientAddress,
        providerAddress: data.providerAddress,
        amount: data.amount,
        token: data.token,
        taskHash: data.taskHash,
        outputHash: data.outputHash,
        deadline: data.deadline,
        state: data.state,
        createdAt: data.createdAt,
        deliveredAt: data.deliveredAt,
    };
}
// =============================================================================
// PaymentClient
// =============================================================================
/**
 * Client for managing escrow payments between agents.
 *
 * The payment layer supports:
 * - Creating escrows for untrusted transactions
 * - Funding escrows with USDC
 * - Releasing funds to providers
 * - Claiming refunds on timeout
 * - Initiating disputes
 *
 * @example
 * ```typescript
 * const client = new AgoraMeshClient({ ... });
 * await client.connect();
 *
 * const payment = new PaymentClient(client, 'did:agoramesh:base:0x...');
 *
 * // Create and fund an escrow
 * const escrowId = await payment.createEscrow({
 *   providerDid: 'did:agoramesh:base:0x...',
 *   providerAddress: '0x...',
 *   amount: '100',
 *   taskHash: '0x...',
 *   deadline: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
 * });
 *
 * await payment.fundEscrow(escrowId);
 *
 * // After task completion, release funds
 * await payment.releaseEscrow(escrowId);
 * ```
 */
export class PaymentClient {
    client;
    clientDid;
    /**
     * Create a new PaymentClient.
     *
     * @param client - The AgoraMesh client instance
     * @param clientDid - The client agent's DID (for creating escrows)
     */
    constructor(client, clientDid) {
        this.client = client;
        this.clientDid = clientDid;
    }
    // ===========================================================================
    // Escrow Creation
    // ===========================================================================
    /**
     * Create a new escrow for an agent task.
     *
     * @param options - Escrow creation options
     * @returns The new escrow ID
     *
     * @example
     * ```typescript
     * const escrowId = await payment.createEscrow({
     *   providerDid: 'did:agoramesh:base:0x...',
     *   providerAddress: '0x...',
     *   amount: '100', // 100 USDC
     *   taskHash: keccak256(toHex(taskDescription)),
     *   deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
     * });
     * ```
     */
    async createEscrow(options) {
        const walletClient = this.client.getWalletClient();
        const publicClient = this.client.getPublicClient();
        const addresses = this.client.getContractAddresses();
        if (!walletClient || !publicClient) {
            throw new Error('Wallet not connected.');
        }
        if (!addresses.escrow) {
            throw new Error('Escrow address not configured.');
        }
        const tokenAddress = options.tokenAddress ?? addresses.usdc;
        if (!tokenAddress) {
            throw new Error('Token address not configured.');
        }
        const clientDidHash = didToHash(this.clientDid);
        const providerDidHash = didToHash(options.providerDid);
        const amountWei = parseUSDC(options.amount);
        const deadline = toUnixTimestamp(options.deadline);
        const txHash = await walletClient.writeContract({
            address: addresses.escrow,
            abi: ESCROW_ABI,
            functionName: 'createEscrow',
            args: [
                clientDidHash,
                providerDidHash,
                options.providerAddress,
                tokenAddress,
                amountWei,
                options.taskHash,
                deadline,
            ],
        });
        // Wait for transaction to be mined
        const receipt = await publicClient.waitForTransactionReceipt({
            hash: txHash,
        });
        // Get escrow ID from the EscrowCreated event log
        const logs = parseEventLogs({
            abi: ESCROW_ABI,
            logs: receipt.logs,
            eventName: 'EscrowCreated',
        });
        if (logs.length === 0) {
            throw new Error('EscrowCreated event not found in transaction receipt');
        }
        const firstLog = logs[0];
        return firstLog.args.escrowId;
    }
    /**
     * Create and immediately fund an escrow.
     *
     * @param options - Escrow creation options
     * @returns The new escrow ID
     */
    async createAndFundEscrow(options) {
        const escrowId = await this.createEscrow(options);
        await this.fundEscrow(escrowId);
        return escrowId;
    }
    // ===========================================================================
    // Escrow Lifecycle
    // ===========================================================================
    /**
     * Fund an escrow with USDC.
     *
     * Handles token approval automatically.
     *
     * @param escrowId - The escrow ID to fund
     * @returns Transaction hash
     */
    async fundEscrow(escrowId) {
        const walletClient = this.client.getWalletClient();
        const publicClient = this.client.getPublicClient();
        const addresses = this.client.getContractAddresses();
        const ownerAddress = this.client.getAddress();
        if (!walletClient || !publicClient || !ownerAddress) {
            throw new Error('Wallet not connected.');
        }
        if (!addresses.escrow) {
            throw new Error('Escrow address not configured.');
        }
        // Get escrow details to know the amount and token
        const escrow = await this.getEscrow(escrowId);
        // Check allowance and approve if needed
        const allowance = await publicClient.readContract({
            address: escrow.token,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [ownerAddress, addresses.escrow],
        });
        if (allowance < escrow.amount) {
            const approveTxHash = await walletClient.writeContract({
                address: escrow.token,
                abi: ERC20_ABI,
                functionName: 'approve',
                args: [addresses.escrow, escrow.amount],
            });
            await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
        }
        // Fund the escrow
        const txHash = await walletClient.writeContract({
            address: addresses.escrow,
            abi: ESCROW_ABI,
            functionName: 'fundEscrow',
            args: [escrowId],
        });
        return txHash;
    }
    /**
     * Confirm task delivery (provider only).
     *
     * @param escrowId - The escrow ID
     * @param outputHash - Hash of the delivered output
     * @returns Transaction hash
     */
    async confirmDelivery(escrowId, outputHash) {
        const walletClient = this.client.getWalletClient();
        const addresses = this.client.getContractAddresses();
        if (!walletClient) {
            throw new Error('Wallet not connected.');
        }
        if (!addresses.escrow) {
            throw new Error('Escrow address not configured.');
        }
        const txHash = await walletClient.writeContract({
            address: addresses.escrow,
            abi: ESCROW_ABI,
            functionName: 'confirmDelivery',
            args: [escrowId, outputHash],
        });
        return txHash;
    }
    /**
     * Release escrowed funds to the provider.
     *
     * @param escrowId - The escrow ID to release
     * @returns Transaction hash
     */
    async releaseEscrow(escrowId) {
        const walletClient = this.client.getWalletClient();
        const addresses = this.client.getContractAddresses();
        if (!walletClient) {
            throw new Error('Wallet not connected.');
        }
        if (!addresses.escrow) {
            throw new Error('Escrow address not configured.');
        }
        const txHash = await walletClient.writeContract({
            address: addresses.escrow,
            abi: ESCROW_ABI,
            functionName: 'releaseEscrow',
            args: [escrowId],
        });
        return txHash;
    }
    /**
     * Claim refund after deadline has passed.
     *
     * @param escrowId - The escrow ID to claim timeout on
     * @returns Transaction hash
     */
    async claimTimeout(escrowId) {
        const walletClient = this.client.getWalletClient();
        const addresses = this.client.getContractAddresses();
        if (!walletClient) {
            throw new Error('Wallet not connected.');
        }
        if (!addresses.escrow) {
            throw new Error('Escrow address not configured.');
        }
        const txHash = await walletClient.writeContract({
            address: addresses.escrow,
            abi: ESCROW_ABI,
            functionName: 'claimTimeout',
            args: [escrowId],
        });
        return txHash;
    }
    // ===========================================================================
    // Disputes
    // ===========================================================================
    /**
     * Initiate a dispute for an escrow.
     *
     * @param escrowId - The escrow ID to dispute
     * @param evidence - Evidence supporting the dispute (e.g., IPFS CID as bytes)
     * @returns Transaction hash
     */
    async initiateDispute(escrowId, evidence = '0x') {
        const walletClient = this.client.getWalletClient();
        const addresses = this.client.getContractAddresses();
        if (!walletClient) {
            throw new Error('Wallet not connected.');
        }
        if (!addresses.escrow) {
            throw new Error('Escrow address not configured.');
        }
        const txHash = await walletClient.writeContract({
            address: addresses.escrow,
            abi: ESCROW_ABI,
            functionName: 'initiateDispute',
            args: [escrowId, evidence],
        });
        return txHash;
    }
    // ===========================================================================
    // Queries
    // ===========================================================================
    /**
     * Get escrow details by ID.
     *
     * @param escrowId - The escrow ID to query
     * @returns Escrow details
     */
    async getEscrow(escrowId) {
        const publicClient = this.client.getPublicClient();
        const addresses = this.client.getContractAddresses();
        if (!publicClient) {
            throw new Error('Client is not connected.');
        }
        if (!addresses.escrow) {
            throw new Error('Escrow address not configured.');
        }
        const result = await publicClient.readContract({
            address: addresses.escrow,
            abi: ESCROW_ABI,
            functionName: 'getEscrow',
            args: [escrowId],
        });
        return parseEscrow(result);
    }
    /**
     * Check if an escrow can be claimed due to timeout.
     *
     * @param escrowId - The escrow ID to check
     * @returns True if timeout can be claimed
     */
    async canClaimTimeout(escrowId) {
        const escrow = await this.getEscrow(escrowId);
        // Must be in FUNDED state
        if (escrow.state !== 1) {
            return false;
        }
        // Deadline must have passed
        const now = BigInt(Math.floor(Date.now() / 1000));
        return now > escrow.deadline;
    }
    /**
     * Get the time remaining until deadline.
     *
     * @param escrowId - The escrow ID
     * @returns Seconds until deadline (negative if passed)
     */
    async getTimeUntilDeadline(escrowId) {
        const escrow = await this.getEscrow(escrowId);
        const now = Math.floor(Date.now() / 1000);
        return Number(escrow.deadline) - now;
    }
    // ===========================================================================
    // Utility Methods
    // ===========================================================================
    /**
     * Get the human-readable amount for an escrow.
     *
     * @param escrowId - The escrow ID
     * @returns Amount as string (e.g., "100.00")
     */
    async getEscrowAmount(escrowId) {
        const escrow = await this.getEscrow(escrowId);
        return formatUSDC(escrow.amount);
    }
    /**
     * Get the human-readable state name for an escrow.
     *
     * @param escrowId - The escrow ID
     * @returns State name (e.g., "Funded")
     */
    async getEscrowStateName(escrowId) {
        const escrow = await this.getEscrow(escrowId);
        return EscrowStateNames[escrow.state] ?? 'Unknown';
    }
    /**
     * Check if the current user is the client for an escrow.
     *
     * @param escrowId - The escrow ID
     * @returns True if current user is the client
     */
    async isClient(escrowId) {
        const escrow = await this.getEscrow(escrowId);
        const address = this.client.getAddress();
        return (address !== null &&
            address.toLowerCase() === escrow.clientAddress.toLowerCase());
    }
    /**
     * Check if the current user is the provider for an escrow.
     *
     * @param escrowId - The escrow ID
     * @returns True if current user is the provider
     */
    async isProvider(escrowId) {
        const escrow = await this.getEscrow(escrowId);
        const address = this.client.getAddress();
        return (address !== null &&
            address.toLowerCase() === escrow.providerAddress.toLowerCase());
    }
    /**
     * Format an escrow for display.
     *
     * @param escrow - The escrow to format
     * @returns Formatted escrow summary
     */
    formatEscrow(escrow) {
        const now = Math.floor(Date.now() / 1000);
        return {
            id: escrow.id.toString(),
            amount: formatUSDC(escrow.amount),
            state: EscrowStateNames[escrow.state] ?? 'Unknown',
            deadline: new Date(Number(escrow.deadline) * 1000),
            isOverdue: now > Number(escrow.deadline) && escrow.state === 1,
        };
    }
}
//# sourceMappingURL=payment.js.map