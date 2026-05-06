import { z } from "zod";

const EnvDef = z.object({
  name: z.string(),
  description: z.string().optional(),
  default: z.string().optional(),
});

const FileDef = z.object({
  id: z.string(),
  name: z.string().optional(),
  kind: z.enum(["file", "folder"]),
  extensions: z.array(z.string()).optional(),
  required: z.boolean().optional(),
});

const ManifestSchema = z.object({
  display_name: z.string().optional(),
  tagline: z.string().optional(),
  icon: z.string().optional(),
  schedule: z.string().optional(),
  watch: z
    .object({
      collections: z.array(z.string()),
      glob: z.string().optional(),
    })
    .optional(),
  env: z.array(EnvDef).optional(),
  files: z.array(FileDef).optional(),
  net: z.array(z.string()).optional(),
  collections: z.array(z.string()).optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export interface ParsedPackage {
  name: string;
  version: string;
  manifest: Manifest;
}

export function parsePackage(pkg: unknown): ParsedPackage {
  if (typeof pkg !== "object" || pkg === null) {
    throw new Error("package.json must be a JSON object");
  }
  const obj = pkg as Record<string, unknown>;
  if (typeof obj["name"] !== "string") {
    throw new Error("package.json missing 'name'");
  }
  if (typeof obj["version"] !== "string") {
    throw new Error("package.json missing 'version'");
  }
  if (!obj["dither"] || typeof obj["dither"] !== "object") {
    throw new Error("package.json missing 'dither' block");
  }
  const manifest = ManifestSchema.parse(obj["dither"]);
  return {
    name: obj["name"],
    version: obj["version"],
    manifest,
  };
}
