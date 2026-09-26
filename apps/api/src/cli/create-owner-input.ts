import { parseArgs } from "node:util";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type ParseCreateOwnerArgsResult = { help: true } | { help: false; email: string };

export function parseCreateOwnerArgs(argv: string[]): ParseCreateOwnerArgsResult {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        email: { type: "string", short: "e" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });

    if (positionals.length > 0) {
      throw new UsageError(`Unknown positional argument: ${positionals[0]}`);
    }

    if (values.help) {
      return { help: true };
    }

    if (!values.email) {
      throw new UsageError("--email is required");
    }

    return { help: false, email: values.email };
  } catch (error) {
    if (error instanceof UsageError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new UsageError(error.message);
    }
    throw new UsageError("Unknown argument parsing error");
  }
}

export function firstLine(text: string): string {
  return text.split(/\r?\n/)[0];
}