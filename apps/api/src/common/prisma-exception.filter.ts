import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@dailytasks/database';
import type { Response } from 'express';

/** Maps well-known Prisma errors to HTTP responses without leaking internals. */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Prisma');
  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    switch (exception.code) {
      case 'P2002':
        return res.status(HttpStatus.CONFLICT).json({ statusCode: 409, error: 'Conflict', message: 'Resource already exists', code: 'CONFLICT' });
      case 'P2025':
        return res.status(HttpStatus.NOT_FOUND).json({ statusCode: 404, error: 'Not Found', message: 'Resource not found', code: 'NOT_FOUND' });
      case 'P2003':
        return res.status(HttpStatus.BAD_REQUEST).json({ statusCode: 400, error: 'Bad Request', message: 'Invalid reference', code: 'VALIDATION_FAILED' });
      default:
        this.logger.error(`Unhandled Prisma error ${exception.code}`);
        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, error: 'Internal Server Error', message: 'Internal server error', code: 'INTERNAL' });
    }
  }
}
