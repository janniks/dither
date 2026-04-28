import { z } from "zod";

const InputDef = z.object({
  id: z.string(),
  name: z.string().optional(),
  kind: z.enum(["secret", "string", "number", "bool"]),
  description: z.string().optional(),
  default: z.unknown().optional(),
});

const FileDef = z.object({
  id: z.string(),
  name: z.string().optional(),
  kind: z.enum(["file", "folder"]),
  extensions: z.array(z.string()).optional(),
  required: z.boolean().optional(),
});

const Permissions = z.object({
  host_net: z.array(z.string()).optional(),
  host_env: z.array(z.string()).optional(),
  browser: z
    .object({
      hosts: z.array(z.string()),
    })
    .optional(),
});

const Collections = z.object({
  writes: z.array(z.string()).optional(),
  reads: z.array(z.string()).optional(),
  auto_create: z.array(z.string()).optional(),
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
  inputs: z.array(InputDef).optional(),
  files: z.array(FileDef).optional(),
  permissions: Permissions.optional(),
  collections: Collections.optional(),
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
