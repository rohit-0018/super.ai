// ─── Source Trust Classifier ────────────────────────────────────────────────

import { SourceTrust } from '../types/events.js';

export interface SourceTrustConfig {
  /** Map from source identifier to trust level */
  readonly sourceTrustMap: Readonly<Record<string, SourceTrust>>;
}

export class SourceTrustClassifier {
  private readonly trustMap: Readonly<Record<string, SourceTrust>>;

  constructor(config: SourceTrustConfig) {
    this.trustMap = config.sourceTrustMap;
  }

  public classify(source: string): SourceTrust {
    return this.trustMap[source] ?? SourceTrust.UNVERIFIED_EXTERNAL;
  }

  public wrapForContext(text: string, trust: SourceTrust): string {
    switch (trust) {
      case SourceTrust.INTERNAL:
        return `<internal>${text}</internal>`;
      case SourceTrust.VERIFIED_EXTERNAL:
        return `<verified-external>${text}</verified-external>`;
      case SourceTrust.UNVERIFIED_EXTERNAL:
        return `<unverified-external>${text}</unverified-external>`;
    }
  }
}
