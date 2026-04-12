// ─── PII Scrubber ───────────────────────────────────────────────────────────

export enum PiiType {
  CARD_NUMBER = 'CARD_NUMBER',
  CVV = 'CVV',
  EXPIRY_DATE = 'EXPIRY_DATE',
  PHONE_NUMBER = 'PHONE_NUMBER',
  EMAIL_ADDRESS = 'EMAIL_ADDRESS',
  NATIONAL_ID = 'NATIONAL_ID',
  IBAN = 'IBAN',
  SWIFT_CODE = 'SWIFT_CODE',
}

export interface PiiDetection {
  readonly type: PiiType;
  readonly placeholder: string;
}

export interface ScrubResult {
  readonly scrubbed: string;
  readonly detections: ReadonlyArray<PiiDetection>;
}

interface PatternEntry {
  readonly type: PiiType;
  readonly pattern: RegExp;
  readonly placeholder: string;
  readonly validate?: (match: string) => boolean;
}

function passesLuhn(digits: string): boolean {
  const nums = digits.split('').map(Number);
  let sum = 0;
  let alternate = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let n = nums[i] ?? 0;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

const PATTERNS: ReadonlyArray<PatternEntry> = [
  {
    type: PiiType.CARD_NUMBER,
    // 13-19 digits optionally separated by spaces or dashes in groups
    pattern: /\b(\d[ -]?){12,18}\d\b/g,
    placeholder: '[CARD_NUMBER_REDACTED]',
    validate: (match: string): boolean => {
      const digits = match.replace(/[^0-9]/g, '');
      return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
    },
  },
  {
    type: PiiType.CVV,
    // 3 or 4 digit CVV preceded by word boundary — must be standalone
    pattern: /\bCVV[:\s]*(\d{3,4})\b/gi,
    placeholder: '[CVV_REDACTED]',
  },
  {
    type: PiiType.EXPIRY_DATE,
    // MM/YY or MM/YYYY
    pattern: /\b(0[1-9]|1[0-2])\/(\d{2}|\d{4})\b/g,
    placeholder: '[EXPIRY_DATE_REDACTED]',
  },
  {
    type: PiiType.IBAN,
    // 2 letter country code + 2 check digits + up to 30 alphanumeric (with optional spaces)
    pattern: /\b[A-Z]{2}\d{2}[\s]?[\dA-Z]{4}[\s]?(?:[\dA-Z]{4}[\s]?){1,7}[\dA-Z]{1,4}\b/g,
    placeholder: '[IBAN_REDACTED]',
    validate: (match: string): boolean => {
      const cleaned = match.replace(/\s/g, '');
      return cleaned.length >= 15 && cleaned.length <= 34;
    },
  },
  {
    type: PiiType.SWIFT_CODE,
    // 8 or 11 character SWIFT/BIC
    pattern: /\b[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g,
    placeholder: '[SWIFT_CODE_REDACTED]',
  },
  {
    type: PiiType.EMAIL_ADDRESS,
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    placeholder: '[EMAIL_ADDRESS_REDACTED]',
  },
  {
    type: PiiType.NATIONAL_ID,
    // US SSN: XXX-XX-XXXX
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    placeholder: '[NATIONAL_ID_REDACTED]',
  },
  {
    type: PiiType.PHONE_NUMBER,
    // International and US formats
    pattern: /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    placeholder: '[PHONE_NUMBER_REDACTED]',
    validate: (match: string): boolean => {
      const digits = match.replace(/[^0-9]/g, '');
      return digits.length >= 10 && digits.length <= 15;
    },
  },
];

export class PiiScrubber {
  public scrub(text: string): ScrubResult {
    let scrubbed = text;
    const detections: PiiDetection[] = [];

    for (const entry of PATTERNS) {
      const regex = new RegExp(entry.pattern.source, entry.pattern.flags);
      scrubbed = scrubbed.replace(regex, (match: string): string => {
        if (entry.validate && !entry.validate(match)) {
          return match;
        }
        detections.push({ type: entry.type, placeholder: entry.placeholder });
        return entry.placeholder;
      });
    }

    return { scrubbed, detections };
  }
}
