/**
 * Bridge Config Validation Tests
 */

import { describe, it, expect } from 'vitest';
import { validateBridgeConfig } from '../src/validate-config.js';

// Valid private key for testing (do NOT use in production)
const VALID_KEY = '0x' + 'ab'.repeat(32);
const VALID_ADDR = '0x' + 'ab'.repeat(20);

describe('validateBridgeConfig', () => {
  // =========================================================================
  // Required fields
  // =========================================================================

  describe('AGENT_PRIVATE_KEY', () => {
    it('errors when missing', () => {
      const errors = validateBridgeConfig({});
      const keyError = errors.find((e) => e.variable === 'AGENT_PRIVATE_KEY');
      expect(keyError).toBeDefined();
      expect(keyError!.message).toContain('Required');
    });

    it('errors for invalid format (no 0x prefix)', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: 'ab'.repeat(32) });
      const keyError = errors.find((e) => e.variable === 'AGENT_PRIVATE_KEY');
      expect(keyError).toBeDefined();
      expect(keyError!.message).toContain('Invalid format');
    });

    it('errors for too-short key', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: '0x1234' });
      const keyError = errors.find((e) => e.variable === 'AGENT_PRIVATE_KEY');
      expect(keyError).toBeDefined();
    });

    it('accepts valid 64-char hex key with 0x prefix', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY });
      const keyError = errors.find((e) => e.variable === 'AGENT_PRIVATE_KEY');
      expect(keyError).toBeUndefined();
    });
  });

  // =========================================================================
  // Port validation
  // =========================================================================

  describe('BRIDGE_PORT', () => {
    it('accepts valid port', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY, BRIDGE_PORT: '3402' });
      const portError = errors.find((e) => e.variable === 'BRIDGE_PORT');
      expect(portError).toBeUndefined();
    });

    it('rejects non-numeric port', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY, BRIDGE_PORT: 'abc' });
      const portError = errors.find((e) => e.variable === 'BRIDGE_PORT');
      expect(portError).toBeDefined();
      expect(portError!.message).toContain('Invalid port');
    });

    it('rejects port 0', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY, BRIDGE_PORT: '0' });
      const portError = errors.find((e) => e.variable === 'BRIDGE_PORT');
      expect(portError).toBeDefined();
    });

    it('rejects port > 65535', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY, BRIDGE_PORT: '99999' });
      const portError = errors.find((e) => e.variable === 'BRIDGE_PORT');
      expect(portError).toBeDefined();
    });
  });

  // =========================================================================
  // Numeric validations
  // =========================================================================

  describe('TASK_TIMEOUT', () => {
    it('accepts positive integer', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY, TASK_TIMEOUT: '300' });
      expect(errors.find((e) => e.variable === 'TASK_TIMEOUT')).toBeUndefined();
    });

    it('rejects non-numeric value', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY, TASK_TIMEOUT: 'abc' });
      expect(errors.find((e) => e.variable === 'TASK_TIMEOUT')).toBeDefined();
    });

    it('rejects zero', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY, TASK_TIMEOUT: '0' });
      expect(errors.find((e) => e.variable === 'TASK_TIMEOUT')).toBeDefined();
    });
  });

  describe('AGENT_PRICE_PER_TASK', () => {
    it('accepts valid price', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY, AGENT_PRICE_PER_TASK: '5.50' });
      expect(errors.find((e) => e.variable === 'AGENT_PRICE_PER_TASK')).toBeUndefined();
    });

    it('accepts zero price', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY, AGENT_PRICE_PER_TASK: '0' });
      expect(errors.find((e) => e.variable === 'AGENT_PRICE_PER_TASK')).toBeUndefined();
    });

    it('rejects negative price', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY, AGENT_PRICE_PER_TASK: '-5' });
      expect(errors.find((e) => e.variable === 'AGENT_PRICE_PER_TASK')).toBeDefined();
    });
  });

  // =========================================================================
  // URL validation
  // =========================================================================

  describe('AGORAMESH_NODE_URL', () => {
    it('accepts valid URL', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY, AGORAMESH_NODE_URL: 'https://api.agoramesh.ai' });
      expect(errors.find((e) => e.variable === 'AGORAMESH_NODE_URL')).toBeUndefined();
    });

    it('rejects invalid URL', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY, AGORAMESH_NODE_URL: 'not-a-url' });
      expect(errors.find((e) => e.variable === 'AGORAMESH_NODE_URL')).toBeDefined();
    });
  });

  // =========================================================================
  // Escrow config (all-or-nothing)
  // =========================================================================

  describe('escrow config', () => {
    it('accepts complete escrow config', () => {
      const errors = validateBridgeConfig({
        AGENT_PRIVATE_KEY: VALID_KEY,
        ESCROW_ADDRESS: VALID_ADDR,
        ESCROW_RPC_URL: 'https://sepolia.base.org',
        PROVIDER_DID: 'did:agoramesh:base:abc',
      });
      const escrowErrors = errors.filter((e) =>
        ['ESCROW_ADDRESS', 'ESCROW_RPC_URL', 'PROVIDER_DID'].includes(e.variable),
      );
      expect(escrowErrors).toHaveLength(0);
    });

    it('errors when ESCROW_ADDRESS is set without ESCROW_RPC_URL', () => {
      const errors = validateBridgeConfig({
        AGENT_PRIVATE_KEY: VALID_KEY,
        ESCROW_ADDRESS: VALID_ADDR,
      });
      expect(errors.find((e) => e.variable === 'ESCROW_RPC_URL')).toBeDefined();
      expect(errors.find((e) => e.variable === 'PROVIDER_DID')).toBeDefined();
    });

    it('errors when ESCROW_RPC_URL is set without ESCROW_ADDRESS', () => {
      const errors = validateBridgeConfig({
        AGENT_PRIVATE_KEY: VALID_KEY,
        ESCROW_RPC_URL: 'https://sepolia.base.org',
      });
      expect(errors.find((e) => e.variable === 'ESCROW_ADDRESS')).toBeDefined();
    });

    it('validates ESCROW_ADDRESS format', () => {
      const errors = validateBridgeConfig({
        AGENT_PRIVATE_KEY: VALID_KEY,
        ESCROW_ADDRESS: 'not-an-address',
        ESCROW_RPC_URL: 'https://sepolia.base.org',
        PROVIDER_DID: 'did:agoramesh:base:abc',
      });
      expect(errors.find((e) => e.variable === 'ESCROW_ADDRESS')).toBeDefined();
    });

    it('validates ESCROW_CHAIN_ID', () => {
      const errors = validateBridgeConfig({
        AGENT_PRIVATE_KEY: VALID_KEY,
        ESCROW_ADDRESS: VALID_ADDR,
        ESCROW_RPC_URL: 'https://sepolia.base.org',
        PROVIDER_DID: 'did:agoramesh:base:abc',
        ESCROW_CHAIN_ID: 'abc',
      });
      expect(errors.find((e) => e.variable === 'ESCROW_CHAIN_ID')).toBeDefined();
    });

    it('no escrow errors when none of the escrow vars are set', () => {
      const errors = validateBridgeConfig({ AGENT_PRIVATE_KEY: VALID_KEY });
      const escrowErrors = errors.filter((e) =>
        ['ESCROW_ADDRESS', 'ESCROW_RPC_URL', 'PROVIDER_DID', 'ESCROW_CHAIN_ID'].includes(e.variable),
      );
      expect(escrowErrors).toHaveLength(0);
    });
  });

  // =========================================================================
  // x402 config
  // =========================================================================

  describe('x402 config', () => {
    it('no errors when X402_ENABLED is false', () => {
      const errors = validateBridgeConfig({
        AGENT_PRIVATE_KEY: VALID_KEY,
        X402_ENABLED: 'false',
      });
      expect(errors.find((e) => e.variable === 'X402_USDC_ADDRESS')).toBeUndefined();
    });

    it('requires X402_USDC_ADDRESS when X402_ENABLED is true', () => {
      const errors = validateBridgeConfig({
        AGENT_PRIVATE_KEY: VALID_KEY,
        X402_ENABLED: 'true',
      });
      expect(errors.find((e) => e.variable === 'X402_USDC_ADDRESS')).toBeDefined();
    });

    it('validates X402_USDC_ADDRESS format', () => {
      const errors = validateBridgeConfig({
        AGENT_PRIVATE_KEY: VALID_KEY,
        X402_ENABLED: 'true',
        X402_USDC_ADDRESS: 'invalid',
      });
      expect(errors.find((e) => e.variable === 'X402_USDC_ADDRESS')).toBeDefined();
    });

    it('validates X402_PAY_TO format if set', () => {
      const errors = validateBridgeConfig({
        AGENT_PRIVATE_KEY: VALID_KEY,
        X402_ENABLED: 'true',
        X402_USDC_ADDRESS: VALID_ADDR,
        X402_PAY_TO: 'bad-address',
      });
      expect(errors.find((e) => e.variable === 'X402_PAY_TO')).toBeDefined();
    });

    it('validates X402_VALIDITY_PERIOD if set', () => {
      const errors = validateBridgeConfig({
        AGENT_PRIVATE_KEY: VALID_KEY,
        X402_ENABLED: 'true',
        X402_USDC_ADDRESS: VALID_ADDR,
        X402_VALIDITY_PERIOD: '-10',
      });
      expect(errors.find((e) => e.variable === 'X402_VALIDITY_PERIOD')).toBeDefined();
    });

    it('accepts valid x402 config', () => {
      const errors = validateBridgeConfig({
        AGENT_PRIVATE_KEY: VALID_KEY,
        X402_ENABLED: 'true',
        X402_USDC_ADDRESS: VALID_ADDR,
        X402_PAY_TO: VALID_ADDR,
        X402_VALIDITY_PERIOD: '300',
      });
      const x402Errors = errors.filter((e) => e.variable.startsWith('X402_'));
      expect(x402Errors).toHaveLength(0);
    });
  });

  // =========================================================================
  // Multiple errors
  // =========================================================================

  describe('multiple errors', () => {
    it('reports all errors at once', () => {
      const errors = validateBridgeConfig({
        BRIDGE_PORT: 'bad',
        TASK_TIMEOUT: 'bad',
        AGORAMESH_NODE_URL: 'bad',
      });
      // Should include AGENT_PRIVATE_KEY (missing) + 3 invalid values
      expect(errors.length).toBeGreaterThanOrEqual(4);
    });
  });
});
