import { readFileSync } from "node:fs";
import { z } from "zod";

const roleStyleSchema = z.object({
  shape: z.enum(["rectangle", "hline", "vline", "text"]).default("rectangle"),
  color: z.string(),
  opacity: z.number().min(0).max(1).optional(),
  label: z.string().optional(),
});

const viewSchema = z.object({
  roles: z.array(z.string()).min(1),
  aka: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export const drawingConfigSchema = z.object({
  description: z.string().optional(),
  roles: z.record(z.string(), roleStyleSchema),
  views: z.record(z.string(), viewSchema),
  defaults: z.record(z.string(), z.object({ color: z.string().optional(), opacity: z.number().optional() })).optional(),
  strategies: z.record(z.string(), z.object({ views: z.record(z.string(), viewSchema).optional() })).optional(),
});

export type DrawingConfig = z.infer<typeof drawingConfigSchema>;

/** Read + validate the config; throws with a readable message on schema error. */
export function loadDrawingConfig(file: string): DrawingConfig {
  return drawingConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
