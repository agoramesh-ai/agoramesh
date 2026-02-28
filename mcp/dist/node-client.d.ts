/**
 * HTTP client for the AgoraMesh P2P node.
 * Replicates the proven pattern from bridge/src/discovery-proxy.ts.
 */
export declare class NodeClientError extends Error {
    statusCode: number;
    body: string;
    constructor(statusCode: number, body: string);
}
export interface SearchOptions {
    limit?: number;
    minTrust?: number;
}
export interface NodeClientOptions {
    bridgeUrl?: string;
    bridgeAuth?: string;
}
export interface TaskInput {
    agentDid: string;
    prompt: string;
    type?: string;
    timeout?: number;
}
export interface TaskResult {
    taskId: string;
    status: string;
    output?: string;
    error?: string;
    duration?: number;
}
export declare class NodeClient {
    private nodeUrl;
    private bridgeUrl?;
    private bridgeAuth;
    constructor(nodeUrl: string, options?: NodeClientOptions);
    searchAgents(query?: string, options?: SearchOptions): Promise<unknown[]>;
    getAgent(did: string): Promise<unknown | null>;
    getTrust(did: string): Promise<unknown | null>;
    submitTask(input: TaskInput): Promise<TaskResult>;
    getTask(taskId: string): Promise<TaskResult>;
    private get;
    private getOrNull;
}
