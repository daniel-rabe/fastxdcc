import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadConfig,
  normaliseChannels,
  parseCli,
  parseGetSpec,
  parsePackList,
} from '../src/config.js';

describe('parsePackList', () => {
  it('parses single numbers and ranges', () => {
    expect(parsePackList('1')).toEqual([1]);
    expect(parsePackList('1,2,3')).toEqual([1, 2, 3]);
    expect(parsePackList('3-6')).toEqual([3, 4, 5, 6]);
    expect(parsePackList('1,4-6,9')).toEqual([1, 4, 5, 6, 9]);
  });

  it('accepts the # that bots print', () => {
    expect(parsePackList('#1,#3-#5')).toEqual([1, 3, 4, 5]);
  });

  it('deduplicates overlapping ranges', () => {
    expect(parsePackList('1-3,2-4')).toEqual([1, 2, 3, 4]);
  });

  it('rejects nonsense', () => {
    expect(() => parsePackList('abc')).toThrow(/Not a pack number/);
    expect(() => parsePackList('5-1')).toThrow(/Inverted/);
    expect(() => parsePackList('1-100000')).toThrow(/too large/);
  });
});

describe('parseGetSpec', () => {
  it('splits the bot from the pack list', () => {
    expect(parseGetSpec('SomeBot #1,3-4')).toEqual({ bot: 'SomeBot', packs: [1, 3, 4] });
  });

  it('requires both parts', () => {
    expect(() => parseGetSpec('SomeBot')).toThrow(/Expected/);
    expect(() => parseGetSpec('SomeBot  ')).toThrow(/Expected/);
    expect(() => parseGetSpec('SomeBot none')).toThrow(/Not a pack number/);
  });
});

describe('parseCli', () => {
  it('collects repeated channel and get flags', () => {
    const cli = parseCli(['-j', '#a', '-j', '#b key', '-g', 'Bot #1', '-g', 'Bot2 #2-3']);
    expect(cli.channels).toEqual([{ name: '#a' }, { name: '#b', key: 'key' }]);
    expect(cli.gets).toEqual([
      { bot: 'Bot', packs: [1] },
      { bot: 'Bot2', packs: [2, 3] },
    ]);
  });

  it('only sets overrides for flags that were actually passed', () => {
    expect(parseCli(['--server', 'irc.example.net']).overrides).toEqual({
      network: { host: 'irc.example.net' },
    });
    expect(parseCli([]).overrides).toEqual({});
  });

  it('maps --no-tls to tls false', () => {
    const cli = parseCli(['--no-tls']);
    expect((cli.overrides.network as Record<string, unknown>).tls).toBe(false);
  });
});

describe('loadConfig', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'fastxdcc-cfg-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeConfig(contents: unknown): Promise<string> {
    const file = path.join(dir, 'config.json');
    await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return file;
  }

  it('applies defaults for everything but the host', async () => {
    const file = await writeConfig({ network: { host: 'irc.example.net' } });
    const { config } = await loadConfig(parseCli(['--config', file]));
    expect(config.network.port).toBe(6697);
    expect(config.network.tls).toBe(true);
    expect(config.maxConcurrent).toBe(2);
    expect(config.passive.portRange).toEqual([59000, 59100]);
    expect(config.timeouts.stallMs).toBe(60_000);
  });

  it('lets CLI flags win over the file', async () => {
    const file = await writeConfig({ network: { host: 'a.example', nick: 'fromfile' } });
    const { config } = await loadConfig(parseCli(['--config', file, '--nick', 'fromflag']));
    expect(config.network.nick).toBe('fromflag');
    expect(config.network.host).toBe('a.example');
  });

  it('switches to the plain-text port when TLS is turned off', async () => {
    const file = await writeConfig({ network: { host: 'a.example' } });
    const { config } = await loadConfig(parseCli(['--config', file, '--no-tls']));
    expect(config.network.port).toBe(6667);
  });

  it('keeps an explicit port when TLS is turned off', async () => {
    const file = await writeConfig({ network: { host: 'a.example', port: 7000 } });
    const { config } = await loadConfig(parseCli(['--config', file, '--no-tls']));
    expect(config.network.port).toBe(7000);
  });

  it('normalises both channel spellings', async () => {
    const file = await writeConfig({
      network: { host: 'a.example', channels: ['#plain', { name: '#keyed', key: 'k' }] },
    });
    const { config } = await loadConfig(parseCli(['--config', file]));
    expect(normaliseChannels(config)).toEqual([{ name: '#plain' }, { name: '#keyed', key: 'k' }]);
  });

  it('turns --get into autoGet entries', async () => {
    const file = await writeConfig({ network: { host: 'a.example' } });
    const { config } = await loadConfig(parseCli(['--config', file, '--get', 'Bot #1,2']));
    expect(config.autoGet).toEqual([{ bot: 'Bot', packs: [1, 2] }]);
  });

  it('reports which setting is wrong rather than throwing a raw zod error', async () => {
    const file = await writeConfig({ network: { host: 'a.example', port: 99999 } });
    await expect(loadConfig(parseCli(['--config', file]))).rejects.toThrow(/network\.port/);
  });

  it('names the file when it is not valid JSON', async () => {
    const file = await writeConfig('{ not json');
    await expect(loadConfig(parseCli(['--config', file]))).rejects.toThrow(/not valid JSON/);
  });

  it('complains when no host is configured anywhere', async () => {
    const file = await writeConfig({});
    await expect(loadConfig(parseCli(['--config', file]))).rejects.toThrow(/network\.host/);
  });

  it('fails clearly when the named config file is missing', async () => {
    await expect(
      loadConfig(parseCli(['--config', path.join(dir, 'nope.json')])),
    ).rejects.toThrow(/not found/);
  });
});
