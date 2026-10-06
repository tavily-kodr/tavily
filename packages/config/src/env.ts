import { z } from "zod";

export function loadEnv<T extends z.ZodType>(schema: T): z.infer<T> {
  return schema.parse(process.env);
}
