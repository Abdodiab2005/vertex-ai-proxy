import type { AdminSession, AdminUser } from "@gateway/database";
import type { Request } from "express";

export interface AdminAuthentication {
  user: AdminUser;
  session: AdminSession;
  csrfToken: string;
}

export interface AdminAuthenticatedRequest extends Request {
  adminAuthentication?: AdminAuthentication;
}
