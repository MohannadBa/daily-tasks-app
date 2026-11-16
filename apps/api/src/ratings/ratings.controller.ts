import { Controller, Get, Module, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@dailytasks/database';
import { performanceQuerySchema, ratingSchema, type z } from '@dailytasks/validation';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { RatingsService } from './ratings.service';

/**
 * All rating endpoints are restricted at two levels:
 *  1. @Roles: EMPLOYEE accounts are rejected with 403 before any handler runs.
 *  2. RatingsService checks project-level manager access for the specific task/employee.
 */
@ApiTags('ratings')
@ApiBearerAuth()
@Roles(UserRole.COMPANY_ADMIN, UserRole.PROJECT_MANAGER)
@Controller()
export class RatingsController {
  constructor(private readonly ratings: RatingsService) {}

  @Get('tasks/:id/rating')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.ratings.getForTask(user, id);
  }

  @Put('tasks/:id/rating')
  @ApiZodBody(ratingSchema)
  rate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @ZBody(ratingSchema) body: z.infer<typeof ratingSchema>) {
    return this.ratings.rate(user, id, body);
  }

  @Get('performance/employees')
  employees(@CurrentUser() user: AuthUser, @ZQuery(performanceQuerySchema) q: z.infer<typeof performanceQuerySchema>) {
    return this.ratings.employeeSummaries(user, q.projectId);
  }

  @Get('performance/employees/:userId')
  employee(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @ZQuery(performanceQuerySchema) q: z.infer<typeof performanceQuerySchema>,
  ) {
    return this.ratings.employeeDetail(user, userId, q.projectId);
  }
}

@Module({ controllers: [RatingsController], providers: [RatingsService], exports: [RatingsService] })
export class RatingsModule {}
