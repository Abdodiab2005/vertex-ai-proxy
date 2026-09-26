import {
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type {
  AdminAuthenticatedRequest,
  AdminAuthentication,
} from "./admin-authentication.js";

export const CurrentAdmin = createParamDecorator<undefined, AdminAuthentication>(
  (_data: undefined, context: ExecutionContext): AdminAuthentication => {
    const authentication = context
      .switchToHttp()
      .getRequest<AdminAuthenticatedRequest>().adminAuthentication;

    if (authentication === undefined) {
      throw new UnauthorizedException("Unauthorized");
    }

    return authentication;
  },
);
