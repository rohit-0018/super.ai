// ─── Input Guard (Orchestrator) ─────────────────────────────────────────────

import { SourceTrust, SecurityEventType } from '../types/events.js';
import { InjectionError, SecurityErrorCode } from '../types/errors.js';
import { PiiScrubber, type ScrubResult, type PiiDetection } from './pii.scrubber.js';
import { InjectionDetector, type InjectionScore } from './injection.detector.js';
import { ContextIntegrityService, type EventEmitter, type Logger } from './context.integrity.js';
import { SourceTrustClassifier } from './source.trust.classifier.js';

// ─── Input/Output types ─────────────────────────────────────────────────────

export interface RawInput {
  readonly text: string;
  readonly source: string;
  readonly sessionId: string;
  readonly userId: string;
}

export interface SanitizedInput {
  readonly text: string;
  readonly trustLevel: SourceTrust;
  readonly piiDetections: ReadonlyArray<PiiDetection>;
  readonly injectionScore: InjectionScore;
  readonly sessionId: string;
  readonly userId: string;
}

export class InputGuard {
  private readonly piiScrubber: PiiScrubber;
  private readonly injectionDetector: InjectionDetector;
  private readonly contextIntegrity: ContextIntegrityService;
  private readonly sourceClassifier: SourceTrustClassifier;
  private readonly logger: Logger;
  private readonly emitter: EventEmitter | undefined;
  private readonly systemPrompt: string;

  constructor(deps: {
    piiScrubber: PiiScrubber;
    injectionDetector: InjectionDetector;
    contextIntegrity: ContextIntegrityService;
    sourceClassifier: SourceTrustClassifier;
    logger: Logger;
    emitter?: EventEmitter;
    systemPrompt: string;
  }) {
    this.piiScrubber = deps.piiScrubber;
    this.injectionDetector = deps.injectionDetector;
    this.contextIntegrity = deps.contextIntegrity;
    this.sourceClassifier = deps.sourceClassifier;
    this.logger = deps.logger;
    this.emitter = deps.emitter;
    this.systemPrompt = deps.systemPrompt;
  }

  public async process(input: RawInput): Promise<SanitizedInput> {
    // Step 1: PII scrub
    const scrubResult: ScrubResult = this.piiScrubber.scrub(input.text);

    // Step 2: Injection detection on scrubbed text
    const injectionResult: InjectionScore = this.injectionDetector.score(scrubResult.scrubbed);

    if (injectionResult.blocked) {
      this.logger.error('Injection detected and blocked', {
        sessionId: input.sessionId,
        userId: input.userId,
        score: injectionResult.score,
        triggers: injectionResult.triggers,
      });

      throw new InjectionError(
        `Input blocked: injection score ${injectionResult.score} exceeds threshold`,
        input.sessionId,
        SecurityErrorCode.INJECTION_PROMPT_DETECTED,
        {
          userId: input.userId,
          score: injectionResult.score,
          triggers: injectionResult.triggers,
        },
      );
    }

    // Step 3: Classify source trust
    const trustLevel: SourceTrust = this.sourceClassifier.classify(input.source);

    // Step 4: Wrap text with trust tags
    const wrappedText: string = this.sourceClassifier.wrapForContext(scrubResult.scrubbed, trustLevel);

    // Step 5: Verify context integrity
    await this.contextIntegrity.verify(this.systemPrompt, input.sessionId);

    // Step 6: Emit INPUT_SANITIZED event
    this.emitter?.emit(SecurityEventType.INPUT_SANITIZED, {
      field: 'text',
      originalLength: input.text.length,
      sanitizedLength: wrappedText.length,
      patternsMatched: scrubResult.detections.map((d) => d.type),
    });

    this.logger.info('Input sanitized', {
      sessionId: input.sessionId,
      userId: input.userId,
      trustLevel,
      piiCount: scrubResult.detections.length,
      injectionScore: injectionResult.score,
    });

    return {
      text: wrappedText,
      trustLevel,
      piiDetections: scrubResult.detections,
      injectionScore: injectionResult,
      sessionId: input.sessionId,
      userId: input.userId,
    };
  }
}
