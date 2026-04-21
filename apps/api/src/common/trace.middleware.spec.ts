import { TraceMiddleware } from './trace.middleware';
import { currentTraceId, traceStore } from './trace-context';

function makeReq(headers: Record<string, string> = {}, user?: { userId: string }): any {
  return {
    header(name: string) {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
      return key ? headers[key] : undefined;
    },
    user,
  };
}

function makeRes(): any {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  };
}

describe('TraceMiddleware', () => {
  const mw = new TraceMiddleware();

  it('generates a traceId when X-Trace-Id header is missing', (done) => {
    const req = makeReq();
    const res = makeRes();
    mw.use(req, res, () => {
      const trace = currentTraceId();
      expect(trace).toBeDefined();
      expect(trace).toMatch(/^trc_/);
      expect(res.headers['X-Trace-Id']).toBe(trace);
      done();
    });
  });

  it('reuses the incoming X-Trace-Id header when present', (done) => {
    const incoming = 'trc_clientprovided1';
    const req = makeReq({ 'X-Trace-Id': incoming });
    const res = makeRes();
    mw.use(req, res, () => {
      expect(currentTraceId()).toBe(incoming);
      expect(res.headers['X-Trace-Id']).toBe(incoming);
      done();
    });
  });

  it('is case-insensitive for the incoming header', (done) => {
    const incoming = 'trc_lowercaseheader';
    const req = makeReq({ 'x-trace-id': incoming });
    const res = makeRes();
    mw.use(req, res, () => {
      expect(currentTraceId()).toBe(incoming);
      done();
    });
  });

  it('propagates userId from req.user into the trace store', (done) => {
    const req = makeReq({}, { userId: 'user-123' });
    const res = makeRes();
    mw.use(req, res, () => {
      const ctx = traceStore.getStore();
      expect(ctx?.userId).toBe('user-123');
      done();
    });
  });
});
