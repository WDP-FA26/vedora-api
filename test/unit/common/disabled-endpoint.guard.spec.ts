import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ResourceNotFoundException } from '@src/common/exceptions/resource-not-found.exception.js';
import { DisabledEndpointGuard } from '@src/common/guards/disabled-endpoint.guard.js';
import { PublicConfigController } from '@src/config/public-config.controller.js';
import { UsersController } from '@src/users/users.controller.js';

describe('DisabledEndpointGuard', () => {
  it('throws 404 NOT_FOUND when invoked', () => {
    const guard = new DisabledEndpointGuard();
    expect(() => guard.canActivate()).toThrow(ResourceNotFoundException);
    expect(() => guard.canActivate()).toThrow('This endpoint is disabled');
  });

  it('soft-disables GET /public-config while keeping publicRuntimeConfig intact', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      PublicConfigController,
    ) as unknown[];
    const excluded = Reflect.getMetadata(
      'swagger/apiExcludeController',
      PublicConfigController,
    ) as unknown;

    expect(guards).toContain(DisabledEndpointGuard);
    expect(excluded).toEqual([true]);
  });

  it('soft-disables POST /users and DELETE /users/:id while keeping handlers intact', () => {
    const createGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      UsersController.prototype.create,
    ) as unknown[];
    const removeGuards = Reflect.getMetadata(
      GUARDS_METADATA,
      UsersController.prototype.remove,
    ) as unknown[];
    const createExcluded = Reflect.getMetadata(
      'swagger/apiExcludeEndpoint',
      UsersController.prototype.create,
    ) as unknown;
    const removeExcluded = Reflect.getMetadata(
      'swagger/apiExcludeEndpoint',
      UsersController.prototype.remove,
    ) as unknown;

    expect(createGuards).toContain(DisabledEndpointGuard);
    expect(removeGuards).toContain(DisabledEndpointGuard);
    expect(createExcluded).toEqual({ disable: true });
    expect(removeExcluded).toEqual({ disable: true });
  });
});
