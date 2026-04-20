import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { getClient } from './ws/client';
import { dispatch, dispatchTextDelta, getSnapshot } from './store/renderStore';
import './index.css';

// Test hook: exposes render-store dispatch so e2e tests can inject arbitrary
// frames (including bulk block injection for eviction/sentinel tests) without
// routing through the WebSocket mock.  This is a localhost-only app; the
// overhead is negligible and the unconditional export simplifies test builds.
(window as unknown as Record<string, unknown>)['__yokeDispatch__'] = dispatch;
(window as unknown as Record<string, unknown>)['__yokeDispatchText__'] = dispatchTextDelta;
(window as unknown as Record<string, unknown>)['__yokeGetSnapshot__'] = getSnapshot;

// Register service worker for push notifications
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW registration failure is non-fatal; fallback to in-app toasts
    });
  });
}

// Start the WS client immediately
getClient().connect();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
