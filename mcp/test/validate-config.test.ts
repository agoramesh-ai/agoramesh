/**
 * MCP Config Validation Tests
 */

import { describe, it, expect } from 'vitest';
import { validateMcpConfig } from '../src/validate-config.js';

describe('validateMcpConfig', () => {
  it('returns no errors for empty env (all defaults)', () => {
    const errors = validateMcpConfig({});
    expect(errors).toEqual([]);
  });

  it('returns no errors for valid env vars', () => {
    const errors = validateMcpConfig({
      AGORAMESH_NODE_URL: 'https://api.agoramesh.ai',
      AGORAMESH_BRIDGE_URL: 'http://localhost:3402',
      AGORAMESH_MCP_PORT: '3401',
      AGORAMESH_PUBLIC_URL: 'https://api.agoramesh.ai',
    });
    expect(errors).toEqual([]);
  });

  // ===========================================================================
  // URL validation
  // ===========================================================================

  describe('URL validation', () => {
    it('rejects invalid AGORAMESH_NODE_URL', () => {
      const errors = validateMcpConfig({ AGORAMESH_NODE_URL: 'not-a-url' });
      expect(errors).toHaveLength(1);
      expect(errors[0].variable).toBe('AGORAMESH_NODE_URL');
      expect(errors[0].message).toContain('Invalid URL');
    });

    it('rejects non-HTTP URL for AGORAMESH_NODE_URL', () => {
      const errors = validateMcpConfig({ AGORAMESH_NODE_URL: 'ftp://example.com' });
      expect(errors).toHaveLength(1);
      expect(errors[0].variable).toBe('AGORAMESH_NODE_URL');
    });

    it('rejects invalid AGORAMESH_BRIDGE_URL', () => {
      const errors = validateMcpConfig({ AGORAMESH_BRIDGE_URL: 'invalid' });
      expect(errors).toHaveLength(1);
      expect(errors[0].variable).toBe('AGORAMESH_BRIDGE_URL');
    });

    it('rejects invalid AGORAMESH_PUBLIC_URL', () => {
      const errors = validateMcpConfig({ AGORAMESH_PUBLIC_URL: '://broken' });
      expect(errors).toHaveLength(1);
      expect(errors[0].variable).toBe('AGORAMESH_PUBLIC_URL');
    });

    it('accepts http and https URLs', () => {
      const errors = validateMcpConfig({
        AGORAMESH_NODE_URL: 'http://localhost:8080',
        AGORAMESH_BRIDGE_URL: 'https://bridge.example.com',
      });
      expect(errors).toEqual([]);
    });
  });

  // ===========================================================================
  // Port validation
  // ===========================================================================

  describe('port validation', () => {
    it('rejects non-numeric port', () => {
      const errors = validateMcpConfig({ AGORAMESH_MCP_PORT: 'abc' });
      expect(errors).toHaveLength(1);
      expect(errors[0].variable).toBe('AGORAMESH_MCP_PORT');
      expect(errors[0].message).toContain('Invalid port');
    });

    it('rejects port 0', () => {
      const errors = validateMcpConfig({ AGORAMESH_MCP_PORT: '0' });
      expect(errors).toHaveLength(1);
      expect(errors[0].variable).toBe('AGORAMESH_MCP_PORT');
    });

    it('rejects port above 65535', () => {
      const errors = validateMcpConfig({ AGORAMESH_MCP_PORT: '70000' });
      expect(errors).toHaveLength(1);
      expect(errors[0].variable).toBe('AGORAMESH_MCP_PORT');
    });

    it('rejects negative port', () => {
      const errors = validateMcpConfig({ AGORAMESH_MCP_PORT: '-1' });
      expect(errors).toHaveLength(1);
      expect(errors[0].variable).toBe('AGORAMESH_MCP_PORT');
    });

    it('accepts valid port numbers', () => {
      expect(validateMcpConfig({ AGORAMESH_MCP_PORT: '1' })).toEqual([]);
      expect(validateMcpConfig({ AGORAMESH_MCP_PORT: '3401' })).toEqual([]);
      expect(validateMcpConfig({ AGORAMESH_MCP_PORT: '65535' })).toEqual([]);
    });
  });

  // ===========================================================================
  // Multiple errors
  // ===========================================================================

  describe('multiple errors', () => {
    it('reports all errors at once', () => {
      const errors = validateMcpConfig({
        AGORAMESH_NODE_URL: 'bad',
        AGORAMESH_MCP_PORT: 'xyz',
        AGORAMESH_PUBLIC_URL: 'also-bad',
      });
      expect(errors).toHaveLength(3);
      const vars = errors.map((e) => e.variable);
      expect(vars).toContain('AGORAMESH_NODE_URL');
      expect(vars).toContain('AGORAMESH_MCP_PORT');
      expect(vars).toContain('AGORAMESH_PUBLIC_URL');
    });
  });
});
