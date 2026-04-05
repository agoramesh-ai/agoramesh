/**
 * AgoraMesh Bridge Error Types
 *
 * Bridge-specific error subclasses using the SDK's AgoraMeshErrorCode
 * as the single source of truth for error codes.
 */

import { AgoraMeshError, AgoraMeshErrorCode } from '@agoramesh/sdk';

// Re-export SDK error types so bridge consumers can use them directly
export { AgoraMeshError, AgoraMeshErrorCode };

/**
 * Error thrown when an escrow is not found.
 */
export class EscrowNotFoundError extends AgoraMeshError {
  constructor(
    public readonly escrowId: string,
    cause?: Error
  ) {
    super(
      AgoraMeshErrorCode.ESCROW_NOT_FOUND,
      `Escrow not found: ${escrowId}`,
      { escrowId },
      cause,
    );
    this.name = 'EscrowNotFoundError';
  }
}

/**
 * Error thrown when an escrow operation fails.
 */
export class EscrowOperationError extends AgoraMeshError {
  constructor(
    message: string,
    public readonly operation: string,
    cause?: Error
  ) {
    super(
      AgoraMeshErrorCode.ESCROW_OPERATION_FAILED,
      message,
      { operation },
      cause,
    );
    this.name = 'EscrowOperationError';
  }
}

/**
 * Error thrown when payment validation fails.
 */
export class PaymentValidationError extends AgoraMeshError {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
    cause?: Error
  ) {
    super(
      AgoraMeshErrorCode.PAYMENT_VALIDATION_FAILED,
      message,
      details,
      cause,
    );
    this.name = 'PaymentValidationError';
  }
}

/**
 * Error thrown when payment parsing fails.
 */
export class PaymentParseError extends AgoraMeshError {
  constructor(
    message: string,
    public readonly rawPayload?: string,
    cause?: Error
  ) {
    super(
      AgoraMeshErrorCode.PAYMENT_PARSE_FAILED,
      message,
      rawPayload ? { rawPayload } : undefined,
      cause,
    );
    this.name = 'PaymentParseError';
  }
}

/**
 * Error thrown when agent registration fails.
 */
export class RegistrationError extends AgoraMeshError {
  constructor(
    message: string,
    public readonly did: string,
    cause?: Error
  ) {
    super(
      AgoraMeshErrorCode.REGISTRATION_FAILED,
      message,
      { did },
      cause,
    );
    this.name = 'RegistrationError';
  }
}

/**
 * Result type for operations that can fail or indicate special conditions.
 */
export type Result<T, E = AgoraMeshError> =
  | { success: true; value: T }
  | { success: false; error: E };

/**
 * Helper function to create a success result.
 */
export function success<T>(value: T): Result<T, never> {
  return { success: true, value };
}

/**
 * Helper function to create a failure result.
 */
export function failure<E>(error: E): Result<never, E> {
  return { success: false, error };
}

/**
 * Type guard to check if result is success.
 */
export function isSuccess<T, E>(result: Result<T, E>): result is { success: true; value: T } {
  return result.success;
}

/**
 * Type guard to check if result is failure.
 */
export function isFailure<T, E>(result: Result<T, E>): result is { success: false; error: E } {
  return !result.success;
}
