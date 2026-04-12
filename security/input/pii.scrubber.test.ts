import { describe, it, expect } from 'vitest';
import { PiiScrubber, PiiType } from './pii.scrubber.js';

describe('PiiScrubber', () => {
  const scrubber = new PiiScrubber();

  // ─── CARD_NUMBER ────────────────────────────────────────────────────────────

  describe('CARD_NUMBER', () => {
    it('should detect a valid Visa card number', () => {
      const result = scrubber.scrub('My card is 4111111111111111');
      expect(result.scrubbed).toContain('[CARD_NUMBER_REDACTED]');
      expect(result.detections).toContainEqual({
        type: PiiType.CARD_NUMBER,
        placeholder: '[CARD_NUMBER_REDACTED]',
      });
    });

    it('should detect a valid card with spaces', () => {
      const result = scrubber.scrub('Card: 4111 1111 1111 1111');
      expect(result.scrubbed).toContain('[CARD_NUMBER_REDACTED]');
    });

    it('should detect a valid card with dashes', () => {
      const result = scrubber.scrub('Card: 4111-1111-1111-1111');
      expect(result.scrubbed).toContain('[CARD_NUMBER_REDACTED]');
    });

    it('should NOT flag a number that fails Luhn check', () => {
      const result = scrubber.scrub('Not a card: 1234567890123456');
      expect(result.scrubbed).not.toContain('[CARD_NUMBER_REDACTED]');
      expect(result.detections.filter((d) => d.type === PiiType.CARD_NUMBER)).toHaveLength(0);
    });

    it('should detect a valid Mastercard number', () => {
      // 5500000000000004 is a valid Mastercard test number
      const result = scrubber.scrub('MC: 5500000000000004');
      expect(result.scrubbed).toContain('[CARD_NUMBER_REDACTED]');
    });

    it('should NOT flag random 16-digit numbers failing Luhn', () => {
      const result = scrubber.scrub('ID: 1111111111111111');
      expect(result.detections.filter((d) => d.type === PiiType.CARD_NUMBER)).toHaveLength(0);
    });
  });

  // ─── CVV ────────────────────────────────────────────────────────────────────

  describe('CVV', () => {
    it('should detect CVV with colon format', () => {
      const result = scrubber.scrub('CVV: 123');
      expect(result.scrubbed).toContain('[CVV_REDACTED]');
      expect(result.detections).toContainEqual({
        type: PiiType.CVV,
        placeholder: '[CVV_REDACTED]',
      });
    });

    it('should detect 4-digit CVV (Amex)', () => {
      const result = scrubber.scrub('CVV 1234');
      expect(result.scrubbed).toContain('[CVV_REDACTED]');
    });

    it('should NOT flag standalone 3-digit numbers without CVV prefix', () => {
      const result = scrubber.scrub('I have 123 apples');
      expect(result.detections.filter((d) => d.type === PiiType.CVV)).toHaveLength(0);
    });
  });

  // ─── EXPIRY_DATE ────────────────────────────────────────────────────────────

  describe('EXPIRY_DATE', () => {
    it('should detect MM/YY format', () => {
      const result = scrubber.scrub('Expires 12/25');
      expect(result.scrubbed).toContain('[EXPIRY_DATE_REDACTED]');
    });

    it('should detect MM/YYYY format', () => {
      const result = scrubber.scrub('Expires 01/2026');
      expect(result.scrubbed).toContain('[EXPIRY_DATE_REDACTED]');
    });

    it('should NOT flag invalid month like 13/25', () => {
      const result = scrubber.scrub('Ratio 13/25');
      expect(result.detections.filter((d) => d.type === PiiType.EXPIRY_DATE)).toHaveLength(0);
    });

    it('should NOT flag 00/25', () => {
      const result = scrubber.scrub('Value 00/25');
      expect(result.detections.filter((d) => d.type === PiiType.EXPIRY_DATE)).toHaveLength(0);
    });
  });

  // ─── PHONE_NUMBER ──────────────────────────────────────────────────────────

  describe('PHONE_NUMBER', () => {
    it('should detect US phone format (xxx) xxx-xxxx', () => {
      const result = scrubber.scrub('Call (555) 123-4567');
      expect(result.scrubbed).toContain('[PHONE_NUMBER_REDACTED]');
    });

    it('should detect international format +1-555-123-4567', () => {
      const result = scrubber.scrub('Call +1-555-123-4567');
      expect(result.scrubbed).toContain('[PHONE_NUMBER_REDACTED]');
    });

    it('should NOT flag short digit sequences', () => {
      const result = scrubber.scrub('Code: 12345');
      expect(result.detections.filter((d) => d.type === PiiType.PHONE_NUMBER)).toHaveLength(0);
    });
  });

  // ─── EMAIL_ADDRESS ─────────────────────────────────────────────────────────

  describe('EMAIL_ADDRESS', () => {
    it('should detect standard email', () => {
      const result = scrubber.scrub('Email me at user@example.com');
      expect(result.scrubbed).toContain('[EMAIL_ADDRESS_REDACTED]');
      expect(result.detections).toContainEqual({
        type: PiiType.EMAIL_ADDRESS,
        placeholder: '[EMAIL_ADDRESS_REDACTED]',
      });
    });

    it('should detect email with dots and plus', () => {
      const result = scrubber.scrub('Contact: first.last+tag@company.co.uk');
      expect(result.scrubbed).toContain('[EMAIL_ADDRESS_REDACTED]');
    });

    it('should NOT flag text without @ sign', () => {
      const result = scrubber.scrub('hello world');
      expect(result.detections.filter((d) => d.type === PiiType.EMAIL_ADDRESS)).toHaveLength(0);
    });
  });

  // ─── NATIONAL_ID ───────────────────────────────────────────────────────────

  describe('NATIONAL_ID', () => {
    it('should detect US SSN format', () => {
      const result = scrubber.scrub('SSN: 123-45-6789');
      expect(result.scrubbed).toContain('[NATIONAL_ID_REDACTED]');
    });

    it('should NOT flag numbers with wrong separator pattern', () => {
      const result = scrubber.scrub('Number: 123456789');
      expect(result.detections.filter((d) => d.type === PiiType.NATIONAL_ID)).toHaveLength(0);
    });
  });

  // ─── IBAN ──────────────────────────────────────────────────────────────────

  describe('IBAN', () => {
    it('should detect a German IBAN', () => {
      const result = scrubber.scrub('IBAN: DE89370400440532013000');
      expect(result.scrubbed).toContain('[IBAN_REDACTED]');
    });

    it('should detect IBAN with spaces', () => {
      const result = scrubber.scrub('IBAN: GB29 NWBK 6016 1331 9268 19');
      expect(result.scrubbed).toContain('[IBAN_REDACTED]');
    });

    it('should NOT flag short codes that are not IBANs', () => {
      const result = scrubber.scrub('Code: AB12');
      expect(result.detections.filter((d) => d.type === PiiType.IBAN)).toHaveLength(0);
    });
  });

  // ─── SWIFT_CODE ────────────────────────────────────────────────────────────

  describe('SWIFT_CODE', () => {
    it('should detect 8-character SWIFT code', () => {
      const result = scrubber.scrub('SWIFT: DEUTDEFF');
      expect(result.scrubbed).toContain('[SWIFT_CODE_REDACTED]');
    });

    it('should detect 11-character SWIFT code', () => {
      const result = scrubber.scrub('BIC: DEUTDEFF500');
      expect(result.scrubbed).toContain('[SWIFT_CODE_REDACTED]');
    });

    it('should NOT flag lowercase text', () => {
      const result = scrubber.scrub('the word deutdeff is lowercase');
      expect(result.detections.filter((d) => d.type === PiiType.SWIFT_CODE)).toHaveLength(0);
    });
  });

  // ─── Combined ──────────────────────────────────────────────────────────────

  describe('combined scrubbing', () => {
    it('should detect multiple PII types in one string', () => {
      const input = 'Card 4111111111111111, email user@test.com, SSN 123-45-6789';
      const result = scrubber.scrub(input);
      const types = result.detections.map((d) => d.type);
      expect(types).toContain(PiiType.CARD_NUMBER);
      expect(types).toContain(PiiType.EMAIL_ADDRESS);
      expect(types).toContain(PiiType.NATIONAL_ID);
    });

    it('should return empty detections for clean text', () => {
      const result = scrubber.scrub('Buy 100 BTC at market price');
      expect(result.detections).toHaveLength(0);
      expect(result.scrubbed).toBe('Buy 100 BTC at market price');
    });
  });
});
