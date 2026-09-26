import { stdin as input } from "node:process";
import { DataSource } from "typeorm";
import { loadDatabaseEnv, entities } from "@gateway/database";
import { PasswordHasher } from "../security/password-hasher.js";
import { bootstrapOwner, OwnerAlreadyExistsError, validateBootstrapOwnerInput } from "./bootstrap-owner.js";
import { parseCreateOwnerArgs, firstLine, UsageError } from "./create-owner-input.js";

class PromptAbortedError extends Error {}

function printUsage(): void {
  console.error("Usage: create-owner --email <address>");
  console.error("  --email    Owner account email (required)");
  console.error("  --help     Show this help");
  console.error("");
  console.error("Password is read from stdin (TTY: hidden prompt; non-TTY: first line).");
}

// Raw mode instead of readline so typed characters are never echoed; prompts go to
// stderr so stdout carries only the result line.
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";

    const finish = (outcome: () => void) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      outcome();
    };
    const onEnd = () => finish(() => reject(new PromptAbortedError()));
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          finish(() => resolve(value));
          return;
        }
        if (char === "\u0003" || char === "\u0004") {
          finish(() => reject(new PromptAbortedError()));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else if (char >= " ") {
          value += char;
        }
      }
    };

    process.stderr.write(prompt);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.once("end", onEnd);
    input.resume();
  });
}

async function readPassword(): Promise<string> {
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) {
      chunks.push(chunk);
    }
    return firstLine(Buffer.concat(chunks).toString("utf8"));
  }

  const password = await promptHidden("Password: ");
  const confirmation = await promptHidden("Confirm password: ");
  if (password !== confirmation) {
    throw new Error("Passwords do not match");
  }
  return password;
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseCreateOwnerArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) {
      throw error;
    }
    console.error(`Error: ${error.message}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    printUsage();
    return;
  }

  let password: string;
  try {
    password = await readPassword();
    // Fail on bad input before opening a database connection.
    validateBootstrapOwnerInput({ email: args.email, password });
  } catch (error) {
    if (error instanceof PromptAbortedError) {
      console.error("Aborted.");
      process.exitCode = 130;
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : "Invalid input"}`);
      process.exitCode = 1;
    }
    return;
  }

  const dbEnv = loadDatabaseEnv();
  const dataSource = new DataSource({
    type: "postgres",
    host: dbEnv.DB_HOST,
    port: dbEnv.DB_PORT,
    username: dbEnv.DB_USERNAME,
    password: dbEnv.DB_PASSWORD,
    database: dbEnv.DB_NAME,
    ssl: dbEnv.DB_SSL,
    synchronize: false,
    logging: false,
    entities,
  });

  try {
    await dataSource.initialize();
    const result = await bootstrapOwner(dataSource, new PasswordHasher(), {
      email: args.email,
      password,
    });
    console.log(`Owner account created: ${result.email}`);
  } catch (error) {
    if (error instanceof OwnerAlreadyExistsError) {
      console.error("Error: An admin account already exists; the owner bootstrap only runs on an empty admin_users table.");
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    process.exitCode = 1;
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

await main();
