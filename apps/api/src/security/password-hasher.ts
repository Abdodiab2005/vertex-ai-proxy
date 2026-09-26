import { Injectable } from "@nestjs/common";
import {
  Algorithm,
  hash as argon2Hash,
  verify as argon2Verify,
  Version,
} from "@node-rs/argon2";

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  version: Version.V0x13,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

const DUMMY_PASSWORD = "admin-login-dummy-password";

@Injectable()
export class PasswordHasher {
  private dummyHashPromise: Promise<string> | undefined;

  hash(plain: string): Promise<string> {
    return argon2Hash(plain, ARGON2_OPTIONS);
  }

  async verify(storedHash: string | null, plain: string): Promise<boolean> {
    if (storedHash === null) {
      await argon2Verify(await this.getDummyHash(), plain, ARGON2_OPTIONS);
      return false;
    }

    return argon2Verify(storedHash, plain, ARGON2_OPTIONS);
  }

  private getDummyHash(): Promise<string> {
    this.dummyHashPromise ??= this.hash(DUMMY_PASSWORD);
    return this.dummyHashPromise;
  }
}
