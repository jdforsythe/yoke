/**
 * RouteErrorBoundary — renders a friendly fallback when a route component
 * throws during render (defence in depth against white-screens).
 *
 * Styled consistently with the "Workflow not found" view in
 * WorkflowDetailRoute so the user sees a familiar layout when something
 * unexpected goes wrong.
 */

import { Link, useRouteError, isRouteErrorResponse } from 'react-router-dom';

function formatError(err: unknown): string {
  if (isRouteErrorResponse(err)) {
    return `${err.status} ${err.statusText}${err.data ? `\n${String(err.data)}` : ''}`;
  }
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  try {
    return typeof err === 'string' ? err : JSON.stringify(err, null, 2);
  } catch {
    return String(err);
  }
}

export function RouteErrorBoundary() {
  const error = useRouteError();
  const message = formatError(error);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-gray-400 p-6">
      <div className="text-lg font-semibold text-gray-300">
        Something went wrong rendering this workflow.
      </div>
      <pre className="max-w-3xl w-full text-xs text-red-300 bg-gray-900/60 border border-red-500/30 rounded p-3 overflow-auto whitespace-pre-wrap break-words">
        {message}
      </pre>
      <Link
        to="/"
        className="text-sm text-blue-400 hover:text-blue-300 underline underline-offset-2"
      >
        ← Back to workflow list
      </Link>
    </div>
  );
}
