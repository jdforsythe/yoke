import { describe, it, expect } from 'vitest';
import { classify, type ParseState } from '../../src/server/state-machine/classifier.js';
import { transition } from '../../src/server/state-machine/transitions.js';
import type { ConditionalTransitionResult } from '../../src/server/state-machine/transitions.js';

const CLEAN: ParseState = { parseErrors: 0, lastEventType: null };
const ACTIVE: ParseState = { parseErrors: 0, lastEventType: 'assistant' };
const TAINTED_EMPTY: ParseState = { parseErrors: 3, lastEventType: null };
const TAINTED_ACTIVE: ParseState = { parseErrors: 2, lastEventType: 'result' };

// ---------------------------------------------------------------------------
// AC-3: rate-limit patterns → transient
// ---------------------------------------------------------------------------

describe('transient classification (AC-3)', () => {
  const transientCases: Array<[string, string]> = [
    ['rate_limit_error API frame', 'Error: rate_limit_error — you have exceeded your rate limit'],
    ['overloaded_error API frame', 'overloaded_error: the API is currently overloaded'],
    ['generic "rate limit" phrase', 'Your request was rejected due to rate limit exceeded'],
    ['HTTP 429 in stderr', 'Received HTTP 429: Too Many Requests from api.anthropic.com'],
    ['too many requests phrase', 'too many requests — please wait and try again'],
    ['overloaded phrase (without _error suffix)', 'The API is currently overloaded with other requests'],
    ['HTTP 529', 'HTTP 529 API overloaded'],
    ['HTTP 503', 'HTTP 503 Service Unavailable from upstream'],
    ['HTTP 502', 'HTTP 502 Bad Gateway'],
    ['HTTP 504', 'Gateway Timeout 504'],
    ['ECONNRESET', 'read ECONNRESET — connection was forcibly closed'],
    ['ETIMEDOUT', 'connect ETIMEDOUT 52.46.130.11:443'],
    ['connection reset phrase', 'Connection reset by peer'],
    ['network timeout phrase', 'network timeout after 30s'],
    ['request timeout phrase', 'request timeout exceeded'],
  ];

  for (const [label, stderr] of transientCases) {
    it(`classifies "${label}" as transient`, () => {
      expect(classify(stderr, CLEAN)).toBe('transient');
    });

    it(`classifies "${label}" as transient even with active parse state`, () => {
      expect(classify(stderr, ACTIVE)).toBe('transient');
    });
  }
});

// ---------------------------------------------------------------------------
// AC-4: authentication patterns → permanent
// ---------------------------------------------------------------------------

describe('permanent classification (AC-4)', () => {
  const permanentCases: Array<[string, string]> = [
    ['authentication_error API frame', 'Error: authentication_error — check your API key'],
    ['invalid_api_key API frame', 'invalid_api_key: the API key provided is invalid'],
    ['permission_error API frame', 'permission_error: you do not have permission for this operation'],
    ['authentication failed phrase', 'authentication failed — please check credentials'],
    ['unauthorized phrase', 'unauthorized: access is not allowed'],
    ['not authorized phrase', 'you are not authorized to make this request'],
    ['invalid api key phrase', 'the provided invalid api key was rejected'],
    ['unauthenticated phrase', 'unauthenticated request — provide a valid API key'],
    ['HTTP 401', 'Received HTTP 401 Unauthorized from api.anthropic.com'],
    ['HTTP 403', 'HTTP 403 Forbidden — insufficient permissions'],
  ];

  for (const [label, stderr] of permanentCases) {
    it(`classifies "${label}" as permanent`, () => {
      expect(classify(stderr, CLEAN)).toBe('permanent');
    });

    it(`classifies "${label}" as permanent even with tainted active stream`, () => {
      expect(classify(stderr, TAINTED_ACTIVE)).toBe('permanent');
    });
  }
});

// ---------------------------------------------------------------------------
// Policy patterns
// ---------------------------------------------------------------------------

