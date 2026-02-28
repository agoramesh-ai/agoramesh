/**
 * Environment variable validation for the Bridge server.
 *
 * Validates that required env vars are present and well-formed
 * before the server starts. Returns clear error messages.
 */

export interface ValidationError {
  variable: string;
  message: string;
}

/**
 * Validate bridge server configuration from environment variables.
 * Returns a list of validation errors (empty if valid).
 */
export function validateBridgeConfig(env: Record<string, string | undefined>): ValidationError[] {
  const errors: ValidationError[] = [];

  // === Required ===

  // AGENT_PRIVATE_KEY: required, must be a 0x-prefixed hex string
  const privateKey = env.AGENT_PRIVATE_KEY;
  if (!privateKey) {
    errors.push({
      variable: 'AGENT_PRIVATE_KEY',
      message: 'Required. Set to a 0x-prefixed Ethereum private key.',
    });
  } else if (!isValidPrivateKey(privateKey)) {
    errors.push({
      variable: 'AGENT_PRIVATE_KEY',
      message: 'Invalid format. Must be a 0x-prefixed 64-character hex string.',
    });
  }

  // === Optional with validation ===

  // BRIDGE_PORT: optional, but if set must be a valid port
  const portStr = env.BRIDGE_PORT;
  if (portStr) {
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      errors.push({
        variable: 'BRIDGE_PORT',
        message: `Invalid port: "${portStr}". Must be a number between 1 and 65535.`,
      });
    }
  }

  // TASK_TIMEOUT: optional, but if set must be a positive number
  const timeoutStr = env.TASK_TIMEOUT;
  if (timeoutStr) {
    const timeout = parseInt(timeoutStr, 10);
    if (isNaN(timeout) || timeout < 1) {
      errors.push({
        variable: 'TASK_TIMEOUT',
        message: `Invalid timeout: "${timeoutStr}". Must be a positive integer (seconds).`,
      });
    }
  }

  // AGENT_PRICE_PER_TASK: optional, but if set must be a non-negative number
  const priceStr = env.AGENT_PRICE_PER_TASK;
  if (priceStr) {
    const price = parseFloat(priceStr);
    if (isNaN(price) || price < 0) {
      errors.push({
        variable: 'AGENT_PRICE_PER_TASK',
        message: `Invalid price: "${priceStr}". Must be a non-negative number.`,
      });
    }
  }

  // AGORAMESH_NODE_URL: optional, but if set must be valid URL
  const nodeUrl = env.AGORAMESH_NODE_URL;
  if (nodeUrl && !isValidUrl(nodeUrl)) {
    errors.push({
      variable: 'AGORAMESH_NODE_URL',
      message: `Invalid URL: "${nodeUrl}". Must be a valid HTTP(S) URL.`,
    });
  }

  // === Escrow config (all-or-nothing) ===

  const escrowAddr = env.ESCROW_ADDRESS;
  const escrowRpc = env.ESCROW_RPC_URL;
  const providerDid = env.PROVIDER_DID;

  if (escrowAddr || escrowRpc || providerDid) {
    if (!escrowAddr) {
      errors.push({
        variable: 'ESCROW_ADDRESS',
        message: 'Required when ESCROW_RPC_URL or PROVIDER_DID is set.',
      });
    } else if (!isValidEthAddress(escrowAddr)) {
      errors.push({
        variable: 'ESCROW_ADDRESS',
        message: `Invalid Ethereum address: "${escrowAddr}". Must be a 0x-prefixed 40-character hex string.`,
      });
    }

    if (!escrowRpc) {
      errors.push({
        variable: 'ESCROW_RPC_URL',
        message: 'Required when ESCROW_ADDRESS or PROVIDER_DID is set.',
      });
    } else if (!isValidUrl(escrowRpc)) {
      errors.push({
        variable: 'ESCROW_RPC_URL',
        message: `Invalid URL: "${escrowRpc}". Must be a valid HTTP(S) URL.`,
      });
    }

    if (!providerDid) {
      errors.push({
        variable: 'PROVIDER_DID',
        message: 'Required when ESCROW_ADDRESS or ESCROW_RPC_URL is set.',
      });
    }

    const chainId = env.ESCROW_CHAIN_ID;
    if (chainId) {
      const id = parseInt(chainId, 10);
      if (isNaN(id) || id < 1) {
        errors.push({
          variable: 'ESCROW_CHAIN_ID',
          message: `Invalid chain ID: "${chainId}". Must be a positive integer.`,
        });
      }
    }
  }

  // === x402 config ===

  const x402Enabled = env.X402_ENABLED;
  if (x402Enabled && parseBool(x402Enabled)) {
    const usdcAddr = env.X402_USDC_ADDRESS;
    if (!usdcAddr) {
      errors.push({
        variable: 'X402_USDC_ADDRESS',
        message: 'Required when X402_ENABLED is true.',
      });
    } else if (!isValidEthAddress(usdcAddr)) {
      errors.push({
        variable: 'X402_USDC_ADDRESS',
        message: `Invalid Ethereum address: "${usdcAddr}". Must be a 0x-prefixed 40-character hex string.`,
      });
    }

    const payTo = env.X402_PAY_TO;
    if (payTo && !isValidEthAddress(payTo)) {
      errors.push({
        variable: 'X402_PAY_TO',
        message: `Invalid Ethereum address: "${payTo}". Must be a 0x-prefixed 40-character hex string.`,
      });
    }

    const validityPeriod = env.X402_VALIDITY_PERIOD;
    if (validityPeriod) {
      const period = parseInt(validityPeriod, 10);
      if (isNaN(period) || period < 1) {
        errors.push({
          variable: 'X402_VALIDITY_PERIOD',
          message: `Invalid validity period: "${validityPeriod}". Must be a positive integer (seconds).`,
        });
      }
    }
  }

  return errors;
}

// ===========================================================================
// Helpers
// ===========================================================================

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidEthAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isValidPrivateKey(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return value.toLowerCase() === 'true' || value === '1' || value.toLowerCase() === 'yes';
}
