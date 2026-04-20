import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from '@/components/AppShell/AppShell';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary/RouteErrorBoundary';
import { WorkflowListRoute } from '@/routes/WorkflowListRoute';
import { WorkflowDetailRoute } from '@/routes/WorkflowDetailRoute';
import { ItemDetailRoute } from '@/routes/ItemDetailRoute';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <WorkflowListRoute /> },
      {
        path: 'workflow/:workflowId',
        element: <WorkflowDetailRoute />,
        errorElement: <RouteErrorBoundary />,
      },
      { path: 'workflow/:workflowId/item/:itemId', element: <ItemDetailRoute /> },
    ],
  },
]);
