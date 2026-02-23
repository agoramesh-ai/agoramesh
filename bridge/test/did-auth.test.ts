/**
 * DID:key Authentication Tests
 *
 * Tests for Ed25519-based DID:key identity and request signing.
 * DID:key format: did:key:z6Mk... (multicodec ed25519-pub + base58btc)
 */

import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { base58btc } from 'multiformats/bases/base58';
import {
  parseDIDKey,
  verifyDIDSignature,
  isDIDAuthHeader,
  parseDIDAuthHeader,
} from '../src/did-auth.js';

// ============================================================================
// Helpers — generate a real did:key from an Ed25519 keypair
// ============================================================================

function generateTestDID() {
  const privKey = ed25519.utils.randomPrivateKey();
  const pubKey = ed25519.getPublicKey(privKey);

  // did:key format: multicodec prefix 0xed01 + raw 32-byte pubkey → base58btc
  const multicodec = new Uint8Array(2 + 32);
  multicodec[0] = 0xed;
  multicodec[1] = 0x01;
  multicodec.set(pubKey, 2);
  const did = `did:key:${base58btc.encode(multicodec)}`;

  return { privKey, pubKey, did };
}

function signRequest(
  privKey: Uint8Array,
  timestamp: string,
  method: string,
  path: string,
): string {
  const message = `${timestamp}:${method}:${path}`;
  const msgBytes = new TextEncoder().encode(message);
  const sig = ed25519.sign(msgBytes, privKey);
  // base64url encode
  return Buffer.from(sig).toString('base64url');
}

function nowTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

// ============================================================================
// parseDIDKey
// ============================================================================

describe('parseDIDKey', () => {
  it('extracts Ed25519 public key from a valid did:key', () => {
    const { pubKey, did } = generateTestDID();
    const extracted = parseDIDKey(did);
    expect(extracted).toEqual(pubKey);
  });

  it('throws for a did:key with wrong multicodec prefix', () => {
    // Build a did:key with a wrong prefix (0xec01 instead of 0xed01)
    const pubKey = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
    const bad = new Uint8Array(2 + 32);
    bad[0] = 0xec;
    bad[1] = 0x01;
    bad.set(pubKey, 2);
    const did = `did:key:${base58btc.encode(bad)}`;

    expect(() => parseDIDKey(did)).toThrow(/not an Ed25519/);
  });

  it('throws for a non-did:key DID', () => {
    expect(() => parseDIDKey('did:web:example.com')).toThrow(/did:key/);
  });

  it('throws for an invalid base58btc encoding', () => {
    expect(() => parseDIDKey('did:key:z0000')).toThrow();
  });

  it('throws for empty DID', () => {
    expect(() => parseDIDKey('')).toThrow();
  });

  it('throws for did:key with wrong byte length', () => {
    // Only 10 bytes instead of 34 (2 prefix + 32 pubkey)
    const short = new Uint8Array(10);
    short[0] = 0xed;
    short[1] = 0x01;
    const did = `did:key:${base58btc.encode(short)}`;

    expect(() => parseDIDKey(did)).toThrow(/invalid.*length/i);
  });
});

// ============================================================================
// verifyDIDSignature
// ============================================================================

