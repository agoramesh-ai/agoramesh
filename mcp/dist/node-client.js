/**
 * HTTP client for the AgoraMesh P2P node.
 * Replicates the proven pattern from bridge/src/discovery-proxy.ts.
 */
const DEFAULT_TIMEOUT = 5000;
const BRIDGE_TIMEOUT = 65000; // Bridge sync timeout is 60s, give 5s buffer
export class NodeClientError extends Error {
    statusCode;
    body;
    constructor(statusCode, body) {
        super(`P2P node returned ${statusCode}: ${body}`);
        this.statusCode = statusCode;
        this.body = body;
        this.name = 'NodeClientError';
    }
}
export class NodeClient {
    nodeUrl;
    bridgeUrl;
    bridgeAuth;
    constructor(nodeUrl, options) {
        this.nodeUrl = nodeUrl;
        this.bridgeUrl = options?.bridgeUrl;
        this.bridgeAuth = options?.bridgeAuth ?? 'FreeTier mcp-server';
    }
    async searchAgents(query, options) {
        const params = new URLSearchParams();
        if (query)
            params.set('q', query);
        if (options?.limit !== undefined)
            params.set('limit', String(options.limit));
        if (options?.minTrust !== undefined)
            params.set('minTrust', String(options.minTrust));
        const qs = params.toString();
        const url = `${this.nodeUrl}/agents/semantic${qs ? `?${qs}` : ''}`;
        const result = await this.get(url);
        // Node may return array directly or { agents: [...] }
        let items;
        if (Array.isArray(result))
            items = result;
        else if (result && typeof result === 'object' && 'agents' in result && Array.isArray(result.agents)) {
            items = result.agents;
        }
        else {
            return [];
        }
        // Unwrap search envelope: { did, card: {...}, trust: {...} } → flat object
        return items.map((item) => {
            const obj = item;
            if (obj.card && typeof obj.card === 'object') {
                const card = obj.card;
                return { ...card, did: obj.did, trust: obj.trust };
            }
            return item;
        });
    }
    async getAgent(did) {
        const url = `${this.nodeUrl}/agents/${did}`;
        return this.getOrNull(url);
    }
    async getTrust(did) {
        const url = `${this.nodeUrl}/trust/${did}`;
        return this.getOrNull(url);
    }
    async submitTask(input) {
        if (!this.bridgeUrl)
            throw new Error('Bridge URL not configured');
        const url = `${this.bridgeUrl}/task?wait=true`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': this.bridgeAuth,
            },
            body: JSON.stringify({
                agentDid: input.agentDid,
                prompt: input.prompt,
                ...(input.type && { type: input.type }),
                ...(input.timeout && { timeout: input.timeout }),
            }),
            signal: AbortSignal.timeout(BRIDGE_TIMEOUT),
        });
        if (!response.ok) {
            const text = await response.text();
            throw new NodeClientError(response.status, text);
        }
        return response.json();
    }
    async getTask(taskId) {
        if (!this.bridgeUrl)
            throw new Error('Bridge URL not configured');
        const url = `${this.bridgeUrl}/task/${taskId}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': this.bridgeAuth,
            },
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
        });
        if (!response.ok) {
            const text = await response.text();
            throw new NodeClientError(response.status, text);
        }
        return response.json();
    }
    async get(url) {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
        });
        if (!response.ok) {
            const text = await response.text();
            throw new NodeClientError(response.status, text);
        }
        return response.json();
    }
    async getOrNull(url) {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
        });
        if (!response.ok) {
            if (response.status === 404)
                return null;
            const text = await response.text();
            throw new NodeClientError(response.status, text);
        }
        return response.json();
    }
}
