import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';

interface TemplateSummaryItem {
  name: string;
  description: string | null;
}

type FetchState = 'loading' | 'ok' | 'error';

// ---------------------------------------------------------------------------
// WorkflowListRoute — template picker landing screen
// ---------------------------------------------------------------------------

export function WorkflowListRoute() {
  const navigate = useNavigate();
  const [fetchState, setFetchState] = useState<FetchState>('loading');
  const [templates, setTemplates] = useState<TemplateSummaryItem[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateSummaryItem | null>(null);

  const loadTemplates = useCallback(async () => {
    setFetchState('loading');
    try {
      const res = await fetch('/api/templates');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { templates: TemplateSummaryItem[] };
      setTemplates(data.templates);
      setFetchState('ok');
    } catch {
      setFetchState('error');
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  if (fetchState === 'loading') {
    return (
      <div className="flex items-center justify-center h-full text-gray-500 text-sm">
        Loading templates…
      </div>
    );
  }

  if (fetchState === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
        <p className="text-red-400 text-sm">Failed to load templates.</p>
        <button
          onClick={() => void loadTemplates()}
          className="px-4 py-2 text-sm rounded bg-gray-700 hover:bg-gray-600 text-gray-200 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <TemplatePicker
        templates={templates}
        onSelect={(t) => setSelectedTemplate(t)}
      />
      {selectedTemplate !== null && (
        <NewWorkflowModal
          template={selectedTemplate}
          onClose={() => setSelectedTemplate(null)}
          onCreated={(workflowId) => navigate(`/workflow/${workflowId}`)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// TemplatePicker
// ---------------------------------------------------------------------------

function TemplatePicker({
  templates,
  onSelect,
}: {
  templates: TemplateSummaryItem[];
  onSelect: (t: TemplateSummaryItem) => void;
}) {
  if (templates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 px-8 text-center">
        <p className="text-sm" data-testid="empty-state">
          Create a template file in .yoke/templates/*.yml to get started
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto p-6">
      <h1 className="text-xl font-semibold text-gray-100 mb-5">Choose a template</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.map((t) => (
          <button
            key={t.name}
            onClick={() => onSelect(t)}
            className="text-left bg-gray-800 hover:bg-gray-700 rounded-lg p-4 border border-gray-700 hover:border-blue-500 transition-colors group"
            data-testid={`template-card-${t.name}`}
          >
            <div className="font-medium text-gray-100 group-hover:text-white">{t.name}</div>
            {t.description !== null && t.description !== undefined && (
              <div className="mt-1 text-sm text-gray-400 line-clamp-2">{t.description}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NewWorkflowModal
// ---------------------------------------------------------------------------

function NewWorkflowModal({
  template,
  onClose,
  onCreated,
}: {
  template: TemplateSummaryItem;
  onClose: () => void;
  onCreated: (workflowId: string) => void;
}) {
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus the input when the modal opens.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape closes the modal; Tab is trapped inside.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  function validateName(v: string): string | null {
    return v.trim() ? null : 'Name is required';
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const err = validateName(name);
    if (err) {
      setNameError(err);
      inputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateName: template.name, name: name.trim() }),
      });
      if (res.status === 201) {
        const data = (await res.json()) as { workflowId: string };
        onCreated(data.workflowId);
      } else {
        const body = (await res.json()) as { error?: string };
        setSubmitError(body.error ?? `Error ${res.status}`);
      }
    } catch {
      setSubmitError('Network error — please try again');
    } finally {
      setSubmitting(false);
    }
  }

  const nameIsEmpty = !name.trim();

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-workflow-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      {/* Backdrop — click to close */}
      <div
        data-testid="modal-backdrop"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog panel */}
      <div
        ref={dialogRef}
        className="relative bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4 p-6 flex flex-col gap-4"
      >
        <h2
          id="new-workflow-modal-title"
          className="text-lg font-semibold text-gray-100"
        >
          New workflow —{' '}
          <span className="text-blue-300">{template.name}</span>
        </h2>

        <form onSubmit={(e) => void handleSubmit(e)} noValidate className="flex flex-col gap-3">
          <div>
            <label
              htmlFor="workflow-name-input"
              className="block text-sm text-gray-300 mb-1.5"
            >
              Workflow name
            </label>
            <input
              id="workflow-name-input"
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(validateName(e.target.value));
              }}
              onBlur={() => setNameError(validateName(name))}
              placeholder="Enter a name for this workflow run"
              aria-describedby={nameError ? 'workflow-name-error' : undefined}
              aria-invalid={nameError ? 'true' : undefined}
              disabled={submitting}
              className={[
                'w-full bg-gray-700 text-gray-100 rounded px-3 py-2 outline-none text-sm',
                'focus:ring-2 focus:ring-blue-500 placeholder-gray-500',
                nameError ? 'ring-2 ring-red-500' : '',
              ].join(' ')}
            />
            {nameError && (
              <p
                id="workflow-name-error"
                role="alert"
                className="text-xs text-red-400 mt-1"
              >
                {nameError}
              </p>
            )}
          </div>

          {submitError && (
            <p role="alert" className="text-xs text-red-400">
              {submitError}
            </p>
          )}

          <div className="flex justify-end gap-2 mt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-sm rounded text-gray-300 hover:bg-gray-700 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={nameIsEmpty || submitting}
              className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
