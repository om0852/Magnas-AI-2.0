/**
 * Magnus on the phone, through the owner's relay (ADR 0010). Everything to and from the PC is
 * end-to-end encrypted; the relay only passes it on. Keys live in this browser's IndexedDB and
 * the private ones cannot be exported.
 */
import { b64u, ecdhKeyPair, inviteFromFragment, type PairInvite } from '../../../packages/core/src/e2e.js';
import { pairPhone, PhoneSession, type PhoneIdentity } from '../../../packages/core/src/phone-client.js';

// ---- storage ------------------------------------------------------------------------------

const DB = 'magnus-relay';
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function get<T>(key: string): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}
async function put(key: string, value: unknown): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction('kv', 'readwrite');
    value === undefined ? t.objectStore('kv').delete(key) : t.objectStore('kv').put(value, key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** The approval signing key (XtraOS ADR 0076), separate from the encryption key. */
async function approvalKey(): Promise<CryptoKeyPair> {
  const have = await get<CryptoKeyPair>('approval');
  if (have) return have;
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  await put('approval', pair);
  return pair;
}
const std64 = (b: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(b)));
async function approvalCode(): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', (await approvalKey()).publicKey);
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`.toUpperCase();
}

// ---- tiny DOM helpers ---------------------------------------------------------------------

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, unknown>> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const app = document.getElementById('app') as HTMLElement;
/** Leaves out empty children (for replaceChildren / append). */
const only = (...c: Child[]): (Node | string)[] => c.filter((x): x is Node | string => x !== null && x !== undefined && x !== false);
const notice = (ok: boolean, text: string): HTMLElement => h('p', { class: ok ? 'notice ok' : 'notice bad', role: 'status' }, text);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const relayUrl = (): string => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

function header(status?: HTMLElement): HTMLElement {
  return h('header', { class: 'top' }, h('div', { class: 'brand' }, h('span', { class: 'mark', 'aria-hidden': 'true' }, 'M'), h('h1', {}, 'Magnus')), status ?? null);
}

// ---- pairing ------------------------------------------------------------------------------

function pairView(invite: PairInvite): void {
  const name = h('input', { value: 'My phone', maxLength: 40, required: true });
  const out = h('div');
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Pair with my PC');
  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        btn.disabled = true;
        btn.textContent = 'Pairing…';
        out.replaceChildren();
        try {
          const keys = await ecdhKeyPair(false);
          const deviceId = await pairPhone(relayUrl(), invite, keys, name.value.trim() || 'phone');
          const id: PhoneIdentity = { keys, relayUrl: relayUrl(), room: invite.room, pcKey: invite.pcKey, deviceId };
          await put('identity', id);
          history.replaceState(null, '', '/'); // the secret leaves the address bar
          void start();
        } catch (err) {
          out.replaceChildren(notice(false, errText(err)));
          btn.disabled = false;
          btn.textContent = 'Pair with my PC';
        }
      },
    },
    h('label', {}, 'Name for this phone', name),
    btn,
  );
  app.replaceChildren(header(), h('section', { class: 'card' }, h('h2', {}, 'Pair this phone'), h('p', { class: 'muted' }, 'Your PC made this link. After pairing, everything between this phone and your PC is encrypted; the relay cannot read it.'), form, out));
}

// ---- the app ------------------------------------------------------------------------------

interface Dialog {
  uid: string;
  title: string;
  message: string;
  buttons: string[];
  cancel: number;
}
interface Control {
  ref: string;
  role: string;
  name: string;
  off: boolean;
}

async function main(id: PhoneIdentity): Promise<void> {
  const status = h('span', { class: 'status' }, 'connecting…');
  const body = h('div');
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Sections' });
  app.replaceChildren(header(status), tabs, body);
  const setStatus = (s: string, cls: string): void => {
    status.textContent = s;
    status.className = `status ${cls}`;
  };

  let session: PhoneSession | null = null;
  let retry = 1000;
  const connect = async (): Promise<void> => {
    setStatus('connecting…', '');
    const s = new PhoneSession(id);
    s.onStatus = (st) => {
      if (st === 'offline') setStatus('PC offline', 'offline');
      if (st === 'online') {
        // The PC came back: a new session is needed (it has forgotten the old one).
        session?.close();
      }
      if (st === 'closed' && session === s) {
        session = null;
        setStatus('reconnecting…', 'offline');
        setTimeout(() => void connect(), retry);
        retry = Math.min(retry * 2, 30_000);
      }
    };
    try {
      await s.open();
      session = s;
      retry = 1000;
      setStatus('connected', 'online');
    } catch (e) {
      const msg = errText(e);
      if (/no longer paired/.test(msg)) {
        await put('identity', undefined);
        app.replaceChildren(header(), h('section', { class: 'card' }, h('h2', {}, 'Not paired'), h('p', {}, 'Your PC no longer knows this phone. Make a new pairing code on the PC and open it here.')));
        return;
      }
      setStatus(/offline/.test(msg) ? 'PC offline' : 'no connection', 'offline');
      setTimeout(() => void connect(), retry);
      retry = Math.min(retry * 2, 30_000);
    }
  };
  const call = <T>(method: string, params: Record<string, unknown> = {}, ms?: number): Promise<T> => {
    if (!session) return Promise.reject(new Error('not connected to your PC yet'));
    return session.call<T>(method, params, ms);
  };

  // Approvals ------------------------------------------------------------------------------
  let timer: ReturnType<typeof setInterval> | undefined;
  const approvals = (): void => {
    const list = h('div');
    const msg = h('div');
    const setup = h('div', { class: 'setup hidden' });
    const render = async (): Promise<void> => {
      if (!session) return;
      try {
        const r = await call<{ dialogs: Dialog[]; canAnswer: boolean; approverId: string | null }>('approvals.list');
        list.replaceChildren(...(r.dialogs.length === 0 ? [h('p', { class: 'muted' }, 'Nothing is waiting for you. This list updates by itself.')] : []));
        for (const d of r.dialogs) {
          const row = h('div', { class: 'row' });
          d.buttons.forEach((b, i) =>
            row.append(
              h('button', {
                class: i === d.cancel ? 'secondary' : 'primary',
                disabled: !r.canAnswer,
                onclick: async () => {
                  try {
                    const issued_ms = Date.now();
                    const text = `xtraos-approval-v1\n${r.approverId}\n${d.uid}\n${i}\n${issued_ms}`;
                    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (await approvalKey()).privateKey, new TextEncoder().encode(text));
                    await call('approvals.answer', { uid: d.uid, button: i, issued_ms, signature: std64(sig) });
                    msg.replaceChildren(notice(true, `Answered: ${b}`));
                    void render();
                  } catch (e) {
                    msg.replaceChildren(notice(false, errText(e)));
                  }
                },
              }, b),
            ),
          );
          list.append(h('div', { class: 'dialog' }, h('h3', {}, d.title), h('p', { class: 'dialog-text' }, d.message), r.canAnswer ? row : h('p', { class: 'muted small' }, 'Answer on the PC, or allow this phone below.')));
        }
        setup.classList.toggle('hidden', r.canAnswer);
      } catch (e) {
        msg.replaceChildren(notice(false, errText(e)));
      }
    };
    const allowBtn = h('button', { class: 'primary' }, 'Allow this phone to answer');
    allowBtn.addEventListener('click', async () => {
      allowBtn.disabled = true;
      allowBtn.textContent = 'Waiting for Allow on the PC…';
      code.textContent = await approvalCode();
      try {
        const raw = await crypto.subtle.exportKey('raw', (await approvalKey()).publicKey);
        await call('approver.add', { publicKey: std64(raw) }, 160_000);
        msg.replaceChildren(notice(true, 'This phone can now answer XtraOS dialogs.'));
        void render();
      } catch (e) {
        msg.replaceChildren(notice(false, errText(e)));
      } finally {
        allowBtn.disabled = false;
        allowBtn.textContent = 'Allow this phone to answer';
      }
    });
    const code = h('p', { class: 'code-big' });
    setup.append(h('p', { class: 'small' }, 'Let this phone answer XtraOS dialogs. XtraOS will ask on the PC screen; check it shows the same code as here.'), code, allowBtn);
    body.replaceChildren(h('section', { class: 'card' }, h('h2', {}, 'Approvals'), list, setup, msg));
    void render();
    timer = setInterval(() => void render(), 2500);
  };

  // Windows --------------------------------------------------------------------------------
  const windows = (): void => {
    const card = h('section', { class: 'card' });
    body.replaceChildren(card);
    const showList = async (): Promise<void> => {
      card.replaceChildren(h('h2', {}, 'Windows'), h('p', { class: 'muted' }, 'Reading…'));
      try {
        const r = await call<{ windows: { ref: string; title: string; process: string; focused: boolean; state: string }[] }>('windows');
        const ul = h('ul', { class: 'win-list' });
        for (const w of r.windows) {
          ul.append(h('li', {}, h('button', { onclick: () => void showWindow(w.ref, w.title) }, h('span', { class: 'win-name' }, w.title || '(no title)'), h('span', { class: 'muted small' }, `${w.process}${w.focused ? ' · in front' : ''}${w.state === 'minimized' ? ' · minimized' : ''}`))));
        }
        card.replaceChildren(h('div', { class: 'row spread' }, h('h2', {}, 'Windows'), h('button', { class: 'secondary', onclick: () => void showList() }, 'Refresh')), ul);
      } catch (e) {
        card.replaceChildren(h('h2', {}, 'Windows'), notice(false, errText(e)));
      }
    };
    const showWindow = async (ref: string, title: string, done?: string): Promise<void> => {
      const msg = h('div');
      card.replaceChildren(h('div', { class: 'row spread' }, h('button', { class: 'secondary', onclick: () => void showList() }, '← Windows'), h('button', { class: 'secondary', onclick: () => void showWindow(ref, title) }, 'Refresh')), h('h2', { class: 'win-title' }, title), h('p', { class: 'muted' }, 'Reading…'));
      try {
        const v = await call<{ text: string; tap: Control[]; type: Control[]; dialog: string | null }>('window', { w: ref });
        const act = async (params: Record<string, unknown>, ok: string): Promise<void> => {
          try {
            await call('act', { window: ref, ...params }, 100_000);
            void showWindow(ref, title, ok);
          } catch (e) {
            msg.replaceChildren(notice(false, errText(e)));
          }
        };
        const chips = h('div', { class: 'chips' });
        for (const c of v.tap.slice(0, 60)) chips.append(h('button', { class: 'chip-btn', disabled: c.off, onclick: () => void act({ op: 'click', ref: c.ref }, `Tapped "${c.name}"`) }, c.name));
        const target = h('select', { 'aria-label': 'Type into' }, h('option', { value: '' }, 'The focused field'), ...v.type.map((c) => h('option', { value: c.ref }, `${c.role}: ${c.name || '(no name)'}`)));
        const firstField = v.type.find((c) => !c.off);
        if (firstField) target.value = firstField.ref;
        const text = h('textarea', { rows: 2, maxLength: 4000, placeholder: 'Text to type' });
        const form = h('form', { class: 'stack', onsubmit: (e: Event) => { e.preventDefault(); if (text.value) void act({ op: 'type', text: text.value, submit: true, ...(target.value ? { ref: target.value } : {}) }, 'Typed and pressed Enter'); } }, v.type.length > 0 ? target : null, text, h('button', { class: 'primary' }, 'Type and press Enter'));
        card.replaceChildren(...only(
          h('div', { class: 'row spread' }, h('button', { class: 'secondary', onclick: () => void showList() }, '← Windows'), h('button', { class: 'secondary', onclick: () => void showWindow(ref, title) }, 'Refresh')),
          h('h2', { class: 'win-title' }, title),
          v.dialog !== null ? notice(false, v.dialog) : null,
          h('pre', { class: 'win-text' }, v.text || '(no text)'),
          v.tap.length > 0 ? h('h3', {}, 'Buttons') : null,
          v.tap.length > 0 ? chips : null,
          h('h3', {}, 'Type'),
          form,
          done !== undefined ? notice(true, done) : null,
          msg,
        ));
      } catch (e) {
        card.append(notice(false, errText(e)));
      }
    };
    void showList();
  };

  // Ask ------------------------------------------------------------------------------------
  const askView = (): void => {
    const text = h('textarea', { rows: 3, maxLength: 4000, placeholder: 'e.g. Is Claude waiting for me? What does it ask?' });
    const btn = h('button', { class: 'primary' }, 'Run');
    const out = h('div');
    const form = h('form', {
      class: 'stack',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!text.value.trim()) return;
        btn.disabled = true;
        btn.textContent = 'Working… (15-70 s)';
        out.replaceChildren();
        try {
          const r = await call<{ ok: boolean; answer: string; brain: string | null }>('ask', { task: text.value }, 330_000);
          out.replaceChildren(h('div', { class: r.ok ? 'answer' : 'answer failed' }, h('pre', { class: 'answer-text' }, r.answer)));
        } catch (err) {
          out.replaceChildren(notice(false, errText(err)));
        } finally {
          btn.disabled = false;
          btn.textContent = 'Run';
        }
      },
    }, text, btn);
    body.replaceChildren(h('section', { class: 'card' }, h('h2', {}, 'Ask Magnus'), h('p', { class: 'muted' }, 'A task in plain words, done on your PC. Risky steps still need your approval (Approvals tab).'), form, out));
  };

  const views = { Approvals: approvals, Windows: windows, Ask: askView } as const;
  const select = (name: keyof typeof views): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.textContent === name));
    views[name]();
  };
  for (const name of Object.keys(views) as (keyof typeof views)[]) tabs.append(h('button', { onclick: () => select(name) }, name));
  app.append(
    h('button', {
      class: 'danger-link',
      onclick: async () => {
        if (!confirm('Forget your PC on this phone? You will need a new pairing code.')) return;
        session?.close();
        await put('identity', undefined);
        location.reload();
      },
    }, 'Forget this PC'),
  );

  await connect();
  select('Approvals');
}

async function start(): Promise<void> {
  if (!window.isSecureContext || !crypto.subtle) {
    app.replaceChildren(header(), h('section', { class: 'card' }, h('h2', {}, 'Needs https'), h('p', {}, 'Open Magnus through the relay\'s https address.')));
    return;
  }
  const m = /#p=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m) {
    try {
      return pairView(inviteFromFragment(m[1] as string));
    } catch (e) {
      app.replaceChildren(header(), notice(false, errText(e)));
      return;
    }
  }
  const id = await get<PhoneIdentity>('identity');
  if (!id) {
    app.replaceChildren(header(), h('section', { class: 'card' }, h('h2', {}, 'Pair this phone'), h('p', {}, 'On your PC, open the Magnus dashboard → Phones → "Pair over the relay" and scan the QR code with this phone.'), h('p', { class: 'muted small' }, `This phone's id: ${b64u(crypto.getRandomValues(new Uint8Array(3)))}`)));
    return;
  }
  await main(id);
}

void start();
