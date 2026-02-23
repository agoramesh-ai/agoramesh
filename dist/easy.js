/**
 * AgoraMesh Easy API
 *
 * Zero-config, high-level interface for AI agents.
 * One import, one setup, done.
 *
 * @example
 * ```typescript
 * import { AgoraMesh } from '@agoramesh/sdk'
 *
 * const me = new AgoraMesh({ privateKey: '0x...' })
 *
 * // Find agents
 * const agents = await me.find('translate legal documents')
 *
 * // Check trust
 * const trust = await me.trust(agents[0])
 *
 * // Hire an agent (creates escrow, sends task, releases on completion)
 * const result = await me.hire(agents[0], {
 *   task: 'Translate this contract to Czech',
 *   budget: '5.00',
 * })
 * ```
 *
 * @packageDocumentation
 */
import { createClient } from './client.js';
import { DiscoveryClient } from './discovery.js';
import { TrustClient } from './trust.js';
import { PaymentClient } from './payment.js';
import { loadDeployment } from './deployments.js';
import { keccak256, toHex } from 'viem';
import { BASE_SEPOLIA_RPC } from './types.js';
// =============================================================================
// AgoraMesh — Easy API
// =============================================================================
export class AgoraMesh {
    options;
    client;
    discovery;
    trustClient;
    payment;
    nodeUrl;
    network;
    myDid;
    initialized = false;
    constructor(options) {
        this.options = options;
        this.network = options.network ?? 'sepolia';
        this.nodeUrl = options.nodeUrl ?? 'https://api.agoramesh.ai';
        this.myDid = options.did ?? '';
    }
    async init() {
        if (this.initialized)
            return;
        const deployment = loadDeployment(this.network);
        this.client = createClient({
            rpcUrl: this.network === 'sepolia' ? BASE_SEPOLIA_RPC : 'https://mainnet.base.org',
            chainId: deployment.chainId,
            privateKey: this.options.privateKey,
            trustRegistryAddress: deployment.trustRegistry,
            escrowAddress: deployment.escrow,
        });
        await this.client.connect();
        const addr = this.client.getAddress();
        if (!this.myDid && addr) {
            this.myDid = `did:agoramesh:base-${this.network}:${addr}`;
        }
        this.discovery = new DiscoveryClient(this.client, this.nodeUrl);
        this.trustClient = new TrustClient(this.client);
        this.payment = new PaymentClient(this.client, this.myDid);
        this.initialized = true;
    }
    /**
     * Find agents by capability description.
     */
    async find(query, options) {
        await this.init();
        const results = await this.discovery.search(query, {
            minTrust: options?.minTrust ?? 0.5,
            maxPrice: options?.maxPrice,
            limit: options?.limit ?? 5,
        });
        return results.map((r) => ({
            did: r.did,
            name: r.name,
            description: r.description,
            url: r.url,
            trust: r.trust?.overall ?? 0,
            price: r.pricing ? String(r.pricing.amount) : undefined,
            capabilities: (r.matchingSkills ?? []).map((s) => s.name ?? s.id),
            _raw: r,
        }));
    }
    /**
     * Get trust score for an agent.
     */
    async trust(agent) {
        await this.init();
        const did = typeof agent === 'string' ? agent : agent.did;
        return this.trustClient.getTrustScore(did);
    }
    /**
     * Hire an agent to perform a task.
     * Automatically handles escrow creation, task submission, and payment.
     */
    async hire(agent, options) {
        await this.init();
        try {
            const taskHash = keccak256(toHex(options.task));
            const deadline = Date.now() + (options.deadlineMs ?? 60 * 60 * 1000);
            const trustScore = await this.trust(agent);
            if (trustScore.overall >= 0.9 && agent.url) {
                // High trust — direct task submission
                const response = await this.submitTask(agent, options.task);
                return {
                    success: response.success,
                    output: response.output,
                    amountPaid: response.success ? options.budget : '0',
                };
            }
            // Normal flow — use escrow
            const addr = this.resolveAddress(agent);
            const escrowId = await this.payment.createAndFundEscrow({
                providerDid: agent.did,
                providerAddress: addr,
                amount: options.budget,
                taskHash,
                deadline,
            });
            const response = await this.submitTask(agent, options.task);
            if (response.success) {
                await this.payment.releaseEscrow(escrowId);
            }
            return {
                success: response.success,
                output: response.output,
                amountPaid: response.success ? options.budget : '0',
            };
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return { success: false, error: msg };
        }
    }
    /**
     * Quick health check — is the network reachable?
     */
    async ping() {
        try {
            const res = await fetch(`${this.nodeUrl}/health`);
            const data = (await res.json());
            return { ok: data.status === 'ok', peers: data.peers ?? 0, version: data.version ?? 'unknown' };
        }
        catch {
            return { ok: false, peers: 0, version: 'unreachable' };
        }
    }
    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------
    async submitTask(agent, task) {
        if (!agent.url) {
            throw new Error(`Agent ${agent.name} has no URL — cannot submit task`);
        }
        const res = await fetch(`${agent.url}/task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                taskId: `task-${Date.now()}`,
                type: 'prompt',
                prompt: task,
            }),
        });
        if (!res.ok) {
            return { success: false, output: `HTTP ${res.status}: ${await res.text()}` };
        }
        const data = (await res.json());
        return {
            success: true,
            output: (data.result ?? data.output ?? JSON.stringify(data)),
        };
    }
    resolveAddress(agent) {
        // Try to extract address from DID
        const match = agent.did.match(/0x[a-fA-F0-9]{40}/);
        if (match)
            return match[0];
        throw new Error(`Cannot resolve payment address for agent ${agent.name}`);
    }
}
/**
 * Create an AgoraMesh instance with minimal config.
 */
export function createAgoraMesh(options) {
    return new AgoraMesh(options);
}
//# sourceMappingURL=easy.js.map