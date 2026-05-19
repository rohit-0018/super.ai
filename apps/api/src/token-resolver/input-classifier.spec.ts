import { classifyInput } from './input-classifier';

const SOL = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // 44-char base58
const EVM = '0x' + 'a'.repeat(40);

describe('classifyInput', () => {
  it('treats a leading $ as an explicit ticker', () => {
    expect(classifyInput('$BONK')).toEqual({ kind: 'ticker', symbol: 'BONK' });
    expect(classifyInput('  $wif ')).toEqual({ kind: 'ticker', symbol: 'wif' });
  });

  it('lets $ force a ticker even for short/address-looking strings', () => {
    expect(classifyInput('$W')).toEqual({ kind: 'ticker', symbol: 'W' });
  });

  it('detects EVM and Solana addresses', () => {
    expect(classifyInput(EVM)).toEqual({ kind: 'address', chain: 'EVM', value: EVM });
    expect(classifyInput(SOL)).toEqual({ kind: 'address', chain: 'SOLANA', value: SOL });
    expect(classifyInput(`  ${SOL}  `)).toMatchObject({ kind: 'address', chain: 'SOLANA' });
  });

  it('treats a bare alphanumeric ≥2 chars as a ticker', () => {
    expect(classifyInput('BONK')).toEqual({ kind: 'ticker', symbol: 'BONK' });
    expect(classifyInput('pepe2')).toEqual({ kind: 'ticker', symbol: 'pepe2' });
  });

  it('rejects empty, single-char, and junk input', () => {
    expect(classifyInput('')).toEqual({ kind: 'unresolvable' });
    expect(classifyInput('   ')).toEqual({ kind: 'unresolvable' });
    expect(classifyInput('a')).toEqual({ kind: 'unresolvable' }); // bare 1-char
    expect(classifyInput('hello world!')).toEqual({ kind: 'unresolvable' });
    expect(classifyInput('$')).toEqual({ kind: 'unresolvable' });
    expect(classifyInput('$has space')).toEqual({ kind: 'unresolvable' });
  });

  it('prefers address detection over ticker for valid addresses without $', () => {
    expect(classifyInput(SOL).kind).toBe('address');
  });
});
