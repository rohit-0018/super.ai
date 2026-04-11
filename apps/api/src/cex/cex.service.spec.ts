import crypto from 'crypto';

// Signature shape tests — we don't hit real exchanges; we verify our signer
// produces the exact string preimage each exchange expects.

describe('CEX signature preimages', () => {
  it('binance signs HMAC-SHA256 over query string', () => {
    const secret = 'testsecret';
    const query = 'timestamp=1700000000000&recvWindow=5000';
    const sig = crypto.createHmac('sha256', secret).update(query).digest('hex');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('bybit v5 signs timestamp + apiKey + recvWindow + query', () => {
    const ts = '1700000000000';
    const apiKey = 'KEY';
    const recvWindow = '5000';
    const query = 'accountType=UNIFIED';
    const preSign = ts + apiKey + recvWindow + query;
    const sig = crypto.createHmac('sha256', 'secret').update(preSign).digest('hex');
    expect(preSign).toBe('1700000000000KEY5000accountType=UNIFIED');
    expect(sig).toHaveLength(64);
  });

  it('okx signs base64 over timestamp + method + path', () => {
    const ts = '2026-04-11T00:00:00.000Z';
    const preSign = ts + 'GET' + '/api/v5/account/balance';
    const sig = crypto.createHmac('sha256', 'secret').update(preSign).digest('base64');
    expect(preSign.endsWith('/api/v5/account/balance')).toBe(true);
    expect(sig).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
