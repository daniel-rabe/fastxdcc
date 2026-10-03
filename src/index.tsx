#!/usr/bin/env node
import { render } from 'ink';
import React from 'react';
import { Session } from './app/session.js';
import { CLI_USAGE, EXAMPLE_CONFIG, loadConfig, parseCli } from './config.js';
import { App } from './tui/app.js';

async function main(): Promise<number> {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${CLI_USAGE}`);
    return 2;
  }

  if (cli.help) {
    process.stdout.write(CLI_USAGE);
    return 0;
  }
  if (cli.init) {
    process.stdout.write(EXAMPLE_CONFIG);
    return 0;
  }

  // Ink needs raw mode for the command line, and throws an opaque error without a TTY.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'fastxdcc needs an interactive terminal: stdin is not a TTY.\n' +
        'Run it directly in a terminal rather than through a pipe or a non-interactive job.\n',
    );
    return 1;
  }

  let loaded;
  try {
    loaded = await loadConfig(cli);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    if (/host/.test((err as Error).message)) {
      process.stderr.write(
        '\nNo server configured. Pass --server, or write a config file:\n' +
          '  fastxdcc --init > fastxdcc.config.json\n',
      );
    }
    return 1;
  }

  const session = new Session(loaded.config);
  if (loaded.source) session.store.log('info', '*', `Loaded config from ${loaded.source}`);
  session.store.log('info', '*', 'Type /help for commands');

  const app = render(<App session={session} />);
  session.start();

  const stop = () => {
    session.shutdown();
    app.unmount();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await app.waitUntilExit();
  session.shutdown();
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  },
);