describe('policy classification', () => {
  const policyCases: Array<[string, string]> = [
    ['content_policy_violation', 'content_policy_violation: the request was blocked'],
    ['content policy phrase', 'your request violates our content policy'],
    ['policy violation phrase', 'policy violation detected in output'],
    ['content filter phrase', 'content filter activated for this message'],
    ['safety filter phrase', 'safety filter blocked the response'],
  ];

  for (const [label, stderr] of policyCases) {
    it(`classifies "${label}" as policy`, () => {
      expect(classify(stderr, CLEAN)).toBe('policy');
    });
  }
});

// ---------------------------------------------------------------------------
// AC-5: unknown for unrecognised patterns
// ---------------------------------------------------------------------------

describe('unknown classification (AC-5)', () => {
  const unknownCases: Array<[string, string]> = [
    ['empty stderr', ''],
    ['generic error message', 'Something went wrong during execution'],
    ['exit code only', 'Process exited with code 1'],
    ['unrelated network message', 'DNS lookup successful'],
    ['exit signal message', 'Process killed by SIGTERM'],
    ['version mismatch message', 'Node.js version 18 is required but 16 was found'],
    ['disk full message', 'ENOSPC: no space left on device'],
    ['partial number that could look like a status', 'error code 201 returned'],
    ['whitespace only', '   \n\t  '],
  ];

  for (const [label, stderr] of unknownCases) {
    it(`classifies "${label}" as unknown with clean parse state`, () => {
      expect(classify(stderr, CLEAN)).toBe('unknown');
    });
  }

  it('returns unknown when stderr has no match and parse state is active (not tainted+empty)', () => {
    expect(classify('something unknown happened', ACTIVE)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Parse-state influence (RC-3: classifier must consume both inputs)
// ---------------------------------------------------------------------------

describe('parse-state influence (RC-3)', () => {
  it('tainted stream with no parseable events and no stderr match → policy', () => {
    // A session that produced zero parseable events AND had parse errors
    // is structurally corrupted; classify as policy to prevent auto-retry.
    expect(classify('something unrecognised', TAINTED_EMPTY)).toBe('policy');
  });

  it('tainted stream with parseable events and no stderr match → unknown', () => {
    // Parse errors occurred but we did get some events; standard unknown fallback
    expect(classify('something unrecognised', TAINTED_ACTIVE)).toBe('unknown');
  });

  it('tainted-empty stream does NOT override a transient stderr match', () => {
    // Transient should win even if parse state is tainted+empty
    expect(classify('rate_limit_error', TAINTED_EMPTY)).toBe('transient');
  });

  it('tainted-empty stream does NOT override a permanent stderr match', () => {
    expect(classify('authentication_error', TAINTED_EMPTY)).toBe('permanent');
  });

  it('zero parse errors and no last event type (session never started) + unknown stderr → unknown', () => {
    // parseErrors=0 so the tainted-empty branch is not triggered
    expect(classify('process exited with code 1', { parseErrors: 0, lastEventType: null })).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// AC-5 corollary: unknown always routes to awaiting_user (via TRANSITIONS)
// ---------------------------------------------------------------------------

describe('unknown routes to awaiting_user (AC-5 + transition table)', () => {
  it('the session_fail conditional result for unknown guard targets awaiting_user', () => {
    // Cross-check classifier output with transition routing
    const result = transition('in_progress', 'session_fail') as ConditionalTransitionResult;
    expect(result).toBeDefined();
    expect(result.kind).toBe('conditional');

    const unknownOutcome = result.outcomes.find(o => o.guard.includes('unknown'));
    expect(unknownOutcome).toBeDefined();
    expect(unknownOutcome!.to).toBe('awaiting_user');
  });
});

// ---------------------------------------------------------------------------
// Purity: same inputs, same output
// ---------------------------------------------------------------------------

describe('classify() purity', () => {
  it('returns identical results on repeated calls with identical inputs', () => {
    const stderr = 'rate_limit_error: you have exceeded the rate limit';
    const ps: ParseState = { parseErrors: 0, lastEventType: 'assistant' };
    expect(classify(stderr, ps)).toBe(classify(stderr, ps));
  });

  it('is unaffected by call order — transient does not bleed into next call', () => {
    classify('rate_limit_error', CLEAN);
    expect(classify('some unknown error', CLEAN)).toBe('unknown');
  });
});
