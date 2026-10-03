import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { channelsToText, textToChannels } from '../src/app/channels.js';
import {
  defaultConfig,
  readConfigFile,
  requireConnectable,
  writeConfigFile,
} from '../src/app/configFile.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'fastxdcc-cfgfile-'));
  file = path.join(dir, 'nested', 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readConfigFile', () => {
  it('returns usable defaults when the file does not exist yet', async () => {
    const loaded = await readConfigFile(file, path.join(dir, 'downloads'));
    expect(loaded.existed).toBe(false);
    // The GUI opens before the user has typed anything, so an empty host is valid here.
    expect(loaded.config.network.host).toBe('');
    expect(loaded.config.network.port).toBe(6697);
    expect(loaded.config.downloadDir).toBe(path.join(dir, 'downloads'));
  });

  it('reads a saved file back', async () => {
    const saved = await writeConfigFile(file, {
      network: { host: 'irc.example.net', nick: 'someone', channels: ['#packs'] },
      downloadDir: dir,
    });
    expect(saved.network.host).toBe('irc.example.net');

    const loaded = await readConfigFile(file, dir);
    expect(loaded.existed).toBe(true);
    expect(loaded.config.network.nick).toBe('someone');
    expect(loaded.config.network.channels).toEqual(['#packs']);
  });

  it('creates the directory when saving', async () => {
    await writeConfigFile(file, { network: { host: 'a.example' }, downloadDir: dir });
    const text = await readFile(file, 'utf8');
    expect(JSON.parse(text).network.host).toBe('a.example');
  });

  it('names the file when it holds broken JSON', async () => {
    await writeConfigFile(file, { network: { host: 'a.example' }, downloadDir: dir });
    await writeFile(file, '{ nope');
    await expect(readConfigFile(file, dir)).rejects.toThrow(/not valid JSON/);
  });

  it('reports which setting is invalid', async () => {
    await writeConfigFile(file, { network: { host: 'a.example' }, downloadDir: dir });
    await writeFile(file, JSON.stringify({ network: { host: 'a', port: 999999 } }));
    await expect(readConfigFile(file, dir)).rejects.toThrow(/network\.port/);
  });

  it('refuses to save settings that are not valid', async () => {
    await expect(writeConfigFile(file, { maxConcurrent: 0 })).rejects.toThrow(/maxConcurrent/);
  });
});

describe('requireConnectable', () => {
  it('asks for a host in words a settings form can show', () => {
    const draft = defaultConfig(dir);
    expect(() => requireConnectable(draft)).toThrow(/Set a server hostname/);
  });

  it('asks for a nickname when it is blank', () => {
    const draft = { ...defaultConfig(dir), network: { ...defaultConfig(dir).network, host: 'a.example', nick: '  ' } };
    expect(() => requireConnectable(draft)).toThrow(/Set a nickname/);
  });

  it('passes a complete draft through as a real config', () => {
    const base = defaultConfig(dir);
    const draft = { ...base, network: { ...base.network, host: 'irc.example.net', nick: 'me' } };
    const config = requireConnectable(draft);
    expect(config.network.host).toBe('irc.example.net');
    expect(config.maxConcurrent).toBe(2);
  });
});

describe('channel text', () => {
  it('round-trips plain and keyed channels', () => {
    const channels = [{ name: '#packs' }, { name: '#private', key: 'sekrit' }];
    expect(textToChannels(channelsToText(channels))).toEqual(channels);
  });

  it('renders the config array form, which allows bare strings', () => {
    expect(channelsToText(['#a', { name: '#b', key: 'k' }])).toBe('#a\n#b k');
  });

  it('adds the missing # people forget', () => {
    expect(textToChannels('packs')).toEqual([{ name: '#packs' }]);
    expect(textToChannels('&local')).toEqual([{ name: '&local' }]);
  });

  it('ignores blank lines and padding', () => {
    expect(textToChannels('\n  #a  \n\n #b key \n')).toEqual([
      { name: '#a' },
      { name: '#b', key: 'key' },
    ]);
  });
});
