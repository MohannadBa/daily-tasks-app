import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

/**
 * Stable machine-readable error codes. Every error response is
 *   { statusCode, error, message, code }
 * (`message` may be a string or, for validation errors, a list of strings).
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  INVALID_STATE: 'INVALID_STATE',
  PENDING_EXISTS: 'PENDING_EXISTS',
  TRANSFER_CHAIN_INVALID: 'TRANSFER_CHAIN_INVALID',
  ASSIGNEE_NOT_ELIGIBLE: 'ASSIGNEE_NOT_ELIGIBLE',
  DEPARTMENT_INACTIVE: 'DEPARTMENT_INACTIVE',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  RATE_LIMITED: 'RATE_LIMITED',
  ACCESS_RESTRICTED: 'ACCESS_RESTRICTED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const defaultCode = (status: number): ErrorCode => {
  switch (status) {
    case 400:
      return ErrorCode.VALIDATION_FAILED;
    case 401:
      return ErrorCode.UNAUTHENTICATED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 429:
      return ErrorCode.RATE_LIMITED;
    case 501:
      return ErrorCode.NOT_IMPLEMENTED;
    default:
      return status >= 500 ? ErrorCode.INTERNAL : ErrorCode.VALIDATION_FAILED;
  }
};

/** Throwable with an explicit code. */
export class AppError extends HttpException {
  constructor(status: number, code: ErrorCode, message: string) {
    super({ statusCode: status, error: HttpStatus[status] ?? 'Error', message, code }, status);
  }
}

export const conflict = (code: ErrorCode, message: string) => new AppError(409, code, message);
export const badRequest = (code: ErrorCode, message: string) => new AppError(400, code, message);
export const forbidden = (message: string, code: ErrorCode = ErrorCode.FORBIDDEN) => new AppError(403, code, message);
export const notFound = (message: string) => new AppError(404, ErrorCode.NOT_FOUND, message);

/** Normalises every HttpException into the documented shape (adds `code` when missing). */
@Catch(HttpException)
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    const body = exception.getResponse();
    const obj = typeof body === 'string' ? { message: body } : (body as Record<string, unknown>);
    res.status(status).json({
      statusCode: status,
      error: (obj.error as string) ?? HttpStatus[status] ?? 'Error',
      message: obj.message ?? exception.message,
      code: (obj.code as string) ?? defaultCode(status),
    });
  }
}
