import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

function autoLoadEnvFile() {
  if (typeof process.loadEnvFile !== "function") return;

  try {
    process.loadEnvFile();
    return;
  } catch {
    // Ignore and check parent directories
  }

  let currentDir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(currentDir, ".env");
    if (fs.existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
        return;
      } catch {
        // ignore
      }
    }
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
}

export function loadEnv<T extends z.ZodType>(schema: T): z.infer<T> {
  autoLoadEnvFile();
  return schema.parse(process.env);
}
