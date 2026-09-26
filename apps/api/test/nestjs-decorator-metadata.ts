import { fileURLToPath } from "node:url";
import ts from "typescript";

// Vitest transforms TypeScript with esbuild, which drops emitDecoratorMetadata.
// Nest resolves constructor dependencies from design:paramtypes, so these
// sources have to be compiled with tsc instead.
export function nestjsDecoratorMetadata(): {
  name: string;
  enforce: "pre";
  transform: (
    code: string,
    id: string,
  ) => { code: string; map?: null } | null;
} {
  return {
    name: "nestjs-decorator-metadata",
    enforce: "pre",
    transform(code, id) {
      const filename = sourcePath(id);
      if (!filename.endsWith(".ts") || filename.endsWith(".d.ts")) {
        return null;
      }
      if (!filename.includes("/apps/api/src/")) {
        return null;
      }
      // A second pass sees tsc's helper output. Compiling that again breaks it.
      if (code.includes("__decorate") || code.includes("design:paramtypes")) {
        return null;
      }

      const result = ts.transpileModule(code, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2023,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          sourceMap: false,
          importHelpers: false,
        },
        fileName: filename,
      });

      return { code: result.outputText, map: null };
    },
  };
}

function sourcePath(id: string): string {
  const withoutQuery = id.split("?")[0] ?? id;
  if (withoutQuery.startsWith("file://")) {
    return fileURLToPath(withoutQuery);
  }
  return withoutQuery;
}
