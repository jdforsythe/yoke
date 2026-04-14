import { useEffect, useState, useRef } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { WorkflowList } from '@/components/WorkflowList/WorkflowList';
import { UsageHUD } from '@/components/UsageHUD/UsageHUD';
import { getClient } from '@/ws/client';
import type { ConnectionState } from '@/ws/types';
import type { NoticePayload, ServerFrame } from '@/ws/types';

// Toast for in-app notification fallback
interface Toast {
  id: string;
  message: string;
  kind: string;
}

function ConnectionIndicator({ state }: { state: ConnectionState }) {
  const color =
    state === 'connected'
      ? 'bg-green-500'
      : state === 'reconnecting' || state === 'connecting'
        ? 'bg-yellow-500 animate-pulse'
        : state === 'version_mismatch'
          ? 'bg-red-600'
          : 'bg-gray-500';

  const label =
    state === 'connected'
      ? 'Connected'
      : state === 'reconnecting'
        ? 'Reconnecting…'
        : state === 'connecting'
          ? 'Connecting…'
          : state === 'version_mismatch'
            ? 'Version mismatch'
            : 'Disconnected';

  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-300">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      {label}
    </div>
  );
}

function BellIcon({ badgeCount, onClick }: { badgeCount: number; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="relative p-1.5 rounded hover:bg-gray-700 text-gray-300 hover:text-white"
      aria-label="Notifications"
    >
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
        />
      </svg>
      {badgeCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center">
          {badgeCount > 9 ? '9+' : badgeCount}
        </span>
      )}
    </button>
  );
}

export function AppShell() {
  const [connState, setConnState] = useState<ConnectionState>(() => getClient().getConnectionState());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [attentionCount, setAttentionCount] = useState(0);
  const pushPermRef = useRef<string | null>(
    typeof localStorage !== 'undefined' ? localStorage.getItem('yoke:push-permission') : null,
  );
  const navigate = useNavigate();

  useEffect(() => {
    const client = getClient();
    const offState = client.onStateChange(setConnState);

    // Listen for requires_attention notices to show bell badge
    const offNotice = client.on('notice', (frame: ServerFrame) => {
      const payload = frame.payload as NoticePayload;
      if (payload.severity === 'requires_attention') {
        setAttentionCount((n) => n + 1);
        // Push notification or fallback toast
        const permission = localStorage.getItem('yoke:push-permission');
        if (permission === 'granted' && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'SHOW_NOTIFICATION',
            title: payload.kind,
            body: payload.message,
            url: frame.workflowId ? `/workflow/${frame.workflowId}` : '/',
          });
        } else {
          const id = crypto.randomUUID();
          setToasts((ts) => [...ts, { id, message: payload.message, kind: payload.kind }]);
          setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 5000);
        }
      }
    });

    // Listen for deep-link navigation from SW notification clicks
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'NAVIGATE') {
        navigate(event.data.url as string);
      }
    };
    navigator.serviceWorker?.addEventListener('message', handleMessage);

    return () => {
      offState();
      offNotice();
      navigator.serviceWorker?.removeEventListener('message', handleMessage);
    };
  }, [navigate]);

  function handleBellClick() {
    if (pushPermRef.current !== null) return; // already decided
    if (!('Notification' in window)) return;
    Notification.requestPermission().then((result) => {
      localStorage.setItem('yoke:push-permission', result);
      pushPermRef.current = result;
    });
  }

  function dismissToast(id: string) {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }

  const pushDenied = pushPermRef.current === 'denied';

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-100">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 h-12 bg-gray-800 border-b border-gray-700 shrink-0">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-white tracking-tight">Yoke</span>
          <ConnectionIndicator state={connState} />
        </div>
        <div className="flex items-center gap-2">
          <UsageHUD />
          <BellIcon
            badgeCount={attentionCount + (pushDenied ? 1 : 0)}
            onClick={handleBellClick}
          />
        </div>
      </header>

      {/* Body: sidebar + main */}
      <div className="flex flex-1 min-h-0">
        <aside className="w-[var(--sidebar-width)] shrink-0 border-r border-gray-700 overflow-hidden flex flex-col">
          <WorkflowList />
        </aside>
        <main className="flex-1 overflow-hidden flex flex-col">
          <Outlet />
        </main>
      </div>

      {/* Toast stack (push-denied fallback) */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 flex flex-col gap-2 z-50">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="bg-amber-800 text-white px-4 py-3 rounded-lg shadow-lg max-w-sm flex items-start gap-2"
            >
              <div className="flex-1">
                <p className="font-medium text-sm">{t.kind}</p>
                <p className="text-xs text-amber-200 mt-0.5">{t.message}</p>
              </div>
              <button onClick={() => dismissToast(t.id)} className="text-amber-200 hover:text-white ml-1">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
