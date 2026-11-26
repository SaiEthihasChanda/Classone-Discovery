/**
 * Shared UI primitives: icons, drawer (with expand → full-screen overlay),
 * modal, tabs, segmented control and the wizard step header.
 */
import { useEffect, type ReactNode } from 'react';

// --- Icons (inline SVG, 18px, stroke = currentColor) ------------------------------------
const paths: Record<string, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  prospects: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c.8-3.4 3.4-5.5 6.5-5.5s5.7 2.1 6.5 5.5" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.8 2.7 2.6 3 5.2" />
    </>
  ),
  leads: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7 9h10M7 13h10M7 17h6" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  admin: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </>
  ),
  close: <path d="M18 6 6 18M6 6l12 12" />,
  expand: <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />,
  collapse: <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  chat: (
    <>
      <path d="M21 12a8 8 0 0 1-11.7 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z" />
      <path d="M8.5 11h7M8.5 14h4.5" />
    </>
  ),
  megaphone: (
    <>
      <path d="M3 10v4a1 1 0 0 0 1 1h3l6 4V5L7 9H4a1 1 0 0 0-1 1z" />
      <path d="M17 8.5a5 5 0 0 1 0 7M7 15l1.2 4.5a1 1 0 0 0 1 .7H11" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

/** Closes on Escape while mounted — but an open dropdown inside closes first, so a wizard isn't lost. */
function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const openMenu = document.querySelector<HTMLDetailsElement>('details[open]');
      if (openMenu) {
        openMenu.open = false;
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

// --- Drawer ------------------------------------------------------------------------------
/**
 * Right-hand side panel for a record. `expanded` turns the same panel into a
 * centred full-screen overlay — one component, so tabs and scroll position carry over.
 */
export function Drawer({
  title,
  subtitle,
  expanded,
  onToggleExpand,
  onClose,
  tabs,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  tabs?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  useEscape(onClose);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className={`drawer${expanded ? ' expanded' : ''}`} role="dialog" aria-modal="true">
        <div className="drawer-head">
          <div style={{ minWidth: 0 }}>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <div className="tools">
            <button className="icon-btn" onClick={onToggleExpand} title={expanded ? 'Back to side panel' : 'Expand'}>
              <Icon name={expanded ? 'collapse' : 'expand'} />
            </button>
            <button className="icon-btn" onClick={onClose} title="Close (Esc)">
              <Icon name="close" />
            </button>
          </div>
        </div>
        {actions && <div className="drawer-actions">{actions}</div>}
        {tabs}
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

// --- Modal -------------------------------------------------------------------------------
export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEscape(onClose);
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal" role="dialog" aria-modal="true">
        {children}
      </div>
    </>
  );
}

// --- Tabs / segmented ----------------------------------------------------------------------
export function Tabs<K extends string>({
  items,
  value,
  onChange,
}: {
  items: Array<{ key: K; label: string; count?: number }>;
  value: K;
  onChange: (k: K) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} className={`tab${value === t.key ? ' active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && <span className="count">{t.count.toLocaleString()}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<K extends string>({
  items,
  value,
  onChange,
}: {
  items: Array<{ key: K; label: string; count?: number }>;
  value: K;
  onChange: (k: K) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {items.map((t) => (
        <button key={t.key} role="radio" aria-checked={value === t.key} className={value === t.key ? 'active' : ''} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && <span className="count">{t.count.toLocaleString()}</span>}
        </button>
      ))}
    </div>
  );
}

// --- Wizard header -------------------------------------------------------------------------
export function WizardSteps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="wizard-steps">
      {steps.map((label, i) => (
        <div key={label} style={{ display: 'contents' }}>
          {i > 0 && <div className="wizard-sep" />}
          <div className={`wizard-step${i === current ? ' active' : i < current ? ' done' : ''}`}>
            <span className="dot">{i < current ? '✓' : i + 1}</span>
            {label}
          </div>
        </div>
      ))}
    </div>
  );
}
