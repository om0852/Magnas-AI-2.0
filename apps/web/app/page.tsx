import { BRAIN_NAMES, brainConfig, dashboardState, MagnusError, sync, type Action, type DashboardState } from '@magnus/core';
import { env, refusal, syncDeps } from '@/lib/guard';
import { AskPanel } from './ui/AskPanel';
import { DevicesPanel } from './ui/DevicesPanel';
import { RelayPanel } from './ui/RelayPanel';
import { ModeSwitch } from './ui/ModeSwitch';
import { SyncPanel } from './ui/SyncPanel';

export const dynamic = 'force-dynamic';

function Shell({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <main>
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true">M</span>
          <div>
            <h1>Magnus</h1>
            {sub !== undefined && <p className="muted small path">{sub}</p>}
          </div>
        </div>
        <span className="pill">this PC only</span>
      </header>
      {children}
    </main>
  );
}

function Message({ title, text, hint }: { title: string; text: string; hint?: string }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <p>{text}</p>
      {hint !== undefined && hint !== '' && <pre className="code">{hint}</pre>}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="tile">
      <span className="tile-value">{value}</span>
      <span className="tile-label">{label}</span>
    </div>
  );
}

export default async function Page() {
  if (await refusal('GET')) {
    return (
      <Shell>
        <Message title="Open the dashboard from its link" text="Start it on this PC and open the link it prints (the link carries a one-time token for this run):" hint="npm run dashboard" />
      </Shell>
    );
  }

  const e = env();
  let state: DashboardState;
  let plan: Action[] = [];
  let planError: MagnusError | null = null;
  try {
    state = dashboardState(e);
  } catch (err) {
    if (!(err instanceof MagnusError)) throw err;
    return (
      <Shell>
        <Message title="No registry yet" text={err.message} hint={err.hint.replace(/^Run: /, '')} />
      </Shell>
    );
  }
  try {
    plan = sync(e, { apply: false, force: false }, syncDeps(e)).actions;
  } catch (err) {
    if (!(err instanceof MagnusError)) throw err;
    planError = err;
  }

  const installed = state.tools.filter((t) => t.installed);
  const others = state.tools.filter((t) => !t.installed);
  const toolNames = Object.fromEntries(state.tools.map((t) => [t.id, t.name]));

  return (
    <Shell sub={state.registryFile}>
      <div className="tiles">
        <Tile label="MCP servers" value={state.servers.length} />
        <Tile label="Skills" value={state.skills.length} />
        <Tile label="Rule lines" value={state.rulesLines} />
        <Tile label="Secrets" value={state.secrets.length} />
        <Tile label="AI tools here" value={installed.length} />
      </div>

      {(() => {
        const b = brainConfig(e);
        return <AskPanel brains={b.order.map((id) => BRAIN_NAMES[id]).join(', then ')} servers={b.servers.join(', ')} timeoutSec={b.timeoutSec} />;
      })()}

      <RelayPanel />

      <DevicesPanel />

      {planError ? (
        <Message title="Sync cannot be planned" text={planError.message} hint={planError.hint.replace(/^Run: /, '')} />
      ) : (
        <SyncPanel plan={plan} toolNames={toolNames} />
      )}

      <section className="card" aria-labelledby="tools-h">
        <h2 id="tools-h">AI tools</h2>
        <p className="muted">Direct: every server is written into the tool. Hub: the tool gets one entry, the Magnus hub. A change shows up in Sync above.</p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Gets from Magnus</th>
                <th>Servers through</th>
              </tr>
            </thead>
            <tbody>
              {installed.map((t) => (
                <tr key={t.id}>
                  <td>
                    <strong>{t.name}</strong>
                    {!t.enabled && <span className="badge warn">switched off</span>}
                    {t.note !== undefined && <div className="muted small">{t.note}</div>}
                  </td>
                  <td>{t.gets.join(' · ')}</td>
                  <td>{t.gets.includes('MCP') ? <ModeSwitch id={t.id} name={t.name} mode={t.mode} /> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {others.length > 0 && <p className="muted small">Not installed on this PC: {others.map((t) => t.name).join(', ')}.</p>}
      </section>

      <section className="card" aria-labelledby="servers-h">
        <h2 id="servers-h">MCP servers</h2>
        {state.servers.length === 0 ? (
          <p className="muted">None yet. Add one with <code>magnus add-mcp</code> or take over existing ones with <code>magnus import</code>.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Starts with</th>
                  <th>Settings</th>
                  <th>Goes to</th>
                </tr>
              </thead>
              <tbody>
                {state.servers.map((s) => (
                  <tr key={s.name}>
                    <td><strong>{s.name}</strong></td>
                    <td>
                      <code>{s.command}</code>
                      <span className="muted small"> {s.argCount > 0 ? `+ ${s.argCount} argument${s.argCount === 1 ? '' : 's'}` : ''}</span>
                    </td>
                    <td>
                      {s.envKeys.length === 0 ? <span className="muted">—</span> : s.envKeys.map((k) => <code className="chip" key={k}>{k}</code>)}
                      {s.usesSecrets && <span className="badge ok">uses secrets</span>}
                    </td>
                    <td>{s.clients === null ? 'All tools' : s.clients.map((id) => toolNames[id] ?? id).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="two">
        <section className="card" aria-labelledby="skills-h">
          <h2 id="skills-h">Skills</h2>
          {state.skills.length === 0 ? <p className="muted">None. Put a folder with a SKILL.md in the registry’s <code>skills</code> folder.</p> : <p>{state.skills.map((s) => <code className="chip" key={s}>{s}</code>)}</p>}
        </section>
        <section className="card" aria-labelledby="rules-h">
          <h2 id="rules-h">Rules and secrets</h2>
          <p>{state.rulesLines === 0 ? 'No shared rules yet.' : `${state.rulesLines} line${state.rulesLines === 1 ? '' : 's'} of rules go into each tool’s rules file.`}</p>
          <p>
            {state.secrets.length === 0 ? <span className="muted">No secrets stored.</span> : state.secrets.map((s) => <code className="chip" key={s}>{s}</code>)}
          </p>
          <p className="muted small">Secret values are never shown here.</p>
        </section>
      </div>
    </Shell>
  );
}
