// This suite truncates tables and runs FLUSHDB. It must be impossible to point
// those operations at the dev database (DB_NAME without the _test suffix) or the
// dev Redis database (0). Redis 8-15 are reserved for test runs so parallel
// worktrees can each own one.
export const TEST_DATABASE_NAME = /^[a-z0-9_]+_test$/;
const TEST_REDIS_DATABASES = new Set(["8", "9", "10", "11", "12", "13", "14", "15"]);

export function assertSafeTestTargets(): void {
  const dbName = process.env.DB_NAME ?? "";
  if (!TEST_DATABASE_NAME.test(dbName)) {
    throw new Error(
      `Refusing to run e2e tests: DB_NAME must match ${TEST_DATABASE_NAME} (received ${JSON.stringify(dbName)}). This suite truncates tables and must never run against the dev database.`,
    );
  }

  const redisUrl = process.env.REDIS_URL ?? "";
  let pathname: string;
  try {
    pathname = new URL(redisUrl).pathname;
  } catch {
    throw new Error(
      `Refusing to run e2e tests: REDIS_URL must be a URL selecting a Redis database between 8 and 15. The received value is not a valid URL.`,
    );
  }

  if (!TEST_REDIS_DATABASES.has(pathname.slice(1))) {
    throw new Error(
      `Refusing to run e2e tests: REDIS_URL must select a Redis database between 8 and 15 (received path ${JSON.stringify(pathname)}). This suite runs FLUSHDB and must never flush another Redis database.`,
    );
  }
}
