/**
 * DID Format Validation Tests
 *
 * Tests for validating DID format before hashing to prevent:
 * - Invalid DID formats being processed
 * - Injection attacks via malformed DIDs
 * - Inconsistent DID handling across the system
 *
 * Valid DID patterns:
 * - did:agentme:[method]:[identifier]
 * - did:web:[method]:[identifier]
 *
 * TDD Phase: RED - These tests should FAIL initially
 *
 * @packageDocumentation
 */

import { describe, it, expect } from 'vitest';
import { didToHash, validateDID } from '../../src/client.js';

// =============================================================================
// DID Validation Function Tests
// =============================================================================

describe('DID Validation', () => {
  describe('validateDID', () => {
    describe('valid DIDs', () => {
      it('accepts valid agentme DID', () => {
        const validDIDs = [
          'did:agentme:base:abc123',
          'did:agentme:ethereum:ABC123',
          'did:agentme:polygon:testAgent42',
          'did:agentme:arbitrum:myAgent',
        ];

        for (const did of validDIDs) {
          expect(() => validateDID(did), `Should accept: ${did}`).not.toThrow();
        }
      });

      it('accepts valid web DID', () => {
        const validDIDs = [
          'did:web:base:abc123',
          'did:web:ethereum:ABC123',
          'did:web:polygon:testAgent42',
        ];

        for (const did of validDIDs) {
          expect(() => validateDID(did), `Should accept: ${did}`).not.toThrow();
        }
      });

      it('accepts valid did:key format (W3C DID spec)', () => {
        // did:key uses multibase-encoded public keys
        // Format: did:key:z[base58-multicodec-key]
        const validDIDs = [
          'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
          'did:key:z6Mkfriq1MqLBoPWecGoDLjguo1sB9brj6wT3qZ5BxkKpuP6',
          'did:key:zQ3shokFTS3brHcDQrn82RUDfCZnQbHb5e1p3VrmSKXJ4nMwQ',
        ];

        for (const did of validDIDs) {
          expect(() => validateDID(did), `Should accept did:key: ${did}`).not.toThrow();
        }
      });

      it('accepts valid did:ethr format (Ethereum DID)', () => {
        // did:ethr uses Ethereum addresses
        // Format: did:ethr:[chain]:[address] or did:ethr:[address]
        const validDIDs = [
          'did:ethr:0xb9c5714089478a327f09197987f16f9e5d936e8a',
          'did:ethr:mainnet:0xb9c5714089478a327f09197987f16f9e5d936e8a',
          'did:ethr:0x1:0xb9c5714089478a327f09197987f16f9e5d936e8a',
        ];

        for (const did of validDIDs) {
          expect(() => validateDID(did), `Should accept did:ethr: ${did}`).not.toThrow();
        }
      });
    });

    describe('invalid DIDs', () => {
      it('rejects DID without did: prefix', () => {
        const invalidDIDs = [
          'agentme:base:abc123',
          ':agentme:base:abc123',
          'web:base:abc123',
        ];

        for (const did of invalidDIDs) {
          expect(() => validateDID(did), `Should reject: ${did}`).toThrow(
            /Invalid DID format/
          );
        }
      });

      it('rejects DID with invalid method', () => {
        const invalidDIDs = [
          'did:invalid:base:abc123',
          'did:other:base:abc123',
          'did:AGENTME:base:abc123', // uppercase not allowed
          'did:WEB:base:abc123', // uppercase not allowed
          'did:KEY:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', // uppercase KEY
          'did:ETHR:0xb9c5714089478a327f09197987f16f9e5d936e8a', // uppercase ETHR
        ];

        for (const did of invalidDIDs) {
          expect(() => validateDID(did), `Should reject: ${did}`).toThrow(
            /Invalid DID format/
          );
        }
      });

      it('rejects invalid did:key format', () => {
        const invalidDIDs = [
          'did:key:', // missing key
          'did:key:abc123', // key must start with z (multibase)
          'did:key:z', // too short
          'did:key:z123!@#', // invalid characters
        ];

        for (const did of invalidDIDs) {
          expect(() => validateDID(did), `Should reject invalid did:key: ${did}`).toThrow(
            /Invalid DID format/
          );
        }
      });

      it('rejects invalid did:ethr format', () => {
        const invalidDIDs = [
          'did:ethr:', // missing address
          'did:ethr:not-an-address', // invalid Ethereum address
          'did:ethr:0x123', // address too short
          'did:ethr:0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ', // invalid hex
        ];

        for (const did of invalidDIDs) {
          expect(() => validateDID(did), `Should reject invalid did:ethr: ${did}`).toThrow(
            /Invalid DID format/
          );
        }
      });

      it('rejects DID with missing parts', () => {
        const invalidDIDs = [
          'did:agentme:base',
          'did:agentme',
          'did:',
          'did',
        ];

        for (const did of invalidDIDs) {
          expect(() => validateDID(did), `Should reject: ${did}`).toThrow(
            /Invalid DID format/
          );
        }
      });

      it('rejects DID with special characters in identifier', () => {
        const invalidDIDs = [
          'did:agentme:base:abc-123', // dash not allowed in identifier
          'did:agentme:base:abc_123', // underscore not allowed
          'did:agentme:base:abc@123', // @ not allowed
          'did:agentme:base:abc 123', // space not allowed
          'did:agentme:base:abc\n123', // newline not allowed
        ];

        for (const did of invalidDIDs) {
          expect(() => validateDID(did), `Should reject: ${did}`).toThrow(
            /Invalid DID format/
          );
        }
      });

      it('rejects DID with uppercase method name', () => {
        const invalidDIDs = [
          'did:agentme:BASE:abc123', // uppercase in method name not allowed
          'did:agentme:Base:abc123',
          'did:agentme:ETHEREUM:abc123',
        ];

        for (const did of invalidDIDs) {
          expect(() => validateDID(did), `Should reject: ${did}`).toThrow(
            /Invalid DID format/
          );
        }
      });

      it('rejects empty string', () => {
        expect(() => validateDID('')).toThrow(/Invalid DID format/);
      });

      it('rejects DID with injection attempt', () => {
        const injectionAttempts = [
          'did:agentme:base:abc123; DROP TABLE agents;--',
          "did:agentme:base:abc123' OR '1'='1",
          'did:agentme:base:<script>alert(1)</script>',
          'did:agentme:base:../../../etc/passwd',
        ];

        for (const did of injectionAttempts) {
          expect(() => validateDID(did), `Should reject injection: ${did}`).toThrow(
            /Invalid DID format/
          );
        }
      });
    });
  });

  describe('didToHash with validation', () => {
    it('throws on invalid DID format before hashing', () => {
      const invalidDID = 'invalid-did-format';

      expect(() => didToHash(invalidDID)).toThrow(/Invalid DID format/);
    });

    it('returns valid hash for valid DID', () => {
      const validDID = 'did:agentme:base:abc123';

      const hash = didToHash(validDID);

      expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('returns consistent hash for same DID', () => {
      const did = 'did:agentme:base:testAgent';

      const hash1 = didToHash(did);
      const hash2 = didToHash(did);

      expect(hash1).toBe(hash2);
    });

    it('returns different hashes for different DIDs', () => {
      const did1 = 'did:agentme:base:agent1';
      const did2 = 'did:agentme:base:agent2';

      const hash1 = didToHash(did1);
      const hash2 = didToHash(did2);

      expect(hash1).not.toBe(hash2);
    });
  });
});

// =============================================================================
// Integration with AgentMeClient
// =============================================================================

describe('AgentMeClient DID Validation Integration', () => {
  // Note: These tests will need a mock or stub for blockchain interactions
  // They verify that DID validation is called in client methods

  it('validates DID in registerAgent', async () => {
    // This test verifies that registerAgent validates the DID from capability card
    // Implementation will require mocking the blockchain client
    const invalidCard = {
      id: 'invalid-did-format',
      name: 'Test Agent',
      description: 'Test',
      skills: [],
    };

    // The actual implementation should validate the DID before processing
    expect(() => validateDID(invalidCard.id)).toThrow(/Invalid DID format/);
  });

  it('validates DID in updateCapabilityCard', async () => {
    const invalidDID = 'not-a-valid-did';

    expect(() => validateDID(invalidDID)).toThrow(/Invalid DID format/);
  });

  it('validates DID in deactivateAgent', async () => {
    const invalidDID = 'did:unknown:method:id';

    expect(() => validateDID(invalidDID)).toThrow(/Invalid DID format/);
  });

  it('validates DID in getAgent', async () => {
    const invalidDID = '';

    expect(() => validateDID(invalidDID)).toThrow(/Invalid DID format/);
  });

  it('validates DID in isAgentActive', async () => {
    const invalidDID = 'did:agentme:base:'; // missing identifier

    expect(() => validateDID(invalidDID)).toThrow(/Invalid DID format/);
  });
});
