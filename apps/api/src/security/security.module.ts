import { Module } from "@nestjs/common";
import { LoginRateLimiter } from "./login-rate-limiter.js";
import { PasswordHasher } from "./password-hasher.js";

@Module({
  providers: [LoginRateLimiter, PasswordHasher],
  exports: [LoginRateLimiter, PasswordHasher],
})
export class SecurityModule {}
