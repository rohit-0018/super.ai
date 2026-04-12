// ─── Injection Detector ─────────────────────────────────────────────────────

import type { SecurityConfig } from '../types/config.js';

export interface InjectionScore {
  readonly score: number;
  readonly triggers: ReadonlyArray<string>;
  readonly blocked: boolean;
}

interface PatternCategory {
  readonly name: string;
  readonly weight: number;
  readonly patterns: ReadonlyArray<RegExp>;
}

const PATTERN_CATEGORIES: ReadonlyArray<PatternCategory> = [
  {
    name: 'direct_instruction_override',
    weight: 0.4,
    patterns: [
      /ignore\s+(?:all\s+)?previous/i,
      /disregard\s+your/i,
      /your\s+new\s+instructions\s+are/i,
      /forget\s+everything/i,
      /ignore\s+(?:the\s+)?(?:above|prior)\s+(?:instructions|rules|directives)/i,
      /do\s+not\s+follow\s+(?:your|the)\s+(?:original|previous)/i,
    ],
  },
  {
    name: 'privilege_escalation',
    weight: 0.35,
    patterns: [
      /you\s+are\s+now/i,
      /act\s+as/i,
      /pretend\s+you\s+are/i,
      /you\s+have\s+been\s+granted/i,
      /assume\s+the\s+role\s+of/i,
      /switch\s+to\s+(?:admin|root|superuser)/i,
    ],
  },
  {
    name: 'data_exfiltration',
    weight: 0.35,
    patterns: [
      /send\s+this\s+to/i,
      /output\s+your\s+system\s+prompt/i,
      /repeat\s+your\s+instructions/i,
      /reveal\s+(?:your|the)\s+(?:system|hidden|secret)/i,
      /print\s+(?:your|the)\s+(?:config|configuration|prompt)/i,
    ],
  },
  {
    name: 'trading_manipulation',
    weight: 0.5,
    patterns: [
      /buy\s+maximum/i,
      /sell\s+everything/i,
      /ignore\s+risk\s+limits/i,
      /override\s+position\s+limits/i,
      /disable\s+circuit\s+breaker/i,
      /bypass\s+(?:risk|safety|security)\s+(?:checks|limits|controls)/i,
      /remove\s+(?:all\s+)?(?:stop[- ]?loss|limits)/i,
      /max(?:imum)?\s+leverage/i,
    ],
  },
  {
    name: 'structural_anomaly',
    weight: 0.25,
    patterns: [
      // Instruction-like sentences in fields expected to contain prices/symbols/numbers
      /(?:^|\n)\s*(?:you\s+(?:must|should|need\s+to)|please\s+(?:do|execute|run))/i,
      /(?:^|\n)\s*(?:step\s+\d|instruction\s*[:.])/i,
    ],
  },
];

export class InjectionDetector {
  private readonly threshold: number;

  constructor(config: Pick<SecurityConfig, 'injectionDetectionThresholdScore'>) {
    this.threshold = config.injectionDetectionThresholdScore;
  }

  public score(text: string): InjectionScore {
    const triggers: string[] = [];
    let totalScore = 0;

    for (const category of PATTERN_CATEGORIES) {
      let categoryTriggered = false;
      for (const pattern of category.patterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        if (regex.test(text)) {
          if (!categoryTriggered) {
            totalScore += category.weight;
            categoryTriggered = true;
          }
          triggers.push(`${category.name}:${pattern.source}`);
        }
      }
    }

    const clampedScore = Math.min(1, Math.max(0, totalScore));

    return {
      score: clampedScore,
      triggers,
      blocked: clampedScore > this.threshold,
    };
  }
}
