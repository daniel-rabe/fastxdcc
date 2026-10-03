/**
 * Configuration: a JSON file, overridden by CLI flags.
 *
 * Credentials live in the config file rather than in flags so they do not end up in the
 * shell history or in the process list.
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { parseDownloadRequest, type DownloadRequest } from './xdcc/request.js';

const ChannelSchema = z.union([
  z.string(),
  z.object({ name: z.string(), key: z.string().optional() }),
]);

export const NetworkSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(6697),
  tls: z.boolean().default(true),
  rejectUnauthorized: z.boolean().default(true),
  nick: z.string().min(1).default('fastxdcc'),
  username: z.string().optional(),
  realname: z.string().optional(),
  channels: z.array(ChannelSchema).default([]),
  sasl: z.object({ account: z.string(), password: z.string() }).optional(),
  nickserv: z.object({ account: z.string().optional(), password: z.string() }).optional(),
  maxReconnectAttempts: z.number().int().min(0).default(10),
});

const PassiveSchema = z.object({
  /** Address advertised to bots for reverse DCC. Auto-detected when omitted. */
  externalIp: z.string().optional(),
  portRange: z.tuple([z.number().int(), z.number().int()]).default([59000, 59100]),
  listenTimeoutMs: z.number().int().positive().default(60_000),
});

const TimeoutsSchema = z.object({
  requestMs: z.number().int().min(0).default(60_000),
  resumeMs: z.number().int().positive().default(10_000),
  connectMs: z.number().int().positive().default(30_000),
  stallMs: z.number().int().positive().default(60_000),
});

