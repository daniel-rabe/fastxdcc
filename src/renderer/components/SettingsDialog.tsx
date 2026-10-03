import React, { useState } from 'react';
import type { DraftConfig } from '../../app/configFile.js';
import { channelsToText, textToChannels } from '../../app/channels.js';
import { api, unwrap } from '../api.js';

interface Props {
  config: DraftConfig;
  configPath: string;
  onSaved: (config: DraftConfig) => void;
  onClose: () => void;
}

/** Parse a number field, falling back when the box is empty or nonsense. */
function num(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function SettingsDialog({
  config,
  configPath,
  onSaved,
  onClose,
}: Props): React.ReactElement {
  const [draft, setDraft] = useState<DraftConfig>(() =>
    structuredClone(config),
  );
  const [channelText, setChannelText] = useState(() => channelsToText(config.network.channels));
  const [useSasl, setUseSasl] = useState(Boolean(config.network.sasl));
  const [useNickServ, setUseNickServ] = useState(Boolean(config.network.nickserv));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const patchNetwork = (patch: Partial<DraftConfig['network']>) =>
    setDraft((d) => ({ ...d, network: { ...d.network, ...patch } }));
  const patchPassive = (patch: Partial<DraftConfig['passive']>) =>
    setDraft((d) => ({ ...d, passive: { ...d.passive, ...patch } }));

  async function browse(): Promise<void> {
    try {
      const { path } = await unwrap(api.chooseDir());
      if (path) setDraft((d) => ({ ...d, downloadDir: path }));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(undefined);
    try {
      const next: DraftConfig = {
        ...draft,
        network: {
          ...draft.network,
          channels: textToChannels(channelText),
          // Dropping the object entirely is what turns the mechanism off.
          ...(useSasl
            ? {
                sasl: {
                  account: draft.network.sasl?.account ?? draft.network.nick,
                  password: draft.network.sasl?.password ?? '',
                },
              }
            : { sasl: undefined }),
          ...(useNickServ
            ? { nickserv: { password: draft.network.nickserv?.password ?? '' } }
            : { nickserv: undefined }),
        },
      };
      const saved = await unwrap(api.saveConfig(next));
      onSaved(saved.config as DraftConfig);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <header>
          <span>Settings</span>
          <span className="spacer" />
          <span className="where" title={configPath}>
            {configPath}
          </span>
        </header>

        <div className="body">
          <fieldset>
            <legend>Server</legend>
            <div className="grid">
              <label htmlFor="host">Host</label>
              <input
                id="host"
                value={draft.network.host}
                placeholder="irc.example.net"
                onChange={(e) => patchNetwork({ host: e.target.value })}
              />

              <label htmlFor="port">Port</label>
              <div className="row">
                <input
                  id="port"
                  style={{ width: 90 }}
                  value={String(draft.network.port)}
                  onChange={(e) => patchNetwork({ port: num(e.target.value, 6697) })}
                />
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={draft.network.tls}
                    onChange={(e) =>
                      patchNetwork({
                        tls: e.target.checked,
                        // Move to the conventional port unless a custom one is set.
                        port:
                          draft.network.port === (e.target.checked ? 6667 : 6697)
                            ? e.target.checked
                              ? 6697
                              : 6667
                            : draft.network.port,
                      })
                    }
                  />
                  TLS
                </label>
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={!draft.network.rejectUnauthorized}
                    onChange={(e) => patchNetwork({ rejectUnauthorized: !e.target.checked })}
                  />
                  Allow invalid certificates
                </label>
              </div>

              <label htmlFor="nick">Nickname</label>
              <input
                id="nick"
                value={draft.network.nick}
                onChange={(e) => patchNetwork({ nick: e.target.value })}
              />

              <label htmlFor="channels">Channels</label>
              <textarea
                id="channels"
                value={channelText}
                placeholder={'#packs\n#private channelkey'}
                onChange={(e) => setChannelText(e.target.value)}
              />
              <div className="hint">One per line. Add a space and the key for keyed channels.</div>
            </div>
          </fieldset>

          <fieldset>
            <legend>Authentication</legend>
            <div className="grid">
              <label className="checkline" style={{ gridColumn: '1 / -1' }}>
                <input
                  type="checkbox"
                  checked={useSasl}
                  onChange={(e) => setUseSasl(e.target.checked)}
                />
                Use SASL (preferred when the network supports it)
              </label>

              {useSasl ? (
                <>
                  <label htmlFor="sasl-account">SASL account</label>
                  <input
                    id="sasl-account"
                    value={draft.network.sasl?.account ?? ''}
                    placeholder={draft.network.nick}
                    onChange={(e) =>
                      patchNetwork({
                        sasl: {
                          account: e.target.value,
                          password: draft.network.sasl?.password ?? '',
                        },
                      })
                    }
                  />
                  <label htmlFor="sasl-password">SASL password</label>
                  <input
                    id="sasl-password"
                    type="password"
                    value={draft.network.sasl?.password ?? ''}
                    onChange={(e) =>
                      patchNetwork({
                        sasl: {
                          account: draft.network.sasl?.account ?? draft.network.nick,
                          password: e.target.value,
                        },
                      })
                    }
                  />
                </>
              ) : null}

              <label className="checkline" style={{ gridColumn: '1 / -1' }}>
                <input
                  type="checkbox"
                  checked={useNickServ}
                  onChange={(e) => setUseNickServ(e.target.checked)}
                />
                Fall back to NickServ IDENTIFY
              </label>

              {useNickServ ? (
                <>
                  <label htmlFor="ns-password">NickServ password</label>
                  <input
                    id="ns-password"
                    type="password"
                    value={draft.network.nickserv?.password ?? ''}
                    onChange={(e) => patchNetwork({ nickserv: { password: e.target.value } })}
                  />
                </>
              ) : null}
            </div>
          </fieldset>

          <fieldset>
            <legend>Downloads</legend>
            <div className="grid">
              <label htmlFor="dir">Folder</label>
              <div className="row">
                <input
                  id="dir"
                  style={{ flex: 1 }}
                  value={draft.downloadDir}
                  onChange={(e) => setDraft((d) => ({ ...d, downloadDir: e.target.value }))}
                />
                <button onClick={browse}>Browse…</button>
              </div>

              <label htmlFor="max">Concurrent</label>
              <div className="row">
                <input
                  id="max"
                  style={{ width: 70 }}
                  value={String(draft.maxConcurrent)}
                  onChange={(e) => setDraft((d) => ({ ...d, maxConcurrent: num(e.target.value, 2) }))}
                />
                <label htmlFor="retries" style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                  Retries
                </label>
                <input
                  id="retries"
                  style={{ width: 70 }}
                  value={String(draft.maxRetries)}
                  onChange={(e) => setDraft((d) => ({ ...d, maxRetries: num(e.target.value, 2) }))}
                />
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend>Reverse DCC</legend>
            <div className="grid">
              <label htmlFor="extip">External IP</label>
              <input
                id="extip"
                value={draft.passive.externalIp ?? ''}
                placeholder="auto-detect (only works without NAT)"
                onChange={(e) =>
                  patchPassive({ externalIp: e.target.value.trim() || undefined })
                }
              />
              <div className="hint">
                Needed when you are behind a router. Forward the port range below to this
                machine.
              </div>

              <label htmlFor="portlow">Port range</label>
              <div className="row">
                <input
                  id="portlow"
                  style={{ width: 90 }}
                  value={String(draft.passive.portRange[0])}
                  onChange={(e) =>
                    patchPassive({
                      portRange: [num(e.target.value, 59000), draft.passive.portRange[1]],
                    })
                  }
                />
                <span style={{ color: 'var(--text-faint)' }}>to</span>
                <input
                  style={{ width: 90 }}
                  value={String(draft.passive.portRange[1])}
                  onChange={(e) =>
                    patchPassive({
                      portRange: [draft.passive.portRange[0], num(e.target.value, 59100)],
                    })
                  }
                />
              </div>
            </div>
          </fieldset>

          {error ? <div className="error">{error}</div> : null}
        </div>

        <footer>
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
