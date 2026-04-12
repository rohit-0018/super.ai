import { describe, it, expect } from 'vitest';
import { SourceTrustClassifier } from './source.trust.classifier.js';
import { SourceTrust } from '../types/events.js';

describe('SourceTrustClassifier', () => {
  const classifier = new SourceTrustClassifier({
    sourceTrustMap: {
      'internal-strategy-engine': SourceTrust.INTERNAL,
      'bloomberg-feed': SourceTrust.VERIFIED_EXTERNAL,
      'coinmarketcap-api': SourceTrust.VERIFIED_EXTERNAL,
      'user-chat': SourceTrust.UNVERIFIED_EXTERNAL,
    },
  });

  describe('classify', () => {
    it('should return INTERNAL for configured internal source', () => {
      expect(classifier.classify('internal-strategy-engine')).toBe(SourceTrust.INTERNAL);
    });

    it('should return VERIFIED_EXTERNAL for configured verified source', () => {
      expect(classifier.classify('bloomberg-feed')).toBe(SourceTrust.VERIFIED_EXTERNAL);
    });

    it('should return UNVERIFIED_EXTERNAL for configured unverified source', () => {
      expect(classifier.classify('user-chat')).toBe(SourceTrust.UNVERIFIED_EXTERNAL);
    });

    it('should default to UNVERIFIED_EXTERNAL for unknown sources', () => {
      expect(classifier.classify('unknown-source')).toBe(SourceTrust.UNVERIFIED_EXTERNAL);
    });

    it('should default to UNVERIFIED_EXTERNAL for empty string', () => {
      expect(classifier.classify('')).toBe(SourceTrust.UNVERIFIED_EXTERNAL);
    });
  });

  describe('wrapForContext', () => {
    it('should wrap with <internal> tags for INTERNAL trust', () => {
      const result = classifier.wrapForContext('hello', SourceTrust.INTERNAL);
      expect(result).toBe('<internal>hello</internal>');
    });

    it('should wrap with <verified-external> tags for VERIFIED_EXTERNAL trust', () => {
      const result = classifier.wrapForContext('data', SourceTrust.VERIFIED_EXTERNAL);
      expect(result).toBe('<verified-external>data</verified-external>');
    });

    it('should wrap with <unverified-external> tags for UNVERIFIED_EXTERNAL trust', () => {
      const result = classifier.wrapForContext('user input', SourceTrust.UNVERIFIED_EXTERNAL);
      expect(result).toBe('<unverified-external>user input</unverified-external>');
    });

    it('should preserve content exactly', () => {
      const content = 'Buy 100 BTC\nat $42,000\twith stop-loss';
      const result = classifier.wrapForContext(content, SourceTrust.INTERNAL);
      expect(result).toBe(`<internal>${content}</internal>`);
    });

    it('should handle empty string content', () => {
      const result = classifier.wrapForContext('', SourceTrust.INTERNAL);
      expect(result).toBe('<internal></internal>');
    });
  });
});
