/**
 * Local test doubles for the services `createRouter` needs.
 *
 * These exist so the package does not depend on
 * `@backstage/backend-test-utils` or `@backstage/backend-defaults`, whose
 * transitive dependencies (`better-sqlite3`, and `cpu-features` via
 * testcontainers -> dockerode -> ssh2) need a native toolchain to install.
 * The router only touches a handful of methods on each service, so hand-rolled
 * stubs are cheaper than a compiler on every build host.
 */
import express from 'express';
import { ConfigReader } from '@backstage/config';
import {
  AuthService,
  BackstageCredentials,
  BackstagePrincipalTypes,
  BackstageUserPrincipal,
  HttpAuthService,
  LoggerService,
  PermissionsService,
  RootConfigService,
} from '@backstage/backend-plugin-api';
import {
  AuthorizeResult,
  PolicyDecision,
} from '@backstage/plugin-permission-common';
import { serializeError } from '@backstage/errors';

type ConfigData = ConstructorParameters<typeof ConfigReader>[0];

export function mockRootConfig(data: ConfigData): RootConfigService {
  return new ConfigReader(data) as RootConfigService;
}

export function mockLogger(): LoggerService {
  const logger: LoggerService = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    child: () => logger,
  };
  return logger;
}

export function mockUserCredentials(
  userEntityRef = 'user:default/jay',
): BackstageCredentials<BackstageUserPrincipal> {
  return {
    $$type: '@backstage/BackstageCredentials',
    principal: { type: 'user', userEntityRef },
  };
}

export function mockAuth(): AuthService {
  return {
    isPrincipal: (<TType extends keyof BackstagePrincipalTypes>(
      credentials: BackstageCredentials,
      type: TType,
    ) =>
      (credentials.principal as { type?: string }).type ===
      type) as AuthService['isPrincipal'],
  } as unknown as AuthService;
}

export function mockHttpAuth(
  credentials: BackstageCredentials = mockUserCredentials(),
): HttpAuthService {
  return {
    credentials: async () => credentials,
  } as unknown as HttpAuthService;
}

export function mockPermissions(allow = true): PermissionsService {
  const decision: PolicyDecision = {
    result: allow ? AuthorizeResult.ALLOW : AuthorizeResult.DENY,
  };
  return {
    authorize: async (requests: unknown[]) => requests.map(() => decision),
    authorizeConditional: async (requests: unknown[]) =>
      requests.map(() => decision),
  } as unknown as PermissionsService;
}

/**
 * Status codes for the `@backstage/errors` classes, mirroring what
 * `MiddlewareFactory.error()` returns in a real backend.
 */
const ERROR_STATUS: Record<string, number> = {
  NotModifiedError: 304,
  InputError: 400,
  AuthenticationError: 401,
  NotAllowedError: 403,
  NotFoundError: 404,
  ConflictError: 409,
  NotImplementedError: 501,
  ServiceUnavailableError: 503,
};

/** Stand-in for `MiddlewareFactory.create({...}).error()`. */
export function errorHandler(): express.ErrorRequestHandler {
  return (error: Error, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const statusCode = ERROR_STATUS[error.name] ?? 500;
    response.status(statusCode).json({
      error: serializeError(error),
      response: { statusCode },
    });
  };
}
