import { describe, it, expect } from 'vitest';
import { sendCancel } from '../../src/cli/cancel.js';

// ---------------------------------------------------------------------------
// sendCancel — unit tests with a mock fetcher
// ---------------------------------------------------------------------------

describe('yoke cancel — sendCancel()', () => {
  // RC: fresh UUID commandId per invocation.
  it('generates a fresh UUID commandId when none provided', async () => {
    const captured: { body: string }[] = [];
    const mockFetch = async (_url: string, init?: RequestInit) => {
      captured.push({ body: init?.body as string });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await sendCancel('wf-1', { serverUrl: 'http://127.0.0.1:7777' }, mockFetch as typeof fetch);
    await sendCancel('wf-1', { serverUrl: 'http://127.0.0.1:7777' }, mockFetch as typeof fetch);

    expect(captured).toHaveLength(2);
    const body0 = JSON.parse(captured[0].body) as { commandId: string };
    const body1 = JSON.parse(captured[1].body) as { commandId: string };
    // Two separate invocations produce different commandIds.
    expect(body0.commandId).not.toBe(body1.commandId);
    // Both are valid UUID v4 format.
    expect(body0.commandId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body1.commandId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  // RC: explicit commandId is used as-is (for test determinism).
  it('uses provided commandId when given', async () => {
    let capturedBody: string | undefined;
    const mockFetch = async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const commandId = 'fixed-command-id-123';
    await sendCancel('wf-2', { serverUrl: 'http://127.0.0.1:7777', commandId }, mockFetch as typeof fetch);

    const body = JSON.parse(capturedBody!) as { action: string; commandId: string };
    expect(body.commandId).toBe(commandId);
    expect(body.action).toBe('cancel');
  });

  // RC: ECONNREFUSED → clear human-readable error.
  it('converts ECONNREFUSED to a human-readable error', async () => {
    const fakeError = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const mockFetch = async () => { throw fakeError; };

    await expect(
      sendCancel('wf-3', { serverUrl: 'http://127.0.0.1:19999' }, mockFetch as typeof fetch),
    ).rejects.toThrow(/Cannot connect to Yoke server/);
  });

  // Non-ok HTTP response → throws with status info.
  it('throws on non-2xx response', async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    await expect(
      sendCancel('wf-missing', { serverUrl: 'http://127.0.0.1:7777' }, mockFetch as typeof fetch),
    ).rejects.toThrow(/404/);
  });

  // URL construction: workflowId is percent-encoded.
  it('URL-encodes workflowId', async () => {
    let capturedUrl = '';
    const mockFetch = async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await sendCancel('my workflow/id', { serverUrl: 'http://127.0.0.1:7777' }, mockFetch as typeof fetch);
    expect(capturedUrl).toContain('my%20workflow%2Fid');
  });

  // Returns the result with workflowId, commandId, status, body.
  it('returns result with workflowId and commandId', async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ queued: true }), { status: 200 });

    const result = await sendCancel(
      'wf-abc',
      { serverUrl: 'http://127.0.0.1:7777', commandId: 'cmd-123' },
      mockFetch as typeof fetch,
    );

    expect(result.workflowId).toBe('wf-abc');
    expect(result.commandId).toBe('cmd-123');
    expect(result.status).toBe(200);
  });
});