describe('verifyDIDSignature', () => {
  it('verifies a valid signature', () => {
    const { privKey, did } = generateTestDID();
    const ts = nowTimestamp();
    const sig = signRequest(privKey, ts, 'POST', '/task');

    const valid = verifyDIDSignature(did, ts, 'POST', '/task', sig);
    expect(valid).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const { privKey, did } = generateTestDID();
    const ts = nowTimestamp();
    const sig = signRequest(privKey, ts, 'POST', '/task');

    // Tamper by flipping a byte near the middle of the raw signature
    const sigBytes = Buffer.from(sig, 'base64url');
    sigBytes[16] ^= 0xff; // flip all bits of byte 16
    const tampered = sigBytes.toString('base64url');
    const valid = verifyDIDSignature(did, ts, 'POST', '/task', tampered);
    expect(valid).toBe(false);
  });

  it('rejects when signed with a different key', () => {
    const { did } = generateTestDID();
    const otherKey = ed25519.utils.randomPrivateKey();
    const ts = nowTimestamp();
    const sig = signRequest(otherKey, ts, 'POST', '/task');

    const valid = verifyDIDSignature(did, ts, 'POST', '/task', sig);
    expect(valid).toBe(false);
  });

  it('rejects when method differs from what was signed', () => {
    const { privKey, did } = generateTestDID();
    const ts = nowTimestamp();
    const sig = signRequest(privKey, ts, 'POST', '/task');

    const valid = verifyDIDSignature(did, ts, 'GET', '/task', sig);
    expect(valid).toBe(false);
  });

  it('rejects when path differs from what was signed', () => {
    const { privKey, did } = generateTestDID();
    const ts = nowTimestamp();
    const sig = signRequest(privKey, ts, 'POST', '/task');

    const valid = verifyDIDSignature(did, ts, 'POST', '/other', sig);
    expect(valid).toBe(false);
  });

  it('rejects an expired timestamp (>5 minutes old)', () => {
    const { privKey, did } = generateTestDID();
    // 6 minutes ago
    const ts = String(Math.floor(Date.now() / 1000) - 360);
    const sig = signRequest(privKey, ts, 'POST', '/task');

    const valid = verifyDIDSignature(did, ts, 'POST', '/task', sig);
    expect(valid).toBe(false);
  });

  it('accepts a timestamp within 5-minute window', () => {
    const { privKey, did } = generateTestDID();
    // 4 minutes ago — within window
    const ts = String(Math.floor(Date.now() / 1000) - 240);
    const sig = signRequest(privKey, ts, 'POST', '/task');

    const valid = verifyDIDSignature(did, ts, 'POST', '/task', sig);
    expect(valid).toBe(true);
  });

  it('rejects a future timestamp (>30 seconds ahead)', () => {
    const { privKey, did } = generateTestDID();
    // 60 seconds in the future
    const ts = String(Math.floor(Date.now() / 1000) + 60);
    const sig = signRequest(privKey, ts, 'POST', '/task');

    const valid = verifyDIDSignature(did, ts, 'POST', '/task', sig);
    expect(valid).toBe(false);
  });
});

// ============================================================================
// isDIDAuthHeader
// ============================================================================

describe('isDIDAuthHeader', () => {
  it('returns true for "DID " prefix', () => {
    expect(isDIDAuthHeader('DID did:key:z6Mk...:12345:sig')).toBe(true);
  });

  it('returns false for "Bearer " prefix', () => {
    expect(isDIDAuthHeader('Bearer some-token')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isDIDAuthHeader('')).toBe(false);
  });

  it('is case-sensitive — "did " does not match', () => {
    expect(isDIDAuthHeader('did did:key:z6Mk...:12345:sig')).toBe(false);
  });
});

// ============================================================================
// parseDIDAuthHeader
// ============================================================================

describe('parseDIDAuthHeader', () => {
  it('parses a well-formed DID auth header', () => {
    const header = 'DID did:key:z6MkTest:1700000000:c2lnbmF0dXJl';
    const parsed = parseDIDAuthHeader(header);

    expect(parsed.did).toBe('did:key:z6MkTest');
    expect(parsed.timestamp).toBe('1700000000');
    expect(parsed.signature).toBe('c2lnbmF0dXJl');
  });

  it('throws for header without DID prefix', () => {
    expect(() => parseDIDAuthHeader('Bearer token')).toThrow(/DID/);
  });

  it('throws for header with missing parts (no signature separator)', () => {
    // Only one colon-separated segment after "DID " — no way to extract timestamp + sig
    expect(() => parseDIDAuthHeader('DID noseparator')).toThrow();
  });

  it('correctly handles did:key containing colons', () => {
    // did:key:z6MkABC has 3 colon-separated parts in the DID itself
    const header = 'DID did:key:z6MkABC:1700000000:c2lnbmF0dXJl';
    const parsed = parseDIDAuthHeader(header);

    expect(parsed.did).toBe('did:key:z6MkABC');
    expect(parsed.timestamp).toBe('1700000000');
    expect(parsed.signature).toBe('c2lnbmF0dXJl');
  });
});
