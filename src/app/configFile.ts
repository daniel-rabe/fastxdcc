/**
 * Reading and writing the config file for the GUI.
 *
 * The GUI has to hold a config that is not yet valid — the app opens before the user has
 * typed a server name — so settings are stored against a "draft" schema whose host may be
 * empty. It is checked for real when the user hits connect.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ConfigSchema, NetworkSchema, type Config } from '../config.js';

export const DraftConfigSchema = ConfigSchema.extend({
  network: NetworkSchema.extend({
    host: z.string().default(''),
    nick: z.string().default('fastxdcc'),
  }),
});

export type DraftConfig = z.infer<typeof DraftConfigSchema>;

/** Defaults for a first run: everything filled in except the parts only a user knows. */
export function defaultConfig(downloadDir: string): DraftConfig {
  return DraftConfigSchema.parse({
    network: { host: '', port: 6697, tls: true, nick: 'fastxdcc', channels: [] },
    downloadDir,
  });
}

export interface LoadedFileConfig {
  config: DraftConfig;
  path: string;
  /** False when the file did not exist and defaults were used instead. */
  existed: boolean;
}

export async function readConfigFile(
  file: string,
  fallbackDownloadDir: string,
): Promise<LoadedFileConfig> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: defaultConfig(fallbackDownloadDir), path: file, existed: false };
    }
    throw err;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }

  const parsed = DraftConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration in ${file}:\n${issues}`);
  }

  return { config: parsed.data, path: file, existed: true };
}

export async function writeConfigFile(file: string, config: unknown): Promise<DraftConfig> {
  const parsed = DraftConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Cannot save these settings:\n${issues}`);
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
  return parsed.data;
}

/**
 * Promote a draft to a config a Session can actually run on, with messages aimed at
 * someone looking at a settings form rather than a JSON file.
 */
export function requireConnectable(draft: DraftConfig): Config {
  if (draft.network.host.trim() === '') {
    throw new Error('Set a server hostname in Settings before connecting.');
  }
  if (draft.network.nick.trim() === '') {
    throw new Error('Set a nickname in Settings before connecting.');
  }

  const parsed = ConfigSchema.safeParse(draft);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`These settings cannot be used: ${issues}`);
  }
  return parsed.data;
}
