/**
 * Bridge Error Types and Result Pattern Tests
 *
 * Tests for the typed error hierarchy and Result monad helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  AgentMeError,
  EscrowNotFoundError,
  EscrowOperationError,
  PaymentValidationError,
  PaymentParseError,
  RegistrationError,
  success,
  failure,
  isSuccess,
  isFailure,
  type Result,
} from '../src/errors.js';

// =============================================================================
// Error Type Tests
// =============================================================================

describe('AgentMeError', () => {
  it('should set message, code, and name', () => {
    const err = new AgentMeError('test error', 'TEST_CODE');
    expect(err.message).toBe('test error');
    expect(err.code).toBe('TEST_CODE');
    expect(err.name).toBe('AgentMeError');
    expect(err instanceof Error).toBe(true);
  });

  it('should store cause', () => {
    const cause = new Error('root cause');
    const err = new AgentMeError('wrapper', 'WRAP', cause);
    expect(err.cause).toBe(cause);
  });
});

describe('EscrowNotFoundError', () => {
  it('should include escrow ID in message', () => {
    const err = new EscrowNotFoundError('42');
    expect(err.message).toContain('42');
    expect(err.escrowId).toBe('42');
    expect(err.code).toBe('ESCROW_NOT_FOUND');
    expect(err.name).toBe('EscrowNotFoundError');
  });

  it('should be an instance of AgentMeError', () => {
    const err = new EscrowNotFoundError('1');
    expect(err instanceof AgentMeError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});

describe('EscrowOperationError', () => {
  it('should store operation name', () => {
    const err = new EscrowOperationError('failed to fund', 'fundEscrow');
    expect(err.operation).toBe('fundEscrow');
    expect(err.code).toBe('ESCROW_OPERATION_FAILED');
    expect(err.name).toBe('EscrowOperationError');
  });

  it('should store cause error', () => {
    const cause = new Error('network timeout');
    const err = new EscrowOperationError('failed', 'getEscrow', cause);
    expect(err.cause).toBe(cause);
  });
});

describe('PaymentValidationError', () => {
  it('should store details', () => {
    const details = { amount: '100', expected: '200' };
    const err = new PaymentValidationError('insufficient', details);
    expect(err.details).toEqual(details);
    expect(err.code).toBe('PAYMENT_VALIDATION_FAILED');
    expect(err.name).toBe('PaymentValidationError');
  });
});

describe('PaymentParseError', () => {
  it('should store raw payload', () => {
    const err = new PaymentParseError('invalid JSON', 'not-json');
    expect(err.rawPayload).toBe('not-json');
    expect(err.code).toBe('PAYMENT_PARSE_FAILED');
    expect(err.name).toBe('PaymentParseError');
  });
});

describe('RegistrationError', () => {
  it('should store DID', () => {
    const err = new RegistrationError('already registered', 'did:agentme:base:agent1');
    expect(err.did).toBe('did:agentme:base:agent1');
    expect(err.code).toBe('REGISTRATION_FAILED');
    expect(err.name).toBe('RegistrationError');
  });
});

// =============================================================================
// Result Pattern Tests
// =============================================================================

describe('Result pattern', () => {
  describe('success()', () => {
    it('should create a success result', () => {
      const result = success(42);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe(42);
      }
    });

    it('should work with complex types', () => {
      const data = { id: 1n, name: 'test' };
      const result = success(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe(data);
      }
    });
  });

  describe('failure()', () => {
    it('should create a failure result', () => {
      const err = new EscrowNotFoundError('99');
      const result = failure(err);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(err);
      }
    });
  });

  describe('isSuccess()', () => {
    it('should return true for success result', () => {
      const result: Result<number> = success(42);
      expect(isSuccess(result)).toBe(true);
    });

    it('should return false for failure result', () => {
      const result: Result<number> = failure(new AgentMeError('err', 'ERR'));
      expect(isSuccess(result)).toBe(false);
    });
  });

  describe('isFailure()', () => {
    it('should return true for failure result', () => {
      const result: Result<number> = failure(new AgentMeError('err', 'ERR'));
      expect(isFailure(result)).toBe(true);
    });

    it('should return false for success result', () => {
      const result: Result<number> = success(42);
      expect(isFailure(result)).toBe(false);
    });
  });

  describe('type narrowing', () => {
    it('should narrow to value on isSuccess', () => {
      const result: Result<string, AgentMeError> = success('hello');
      if (isSuccess(result)) {
        // TypeScript should narrow result to { success: true, value: string }
        expect(result.value).toBe('hello');
      }
    });

    it('should narrow to error on isFailure', () => {
      const err = new EscrowNotFoundError('1');
      const result: Result<string, EscrowNotFoundError> = failure(err);
      if (isFailure(result)) {
        // TypeScript should narrow result to { success: false, error: EscrowNotFoundError }
        expect(result.error.escrowId).toBe('1');
      }
    });
  });
});
