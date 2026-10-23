// File Config Adapter - Load and patch JSON configuration files

import { existsSync } from "node:fs";

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";

import { homedir } from "node:os";

import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

import { type ConfigDiagnostic } from "./schema.js";

export const DEFAULT_CONFIG_FILE = "config.json";

export const DEFAULT_BASE_DIR = "~/.zcode/cli";

/**
 * Resolve path with ~ expansion
 */
export function resolvePath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

export function createConfigFileInvalidDiagnostic(
  error: unknown,
  filePath: string,
): ConfigDiagnostic {
  return {
    code: "config_file_invalid",
    filePath,
    message:
      error instanceof z.ZodError
        ? formatZodError(error)
        : error instanceof Error
          ? error.message
          : "Unable to parse config file.",
    severity: "error",
  };
}

export function attachDiagnosticFilePath(
  diagnostics: ConfigDiagnostic[],
  filePath: string,
): ConfigDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    filePath: diagnostic.filePath ?? filePath,
  }));
}

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<config>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Get default config file path
 */
export function getDefaultConfigPath(): string {
  return join(resolvePath(DEFAULT_BASE_DIR), DEFAULT_CONFIG_FILE);
}

/**
 * Check if config file exists at default location
 */
export function hasDefaultConfigFile(): boolean {
  return existsSync(getDefaultConfigPath());
}

export async function readJsonConfigFile(filePath: string): Promise<Record<string, unknown>> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(`Unable to read config file: ${filePath}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Unable to parse config file as JSON: ${filePath}`, { cause: error });
  }

  if (!isRecord(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${filePath}`);
  }

  return parsed;
}

export async function readJsonConfigFileOrEmpty(
  filePath: string,
): Promise<Record<string, unknown>> {
  try {
    return await readJsonConfigFile(filePath);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function atomicWriteJson(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  );
  const content = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await writeFile(tempPath, content, { mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Unable to write config file: ${filePath}`, { cause: error });
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
