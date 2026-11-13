/**
 * Magnus on the phone, through the owner's relay (ADR 0010). Everything to and from the PC is
 * end-to-end encrypted; the relay only passes it on. Keys live in this browser's IndexedDB and
 * the private ones cannot be exported.
 */
import { ecdhKeyPair, inviteFromFragment, type PairInvite } from '../../../packages/core/src/e2e.js';
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
/** Line icons (static SVG paths, never user text). */
const ICONS: Record<string, string> = {
  menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  newchat: '<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
  Approvals: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z"/><path d="m9 12 2 2 4-4"/>',
  Tasks: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>',
  Windows: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  send: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/>',
};
function icon(name: string, size = 18): HTMLElement {
  const s = document.createElement('span');
  s.className = 'ico';
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`;
  return s;
}
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


// ---- voice typing (ADR 0012) ----------------------------------------------------------------
// The browser's own speech recognition (Chrome, Edge, Safari). In Chrome, Google's speech
// service turns the audio into text.

interface Rec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
const Recognizer = (): (new () => Rec) | null => {
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
const VOICE_WHY: Record<string, string> = {
  'not-allowed': 'Microphone blocked: allow it for this site in the browser settings.',
  'service-not-allowed': 'Microphone blocked: allow it for this site in the browser settings.',
  'no-speech': 'Nothing heard. Tap the mic and speak again.',
  'audio-capture': 'No microphone found.',
  network: 'Voice typing needs an internet connection.',
};

/** Voice languages: Indian English by default (owner's accent); kept on this phone. */
const VOICE_LANGS: [string, string][] = [['en-IN', 'English (India)'], ['hi-IN', 'हिन्दी (Hindi)'], ['mr-IN', 'मराठी (Marathi)'], ['en-US', 'English (US)']];
const voiceLang = (): string => {
  try {
    return localStorage.getItem('magnus.voiceLang') ?? 'en-IN';
  } catch {
    return 'en-IN';
  }
};
const setVoiceLang = (l: string): void => {
  try {
    localStorage.setItem('magnus.voiceLang', l);
  } catch {
    // private mode: this visit only
  }
};
/** Android Chrome repeats earlier words in continuous mode: there, one phrase per tap. */
const ONE_PHRASE = /Android/i.test(navigator.userAgent);

/** A mic button that types what you say into `field` (null when the browser cannot). */
function micFor(field: HTMLTextAreaElement): HTMLElement | null {
  const R = Recognizer();
  if (!R) return null;
  let rec: Rec | null = null;
  const live = h('span', { class: 'small muted live' });
  const btn = h('button', { type: 'button', class: 'mic', 'aria-label': 'Speak instead of typing', title: 'Speak' }, icon('mic', 20));
  const stopUi = (): void => {
    rec = null;
    btn.className = 'mic';
    btn.replaceChildren(icon('mic', 20));
    btn.setAttribute('aria-label', 'Speak instead of typing');
    live.textContent = '';
  };
  btn.addEventListener('click', () => {
    if (rec) {
      rec.stop();
      return;
    }
    const r = new R();
    r.lang = voiceLang();
    r.continuous = !ONE_PHRASE;
    r.interimResults = true;
    let added = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res) continue;
        if (res.isFinal) {
          const t = res[0].transcript.trim();
          if (t === '' || t === added) continue; // the same phrase sent twice
          added = t;
          field.value = field.value.trim() === '' ? t : `${field.value.trimEnd()} ${t}`;
          field.dispatchEvent(new Event('input', { bubbles: true }));
        } else interim += res[0].transcript;
      }
      live.textContent = interim || 'Listening…';
    };
    let problem = '';
    r.onerror = (e) => {
      problem = VOICE_WHY[e.error] ?? `Voice stopped: ${e.error}`;
    };
    r.onend = () => {
      stopUi();
      live.textContent = problem; // empty unless something went wrong
    };
    rec = r;
    r.start();
    btn.className = 'mic on';
    btn.replaceChildren(icon('stop', 18));
    btn.setAttribute('aria-label', 'Stop listening');
    live.textContent = 'Listening…';
  });
  return h('span', { class: 'mic-wrap' }, btn, live);
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
  const body = h('div', { class: 'view' });
  // ChatGPT-style shell (ADR 0015): top bar, slide-in drawer with chats and sections.
  const titleEl = h('div', { class: 'bar-title' }, 'Magnus');
  const chatList = h('ul', { class: 'chat-list' });
  const nav = h('nav', { class: 'drawer-nav', 'aria-label': 'Sections' });
  const openDrawer = (open: boolean): void => {
    app.classList.toggle('open', open);
    if (open) void refreshChats();
  };
  const bar = h('header', { class: 'bar' },
    h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Open the menu', onclick: () => openDrawer(true) }, icon('menu', 22)),
    titleEl, status,
    h('button', { class: 'icon-btn', 'aria-label': 'New chat', title: 'New chat', onclick: () => openChat(null) }, icon('newchat', 20)));
  const drawer = h('aside', { class: 'drawer', 'aria-label': 'Chats and sections' },
    h('div', { class: 'drawer-top' }, h('strong', { class: 'brand-name' }, 'Magnus')),
    h('button', { class: 'new-chat', onclick: () => openChat(null) }, icon('newchat'), 'New chat'),
    h('p', { class: 'drawer-h' }, 'Chats'), chatList, nav);
  app.className = 'phone shell';
  app.replaceChildren(bar, body, drawer, h('div', { class: 'scrim', onclick: () => openDrawer(false) }));
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
  const call = <T>(method: string, params: Record<string, unknown> = {}, ms?: number, onProgress?: (p: unknown) => void): Promise<T> => {
    if (!session) return Promise.reject(new Error('not connected to your PC yet'));
    return session.call<T>(method, params, ms, onProgress);
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
        const text = h('textarea', { rows: 2, maxLength: 4000, placeholder: 'Text to type (or tap the mic and speak)' });
        const form = h('form', { class: 'stack', onsubmit: (e: Event) => { e.preventDefault(); if (text.value) void act({ op: 'type', text: text.value, submit: true, ...(target.value ? { ref: target.value } : {}) }, 'Typed and pressed Enter'); } }, v.type.length > 0 ? target : null, text, h('div', { class: 'row' }, micFor(text), h('button', { class: 'primary' }, 'Type and press Enter')));
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

  // Chat (ADR 0015) -----------------------------------------------------------------------------
  const ICON: Record<string, string> = { thinking: '💭', tool: '🔧', 'tool-done': '✓', 'tool-failed': '✗', say: '💬', note: '·' };
  interface ChatMsg { role: 'user' | 'assistant'; text: string; at: string; brain?: string | null; ok?: boolean; steps?: string[] }
  interface ChatSum { id: string; title: string; updated: string; preview: string }
  let current: string | null = null;
  let running = false;
  const refreshChats = async (): Promise<void> => {
    try {
      const r = await call<{ chats: ChatSum[] }>('chats.list');
      chatList.replaceChildren(...(r.chats.length === 0 ? [h('li', { class: 'muted small empty-list' }, 'No chats yet.')] : r.chats.map((c) => {
        const actions = h('div', { class: 'chat-actions hidden' },
          h('button', { onclick: async () => {
            const t = prompt('Rename the chat', c.title);
            if (t === null || t.trim() === '') return;
            try {
              await call('chats.rename', { id: c.id, title: t.trim().slice(0, 80) });
              if (current === c.id) titleEl.textContent = t.trim();
              void refreshChats();
            } catch (e) { alert(errText(e)); }
          } }, 'Rename'),
          h('button', { class: 'bad-text', onclick: async () => {
            if (!confirm(`Delete "${c.title}"?`)) return;
            try {
              await call('chats.delete', { id: c.id });
              if (current === c.id) openChat(null);
              void refreshChats();
            } catch (e) { alert(errText(e)); }
          } }, 'Delete'));
        return h('li', { class: c.id === current ? 'chat-li active' : 'chat-li' },
          h('div', { class: 'chat-row' },
            h('button', { class: 'chat-item', onclick: () => openChat(c.id), title: c.preview }, c.title),
            h('button', { class: 'icon-btn more', 'aria-label': `More for ${c.title}`, onclick: () => actions.classList.toggle('hidden') }, '⋯')),
          actions);
      })));
    } catch (e) {
      chatList.replaceChildren(h('li', { class: 'small bad-text' }, errText(e)));
    }
  };
  const openChat = (id: string | null): void => {
    current = id;
    app.classList.remove('open');
    select('Chat');
  };
  const bubble = (m: ChatMsg): HTMLElement => {
    if (m.role === 'user') return h('div', { class: 'msg user' }, h('div', { class: 'bubble' }, m.text));
    const steps = m.steps ?? [];
    return h('div', { class: 'msg magnus' },
      h('span', { class: 'mark small-mark', 'aria-hidden': 'true' }, 'M'),
      h('div', { class: 'msg-body' },
        h('div', { class: m.ok === false ? 'reply failed' : 'reply' }, m.text),
        steps.length > 0 ? h('details', { class: 'used' }, h('summary', {}, `${steps.length} step${steps.length === 1 ? '' : 's'}${m.brain ? ` · ${m.brain}` : ''}`), h('ol', {}, ...steps.map((x) => h('li', {}, x)))) : null));
  };
  type AskReply = { ok: boolean; answer: string; brain: string | null; chatId: string; title: string };
  const LOST = /connection lost|closed the connection|not connected|did not answer in time/i;
  const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  /** Waits for the connection to come back (up to 15 minutes), then follows the running task. */
  const followCurrent = async (onStep: (p: unknown) => void, label: HTMLElement): Promise<AskReply> => {
    for (let i = 0; i < 900 && session === null; i++) await pause(1000);
    if (session === null) throw new Error('No connection to your PC. The answer will be in this chat when you are back.');
    label.textContent = 'Reconnected. Catching up…';
    const r = await call<AskReply | { running: false }>('ask.follow', {}, 15 * 60_000, onStep);
    if (!('answer' in r)) throw new Error('The task is no longer known on the PC (it was restarted). Open the chat again to see what was saved.');
    return r;
  };
  const SUGGEST = ['What is open on my PC right now?', 'Is Claude Code waiting for me?', 'Play the latest episode in my Downloads'];
  const chatView = (): void => {
    titleEl.textContent = 'New chat';
    const log = h('div', { class: 'msgs', 'aria-live': 'polite' });
    const scroller = h('div', { class: 'chat-scroll' }, log);
    const input = h('textarea', { rows: 1, maxLength: 4000, placeholder: 'Message Magnus', 'aria-label': 'Message' }) as HTMLTextAreaElement;
    const sendBtn = h('button', { class: 'send', type: 'submit', 'aria-label': 'Send' }, icon('send', 20));
    const setBusy = (b: boolean): void => {
      running = b;
      sendBtn.replaceChildren(icon(b ? 'stop' : 'send', 20));
      sendBtn.setAttribute('aria-label', b ? 'Stop' : 'Send');
      sendBtn.classList.toggle('stop', b);
    };
    setBusy(running);
    const toEnd = (): void => { scroller.scrollTop = scroller.scrollHeight; };
    const grow = (): void => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
      input.style.overflowY = input.scrollHeight > 160 ? 'auto' : 'hidden';
    };
    input.addEventListener('input', grow);
    input.addEventListener('input', () => sendBtn.classList.toggle('ready', input.value.trim() !== ''));
    const empty = (): HTMLElement => h('div', { class: 'empty' },
      h('h2', {}, 'What should I do on your PC?'),
      h('div', { class: 'chips' }, ...SUGGEST.map((t) => h('button', { class: 'chip', onclick: () => { input.value = t; grow(); input.focus(); } }, t))));
    const show = (msgs: ChatMsg[]): void => {
      log.replaceChildren(...(msgs.length === 0 ? [empty()] : msgs.map(bubble)));
      // A new chat: the question and the box sit in the middle (wide screens).
      log.closest('.chat')?.classList.toggle('is-empty', msgs.length === 0);
      toEnd();
    };
    const send = async (): Promise<void> => {
      const text = input.value.trim();
      if (text === '') return;
      input.value = '';
      grow();
      log.querySelector('.empty')?.remove();
      log.closest('.chat')?.classList.remove('is-empty');
      sendBtn.classList.remove('ready');
      log.append(bubble({ role: 'user', text, at: '' }));
      const steps = h('ol', { class: 'live-steps' });
      const label = h('span', { class: 'muted small' }, 'Starting the AI on your PC…');
      const typing = h('div', { class: 'typing' }, h('i'), h('i'), h('i'), label);
      const pending = h('div', { class: 'msg magnus' }, h('span', { class: 'mark small-mark', 'aria-hidden': 'true' }, 'M'), h('div', { class: 'msg-body' }, typing, steps));
      log.append(pending);
      toEnd();
      setBusy(true);
      const used: string[] = [];
      // A question from the brain (magnus__ask_user, ADR 0013) shows here in the chat, with answers.
      const askBox = h('div', { class: 'ask-inline hidden' });
      pending.querySelector('.msg-body')?.append(askBox);
      const norm = (x: string): string => x.replace(/\s+/g, ' ').trim().slice(0, 100);
      let shownQid = '';
      const poll = setInterval(() => {
        void call<{ tasks: TaskItem[] }>('tasks.list').then((r) => {
          const t = r.tasks.find((x) => x.status === 'needs-you' && x.question && norm(x.title) === norm(text));
          if (!t?.question) {
            if (shownQid !== '') { askBox.classList.add('hidden'); shownQid = ''; }
            return;
          }
          if (t.question.qid === shownQid) return;
          shownQid = t.question.qid;
          const q = t.question;
          const reply = h('textarea', { rows: 1, maxLength: 2000, placeholder: 'Your answer' }) as HTMLTextAreaElement;
          const answer = async (a: string): Promise<void> => {
            if (a.trim() === '') return;
            try {
              await call('tasks.answer', { task: t.id, qid: q.qid, answer: a.trim() });
              askBox.replaceChildren(h('p', { class: 'muted small' }, `You answered: ${a.trim()}`));
            } catch (e) {
              askBox.append(notice(false, errText(e)));
            }
          };
          askBox.replaceChildren(...only(
            h('p', { class: 'ask-q' }, q.text),
            q.options.length > 0 ? h('div', { class: 'chips' }, ...q.options.map((o) => h('button', { class: 'chip', type: 'button', onclick: () => void answer(o) }, o))) : null,
            h('form', { class: 'ask-form', onsubmit: (e: Event) => { e.preventDefault(); void answer(reply.value); } }, reply, micFor(reply), h('button', { class: 'chip', type: 'submit' }, 'Send'))));
          askBox.classList.remove('hidden');
          toEnd();
        }).catch(() => undefined);
      }, 3000);
      try {
        const onStep = (p: unknown): void => {
          const st = p as { kind: string; text: string; ms: number };
          label.textContent = 'Working…';
          if (st.kind === 'thinking' || st.kind === 'say' || st.kind === 'note') return;
          if (st.kind === 'tool') used.push(st.text);
          steps.append(h('li', { class: `k-${st.kind}` }, h('span', { 'aria-hidden': 'true' }, ICON[st.kind] ?? '·'), ` ${st.text}`));
          toEnd();
        };
        let r: AskReply;
        try {
          r = await call<AskReply>('ask', { task: text, chat: current ?? 'new' }, 15 * 60_000, onStep);
        } catch (e) {
          if (!LOST.test(errText(e))) throw e;
          // The connection dropped: the task keeps running on the PC. Reconnect and catch up (ADR 0017).
          label.textContent = 'Connection lost. Magnus keeps working on your PC; reconnecting…';
          steps.replaceChildren();
          used.length = 0;
          r = await followCurrent(onStep, label);
        }
        if (current === null) {
          current = r.chatId;
          titleEl.textContent = r.title;
        }
        void refreshChats();
        pending.replaceWith(bubble({ role: 'assistant', text: r.answer, at: '', ok: r.ok, brain: r.brain, steps: used }));
      } catch (e) {
        pending.replaceWith(bubble({ role: 'assistant', text: errText(e), at: '', ok: false }));
      } finally {
        clearInterval(poll);
        setBusy(false);
        toEnd();
      }
    };
    const form = h('form', { class: 'composer', onsubmit: (e: Event) => {
      e.preventDefault();
      if (running) {
        void call('ask.stop').catch(() => undefined);
        return;
      }
      void send();
    } }, input, h('div', { class: 'composer-row' }, micFor(input), sendBtn));
    // Enter sends on a keyboard; on a phone Enter makes a new line and the arrow sends.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    body.replaceChildren(h('section', { class: 'chat' }, scroller, form));
    if (current === null) show([]);
    else {
      log.replaceChildren(h('p', { class: 'muted small center' }, 'Loading the chat…'));
      void call<{ chat: { title: string; messages: ChatMsg[] } }>('chats.get', { id: current }).then((r) => {
        titleEl.textContent = r.chat.title;
        show(r.chat.messages);
        const last = r.chat.messages.at(-1);
        if (last?.role === 'user' && !running) void resumeIfRunning(last.text);
      }).catch((e) => log.replaceChildren(notice(false, errText(e))));
    }
    /** After a reload or coming back later: a task still running for this chat shows live again. */
    async function resumeIfRunning(lastText: string): Promise<void> {
      const cur = await call<{ running: boolean; task?: string }>('ask.current').catch(() => ({ running: false }) as { running: boolean; task?: string });
      if (!cur.running || (cur.task ?? '').trim() !== lastText.trim()) return;
      const steps = h('ol', { class: 'live-steps' });
      const label = h('span', { class: 'muted small' }, 'Still working on your PC. Catching up…');
      const pending = h('div', { class: 'msg magnus' }, h('span', { class: 'mark small-mark', 'aria-hidden': 'true' }, 'M'), h('div', { class: 'msg-body' }, h('div', { class: 'typing' }, h('i'), h('i'), h('i'), label), steps));
      log.append(pending);
      toEnd();
      setBusy(true);
      const used: string[] = [];
      try {
        const r = await call<AskReply | { running: false }>('ask.follow', {}, 15 * 60_000, (p) => {
          const st = p as { kind: string; text: string };
          label.textContent = 'Working…';
          if (st.kind !== 'tool' && st.kind !== 'tool-failed') return;
          if (st.kind === 'tool') used.push(st.text);
          steps.append(h('li', { class: `k-${st.kind}` }, h('span', { 'aria-hidden': 'true' }, ICON[st.kind] ?? '·'), ` ${st.text}`));
          toEnd();
        });
        pending.replaceWith('answer' in r ? bubble({ role: 'assistant', text: r.answer, at: '', ok: r.ok, brain: r.brain, steps: used }) : bubble({ role: 'assistant', text: 'The task ended while you were away; reopen the chat to see the answer.', at: '', ok: false }));
      } catch (e) {
        pending.replaceWith(bubble({ role: 'assistant', text: errText(e), at: '', ok: false }));
      } finally {
        setBusy(false);
        toEnd();
      }
    }
  };

  // Tasks (ADR 0013) ---------------------------------------------------------------------------
  interface TaskItem {
    id: string; title: string; source: string; status: 'working' | 'needs-you' | 'done' | 'failed' | 'stopped';
    updated: string; cwd?: string; steps: { at: string; text: string }[];
    question?: { qid: string; text: string; options: string[] }; result?: string;
  }
  const STATUS: Record<TaskItem['status'], [string, string]> = {
    working: ['working', 'badge'], 'needs-you': ['needs you', 'badge warn'], done: ['done', 'badge ok'], failed: ['failed', 'badge bad'], stopped: ['stopped', 'badge'],
  };
  const tasksView = (): void => {
    const list = h('ul', { class: 'task-list' });
    const msg = h('div');
    const opened = new Set<string>();
    const ago = (iso: string): string => {
      const s2 = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
      return s2 < 60 ? `${s2}s ago` : s2 < 3600 ? `${Math.round(s2 / 60)} min ago` : `${Math.round(s2 / 3600)} h ago`;
    };
    const answerBox = (t: TaskItem): HTMLElement => {
      const q = t.question!;
      const text = h('textarea', { rows: 2, maxlength: 2000, placeholder: 'Your answer (or tap the mic)' }) as HTMLTextAreaElement;
      const send = async (answer: string): Promise<void> => {
        try {
          await call('tasks.answer', { task: t.id, qid: q.qid, answer });
          msg.replaceChildren(notice(true, 'Answer sent.'));
          void render(true);
        } catch (e) {
          msg.replaceChildren(notice(false, errText(e)));
        }
      };
      return h('div', { class: 'dialog' },
        h('p', { class: 'dialog-text' }, q.text),
        q.options.length > 0 ? h('div', { class: 'row' }, ...q.options.map((o) => h('button', { class: 'primary', onclick: () => void send(o) }, o))) : null,
        h('form', { class: 'stack', onsubmit: (e: Event) => { e.preventDefault(); if (text.value.trim()) void send(text.value); } },
          text, h('div', { class: 'row' }, micFor(text), h('button', { class: 'primary' }, 'Send answer'))));
    };
    const render = async (force = false): Promise<void> => {
      // Don't redraw under the user's thumb while they write an answer.
      if (!force && list.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA') return;
      try {
        const r = await call<{ tasks: TaskItem[] }>('tasks.list');
        if (!force && list.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA') return;
        list.replaceChildren(...(r.tasks.length === 0 ? [h('li', { class: 'muted' }, 'No tasks yet.')] : r.tasks.map((t) => {
          const open = opened.has(t.id);
          const head = h('button', { class: 'task-head', 'aria-expanded': String(open), onclick: () => { if (open) opened.delete(t.id); else opened.add(t.id); void render(true); } },
            h('span', { class: STATUS[t.status][1] }, STATUS[t.status][0]), h('span', { class: 'task-title' }, t.title), h('span', { class: 'muted small' }, `${t.source} · ${ago(t.updated)}`));
          return h('li', { class: `task s-${t.status}` }, head,
            t.status === 'needs-you' && !t.question && t.steps.length > 0 ? h('p', { class: 'small warn-text' }, t.steps.at(-1)?.text ?? '') : null,
            t.question ? answerBox(t) : null,
            open ? h('div', { class: 'task-body' },
              t.cwd !== undefined ? h('p', { class: 'muted small' }, `in ${t.cwd}`) : null,
              t.steps.length > 0 ? h('ol', { class: 'steps' }, ...t.steps.slice(-15).map((st) => h('li', { class: 'step' }, h('span', { class: 'step-t' }, st.at.slice(11, 16)), h('span', { class: 'step-i' }, '·'), h('span', { class: 'step-x' }, st.text)))) : null,
              t.result !== undefined ? h('pre', { class: 'answer-text' }, t.result) : null) : null,
            !open && t.result !== undefined && t.status !== 'working' ? h('p', { class: 'small muted task-result' }, t.result.replace(/\s+/g, ' ').slice(0, 160)) : null);
        })));
      } catch (e) {
        msg.replaceChildren(notice(false, errText(e)));
      }
    };
    body.replaceChildren(h('section', { class: 'card' }, h('h2', {}, 'Tasks'),
      h('p', { class: 'muted small' }, 'From Magnus and your AI tools. A task that needs you shows its question here; answer with a button, text or your voice.'), msg, list));
    void render(true);
    timer = setInterval(() => void render(), 3000);
  };

  const views = { Chat: chatView, Approvals: approvals, Tasks: tasksView, Windows: windows } as const;
  const select = (name: keyof typeof views): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    app.classList.remove('open');
    body.classList.toggle('padded', name !== 'Chat');
    if (name !== 'Chat') titleEl.textContent = name;
    for (const btn of nav.querySelectorAll('button[data-view]')) btn.setAttribute('aria-current', String(btn.getAttribute('data-view') === name));
    views[name]();
  };
  for (const name of ['Approvals', 'Tasks', 'Windows'] as const) nav.append(h('button', { 'data-view': name, onclick: () => select(name) }, icon(name), name));
  const langPick = h('select', { 'aria-label': 'Voice language', onchange: (e: Event) => setVoiceLang((e.target as HTMLSelectElement).value) },
    ...VOICE_LANGS.map(([v, label]) => h('option', { value: v, selected: v === voiceLang() }, label)));
  nav.append(h('label', { class: 'voice-lang' }, icon('mic'), h('span', {}, 'Voice'), langPick));
  nav.append(
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
  select('Chat');
  void refreshChats();
  // Opening the app while a task runs: go to its chat, which then follows it live (ADR 0017).
  void (async () => {
    const cur = await call<{ running: boolean; task?: string; chat?: string | null }>('ask.current').catch(() => null);
    if (!cur?.running) return;
    if (cur.chat && /^c_[0-9a-f]{16}$/.test(cur.chat)) return openChat(cur.chat);
    const norm = (x: string): string => x.replace(/\s+/g, ' ').trim().slice(0, 80);
    const list = await call<{ chats: ChatSum[] }>('chats.list').catch(() => ({ chats: [] as ChatSum[] }));
    const hit = list.chats.find((c) => norm(c.preview) === norm(cur.task ?? ''));
    if (hit) openChat(hit.id);
  })();
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
    app.replaceChildren(header(), h('section', { class: 'card' }, h('h2', {}, 'Pair this phone'), h('p', {}, 'On your PC, open the Magnus dashboard (npm run dashboard) → "Phones over your relay" → "Pair over the relay", and scan the QR code with this phone\'s camera.')));
    return;
  }
  await main(id);
}

void start();
