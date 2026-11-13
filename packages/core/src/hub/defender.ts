/**
 * Windows Defender through its own command-line tools (ADR 0019). XtraOS (rightly) blocks the
 * Windows Security app, so the brain cannot click through security settings; this tool can only
 * read the status, update the virus definitions and run a quick scan. It changes no setting and
 * takes no free-form command.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export const DEFENDER = 'magnus__defender';

export const DEFENDER_TOOL: Tool = {
  name: DEFENDER,
  description:
    'Windows Defender (antivirus) without the Windows Security app (that app is blocked for the agent): op "status" (protection on/off, definitions age, last scans, threats found), "update" (download new virus definitions), "quick_scan" (scan now, a few minutes, then the result). It cannot change any setting.',
  inputSchema: { type: 'object', properties: { op: { type: 'string', enum: ['status', 'update', 'quick_scan'] } }, required: ['op'] },
};

const done = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/** Runs a program, returns its exit code and output (no shell). */
function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(file, args, { windowsHide: true });
    let out = '';
    c.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    c.stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    const t = setTimeout(() => c.kill(), timeoutMs);
    c.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: e.message });
    });
    c.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

const STATUS_PS =
  "$s=Get-MpComputerStatus; $t=@(Get-MpThreatDetection -ErrorAction SilentlyContinue | Sort-Object InitialDetectionTime -Descending | Select-Object -First 5 | ForEach-Object { $n=(Get-MpThreat -ThreatID $_.ThreatID -ErrorAction SilentlyContinue).ThreatName; [pscustomobject]@{name=$n; when=$_.InitialDetectionTime.ToString('s'); action=$_.ThreatStatusID} }); [pscustomobject]@{antivirus=$s.AntivirusEnabled; realtime=$s.RealTimeProtectionEnabled; definitions=$s.AntivirusSignatureLastUpdated.ToString('s'); definitionsAgeDays=$s.AntivirusSignatureAge; lastQuickScan=$(if($s.QuickScanEndTime){$s.QuickScanEndTime.ToString('s')}else{''}); lastFullScan=$(if($s.FullScanEndTime){$s.FullScanEndTime.ToString('s')}else{''}); threats=$t} | ConvertTo-Json -Depth 4 -Compress";

/** A short report from Get-MpComputerStatus JSON (pure). */
export function defenderReport(json: string): string {
  const s = JSON.parse(json) as { antivirus?: boolean; realtime?: boolean; definitions?: string; definitionsAgeDays?: number; lastQuickScan?: string; lastFullScan?: string; threats?: { name?: string; when?: string }[] | { name?: string; when?: string } };
  const threats = Array.isArray(s.threats) ? s.threats : s.threats ? [s.threats] : [];
  return [
    `Antivirus: ${s.antivirus ? 'on' : 'OFF'}; real-time protection: ${s.realtime ? 'on' : 'OFF'}.`,
    `Virus definitions: ${s.definitions?.replace('T', ' ') ?? '?'} (${s.definitionsAgeDays ?? '?'} day(s) old).`,
    `Last quick scan: ${s.lastQuickScan ? s.lastQuickScan.replace('T', ' ') : 'never'}; last full scan: ${s.lastFullScan ? s.lastFullScan.replace('T', ' ') : 'never'}.`,
    threats.length === 0 ? 'Threats found so far: none.' : `Threats on record (newest first): ${threats.map((t) => `${t.name ?? 'unknown'} (${t.when?.replace('T', ' ') ?? '?'})`).join('; ')}.`,
  ].join('\n');
}

export async function defender(op: unknown): Promise<CallToolResult> {
  const mp = path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe');
  const status = async (): Promise<string> => {
    // The full path: a powershell.exe planted somewhere on the search path must never run instead.
    const ps = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const r = await run(ps, ['-NoProfile', '-NonInteractive', '-Command', STATUS_PS], 60_000);
    try {
      return defenderReport(r.out.trim().split('\n').at(-1) ?? '{}');
    } catch {
      return `Could not read the Defender status: ${r.out.trim().slice(0, 200)}`;
    }
  };
  if (op === 'status') return done(await status());
  if (op === 'update') {
    const r = await run(mp, ['-SignatureUpdate'], 10 * 60_000);
    return done(`${r.code === 0 ? 'Virus definitions updated.' : `The update did not finish (exit ${r.code}): ${r.out.trim().split('\n').at(-1) ?? ''}`}\n${await status()}`, r.code !== 0);
  }
  if (op === 'quick_scan') {
    const t0 = Date.now();
    const r = await run(mp, ['-Scan', '-ScanType', '1'], 9 * 60_000);
    const mins = Math.round((Date.now() - t0) / 6000) / 10;
    // MpCmdRun: 0 = scanned, nothing found; 2 = threats found (Defender handles them by its own rules).
    const what = r.code === 0 ? `Quick scan finished in ${mins} min: no threats found.` : r.code === 2 ? `Quick scan finished in ${mins} min: threats were found (Defender deals with them by its own settings).` : `The quick scan did not finish (exit ${r.code}): ${r.out.trim().split('\n').at(-1) ?? ''}`;
    return done(`${what}\n${await status()}`, r.code !== 0 && r.code !== 2);
  }
  return done('op is "status", "update" or "quick_scan"', true);
}
