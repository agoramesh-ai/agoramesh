/**
 * AgoraMesh Bridge Error Types
 *
 * Provides typed errors for better debugging and error recovery.
 */

/**
 * Base class for all AgoraMesh bridge errors.
 */
export class AgoraMeshError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'AgoraMeshError';
  }
}

/**
 * Error thrown when an escrow is not found.
 */
export class EscrowNotFoundError extends AgoraMeshError {
  constructor(
    public readonly escrowId: string,
    cause?: Error
  ) {
    super(`Escrow not found: ${escrowId}`, 'ESCROW_NOT_FOUND', cause);
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
    super(message, 'ESCROW_OPERATION_FAILED', cause);
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
    super(message, 'PAYMENT_VALIDATION_FAILED', cause);
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
    super(message, 'PAYMENT_PARSE_FAILED', cause);
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
    super(message, 'REGISTRATION_FAILED', cause);
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