export const ConfigSchema = z.object({
  network: NetworkSchema,
  downloadDir: z.string().default('./downloads'),
  maxConcurrent: z.number().int().min(1).max(20).default(2),
  maxRetries: z.number().int().min(0).max(10).default(2),
  passive: PassiveSchema.prefault({}),
  timeouts: TimeoutsSchema.prefault({}),
  /** Packs to request as soon as we are in the channels, e.g. `[{bot, packs:[1,2]}]`. */
  autoGet: z
    .array(z.object({ bot: z.string(), packs: z.array(z.number().int().positive()) }))
    .default([]),
  /** Mirror the log to this file, so a full terminal buffer is not the only record. */
  logFile: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type NormalisedChannel = { name: string; key?: string };

export function normaliseChannels(config: Config): NormalisedChannel[] {
  return config.network.channels.map((c) =>
    typeof c === 'string' ? { name: c } : { name: c.name, ...(c.key ? { key: c.key } : {}) },
  );
}

export const CLI_USAGE = `fastxdcc - IRC client for XDCC downloads

Usage:
  fastxdcc [options]

Options:
  -c, --config <file>   Config file (default: ./fastxdcc.config.json, then
                        ~/.config/fastxdcc/config.json)
  -s, --server <host>   IRC server hostname
  -p, --port <n>        Port (default 6697 with TLS, 6667 without)
      --no-tls          Disable TLS
      --insecure        Accept invalid TLS certificates
  -n, --nick <nick>     Nickname
  -j, --channel <name>  Join a channel; repeatable. Use '#chan key' for a keyed channel
  -d, --dir <path>      Download directory
  -m, --max <n>         Maximum concurrent transfers
  -g, --get <spec>      Request packs on connect, e.g. --get 'BotName #1,3-5'; repeatable
      --init            Print an example config file and exit
  -h, --help            Show this help
`;

export const EXAMPLE_CONFIG = `{
  "network": {
    "host": "irc.example.net",
    "port": 6697,
    "tls": true,
    "nick": "yournick",
    "channels": ["#packs", { "name": "#private", "key": "channelkey" }],
    "sasl": { "account": "yournick", "password": "secret" },
    "nickserv": { "password": "secret" }
  },
  "downloadDir": "./downloads",
  "maxConcurrent": 2,
  "passive": {
    "portRange": [59000, 59100]
  },
  "autoGet": [{ "bot": "SomeBot", "packs": [1, 2] }]
}
`;

export type GetSpec = DownloadRequest;

/** Re-exported so callers can keep importing pack parsing from the config module. */
export { parsePackList } from './xdcc/request.js';

/**
 * Parse `BotName #1,3-5` as used by `--get` and the `/get` command. The same lenient
 * parser backs the GUI, so a pasted `/msg BotName xdcc send #1` works here too.
 */
export function parseGetSpec(spec: string): GetSpec {
  return parseDownloadRequest(spec);
}

export interface CliOptions {
  configPath?: string;
  help: boolean;
  init: boolean;
  overrides: Record<string, unknown>;
  gets: GetSpec[];
  channels: NormalisedChannel[];
}

export function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      config: { type: 'string', short: 'c' },
      server: { type: 'string', short: 's' },
      port: { type: 'string', short: 'p' },
      // `parseArgs` has no built-in `--no-x` negation, so the flag is declared literally.
      'no-tls': { type: 'boolean' },
      insecure: { type: 'boolean' },
      nick: { type: 'string', short: 'n' },
      channel: { type: 'string', short: 'j', multiple: true },
      dir: { type: 'string', short: 'd' },
      max: { type: 'string', short: 'm' },
      get: { type: 'string', short: 'g', multiple: true },
      init: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const channels: NormalisedChannel[] = (values.channel ?? []).map((raw) => {
    const [name, key] = raw.trim().split(/\s+/, 2);
    return { name: name ?? '', ...(key ? { key } : {}) };
  });

  const gets = (values.get ?? []).map(parseGetSpec);

  const network: Record<string, unknown> = {};
  if (values.server !== undefined) network.host = values.server;
  if (values.port !== undefined) network.port = Number(values.port);
  if (values['no-tls']) network.tls = false;
  if (values.insecure) network.rejectUnauthorized = false;
  if (values.nick !== undefined) network.nick = values.nick;
  if (channels.length > 0) network.channels = channels;

  const overrides: Record<string, unknown> = {};
  if (Object.keys(network).length > 0) overrides.network = network;
  if (values.dir !== undefined) overrides.downloadDir = values.dir;
  if (values.max !== undefined) overrides.maxConcurrent = Number(values.max);

  return {
    ...(values.config !== undefined ? { configPath: values.config } : {}),
    help: values.help ?? false,
    init: values.init ?? false,
    overrides,
    gets,
    channels,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shallow-recursive merge; arrays are replaced wholesale, not concatenated. */
function merge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? merge(base[key], value) : value;
  }
  return out;
}

export const DEFAULT_CONFIG_PATHS = [
  path.resolve('fastxdcc.config.json'),
  path.join(os.homedir(), '.config', 'fastxdcc', 'config.json'),
];

async function readJsonIfPresent(file: string): Promise<unknown | undefined> {
  try {
    const text = await readFile(file, 'utf8');
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export interface LoadedConfig {
  config: Config;
  /** The file the settings came from, or null when they came only from flags. */
  source: string | null;
}

export async function loadConfig(cli: CliOptions): Promise<LoadedConfig> {
  let raw: unknown | undefined;
  let source: string | null = null;

  if (cli.configPath) {
    raw = await readJsonIfPresent(path.resolve(cli.configPath));
    if (raw === undefined) throw new Error(`Config file not found: ${cli.configPath}`);
    source = path.resolve(cli.configPath);
  } else {
    for (const candidate of DEFAULT_CONFIG_PATHS) {
      raw = await readJsonIfPresent(candidate);
      if (raw !== undefined) {
        source = candidate;
        break;
      }
    }
  }

  // Seed an empty `network` so a config missing it reports `network.host` as the problem
  // rather than the much less actionable "network: expected object, received undefined".
  const merged = merge({ network: {} }, merge(raw ?? {}, cli.overrides));
  const parsed = ConfigSchema.safeParse(merged);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    const hint = source ? `in ${source}` : 'from command-line options';
    throw new Error(`Invalid configuration ${hint}:\n${issues}`);
  }

  const config = parsed.data;

  // TLS off usually means the plain-text port, unless the user said otherwise.
  if (!config.network.tls && config.network.port === 6697) config.network.port = 6667;

  if (cli.gets.length > 0) config.autoGet = cli.gets;

  return { config, source };
}
