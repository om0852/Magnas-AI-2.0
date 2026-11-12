/** The controls of a window as a phone shows them, from XtraOS observe lines (pure). */
export interface Control {
  ref: string;
  role: string;
  name: string;
  value?: string;
  off: boolean;
}

const TAPPABLE = new Set(['Button', 'MenuItem', 'ListItem', 'TabItem', 'CheckBox', 'RadioButton', 'Hyperlink', 'SplitButton']);
const TYPABLE = new Set(['Edit', 'ComboBox', 'Document']);

/** Lines like `e12 Button "Save"` or `e7 Edit "Search" = "x" (off)` from XtraOS observe (pure). */
export function controlsFrom(observe: string): { tap: Control[]; type: Control[]; dialog: string | null } {
  const tap: Control[] = [];
  const type: Control[] = [];
  let dialog: string | null = null;
  for (const line of observe.split('\n')) {
    if (line.startsWith('!! dialog')) dialog = line.slice(3);
    const m = /^(e\d+) (\w+) "((?:[^"\\]|\\.)*)"(?: = "((?:[^"\\]|\\.)*)")?(.*)$/.exec(line.trim());
    if (!m) continue;
    const c: Control = { ref: m[1] as string, role: m[2] as string, name: m[3] as string, off: /\(off\)/.test(m[5] ?? '') };
    if (m[4] !== undefined) c.value = m[4];
    if (TAPPABLE.has(c.role) && c.name !== '') tap.push(c);
    else if (TYPABLE.has(c.role)) type.push(c);
  }
  return { tap, type, dialog };
}
