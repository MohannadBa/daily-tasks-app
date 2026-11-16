import { applyDecorators, BadRequestException, Body, PipeTransform, Query } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import type { ZodTypeAny, z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: result.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)),
      });
    }
    return result.data;
  }
}

/** Parameter decorator: validated request body. */
export const ZBody = <T extends ZodTypeAny>(schema: T) => Body(new ZodValidationPipe(schema));
/** Parameter decorator: validated query string. */
export const ZQuery = <T extends ZodTypeAny>(schema: T) => Query(new ZodValidationPipe(schema));

/** Method decorator: documents a zod body schema in Swagger. */
export const ApiZodBody = (schema: ZodTypeAny) =>
  applyDecorators(ApiBody({ schema: zodToJsonSchema(schema as never, { target: 'openApi3', $refStrategy: 'none' }) as object }));
