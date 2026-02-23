/**
 * DID:key Authentication
 *
 * Implements Ed25519-based DID:key identity verification for the free tier.
 * Any agent that can generate an Ed25519 keypair gets a DID:key identity
 * without needing a blockchain, registry, or pre-existing account.
 *
 * DID:key format: did:key:z6Mk... (multicodec 0xed01 + ed25519 pubkey, base58btc encoded)
 * Auth header:    Authorization: DID <did>:<timestamp>:<base64url-signature>
 * Signed message: <timestamp>:<HTTP-METHOD>:<path>
 */

import { ed25519 } from '@noble/curves/ed25519';
import { base58btc } from 'multiformats/bases/base58';

/** Maximum clock skew tolerance: 5 minutes into the past */
const MAX_AGE_SECONDS = 300;

/** Maximum clock skew tolerance: 30 seconds into the future */
const MAX_FUTURE_SECONDS = 30;

/** Ed25519 multicodec prefix bytes */
const ED25519_MULTICODEC_PREFIX_0 = 0xed;
const ED25519_MULTICODEC_PREFIX_1 = 0x01;

/** Expected total bytes: 2 (prefix) + 32 (ed25519 public key) */
const EXPECTED_MULTICODEC_LENGTH = 34;

/**
 * Extract the raw Ed25519 public key from a did:key string.
 *
 * @param did - A DID in did:key format (e.g., "did:key:z6Mk...")
 * @returns The 32-byte Ed25519 public key
 * @throws If the DID is not a valid did:key with Ed25519 public key
 */
export function parseDIDKey(did: string): Uint8Array {
  if (!did.startsWith('did:key:')) {
    throw new Error('Expected a did:key DID');
  }

  const multibase = did.slice('did:key:'.length);
  const bytes = base58btc.decode(multibase);

  if (bytes.length !== EXPECTED_MULTICODEC_LENGTH) {
    throw new Error(
      `Invalid did:key length: expected ${EXPECTED_MULTICODEC_LENGTH} bytes, got ${bytes.length}`,
    );
  }

  if (
    bytes[0] !== ED25519_MULTICODEC_PREFIX_0 ||
    bytes[1] !== ED25519_MULTICODEC_PREFIX_1
  ) {
    throw new Error(
      `DID key is not an Ed25519 key (multicodec prefix: 0x${bytes[0].toString(16)}${bytes[1].toString(16)})`,
    );
  }

  return bytes.slice(2);
}

/**
 * Verify an Ed25519 signature over a request.
 *
 * The signed message format is: `<timestamp>:<HTTP-METHOD>:<path>`
 * Rejects timestamps older than 5 minutes (replay protection) or
 * more than 30 seconds in the future (clock skew tolerance).
 *
 * @param did - The did:key of the signer
 * @param timestamp - Unix timestamp string from the auth header
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - Request path (e.g., /task)
 * @param signature - Base64url-encoded Ed25519 signature
 * @returns true if the signature is valid and the timestamp is within the window
 */
export function verifyDIDSignature(
  did: string,
  timestamp: string,
  method: string,
  path: string,
  signature: string,
): boolean {
  // Check timestamp freshness
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (now - ts > MAX_AGE_SECONDS) return false;
  if (ts - now > MAX_FUTURE_SECONDS) return false;

  try {
    const pubKey = parseDIDKey(did);
    const message = `${timestamp}:${method}:${path}`;
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = Buffer.from(signature, 'base64url');

    return ed25519.verify(sigBytes, msgBytes, pubKey);
  } catch {
    return false;
  }
}

/**
 * Check if an Authorization header value uses the DID auth scheme.
 *
 * @param header - The Authorization header value
 * @returns true if the header starts with "DID "
 */
export function isDIDAuthHeader(header: string): boolean {
  return header.startsWith('DID ');
}

/**
 * Parse a DID auth header into its components.
 *
 * Format: "DID <did>:<timestamp>:<signature>"
 * The DID itself contains colons (e.g., did:key:z6Mk...), so we parse
 * from the end: the last two colon-separated parts are timestamp and signature.
 *
 * @param header - The Authorization header value (must start with "DID ")
 * @returns Parsed components: { did, timestamp, signature }
 * @throws If the header format is invalid
 */
export function parseDIDAuthHeader(header: string): {
  did: string;
  timestamp: string;
  signature: string;
} {
  if (!isDIDAuthHeader(header)) {
    throw new Error('Authorization header must start with "DID "');
  }

  const payload = header.slice('DID '.length);

  // Parse from the end: last part is signature, second-to-last is timestamp
  const lastColon = payload.lastIndexOf(':');
  if (lastColon === -1) {
    throw new Error('Invalid DID auth header: missing signature');
  }

  const signature = payload.slice(lastColon + 1);
  const rest = payload.slice(0, lastColon);

  const secondLastColon = rest.lastIndexOf(':');
  if (secondLastColon === -1) {
    throw new Error('Invalid DID auth header: missing timestamp');
  }

  const timestamp = rest.slice(secondLastColon + 1);
  const did = rest.slice(0, secondLastColon);

  if (!did || !timestamp || !signature) {
    throw new Error('Invalid DID auth header: missing components');
  }

  return { did, timestamp, signature };
}
