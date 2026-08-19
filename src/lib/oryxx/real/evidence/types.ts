// ORYXX — Evidence-tier model: NPD-Movement / NPD-Capacity / NPD-Willingness.
//
// This is the methodological core of the capacity-evidence phase. The previous
// experiment conflated "observed movement" with "available capacity." This
// module separates them rigorously:
//
//   NPD-Movement    = "a person/vehicle is going this way" (OBSERVED)
//   NPD-Capacity     = "and has spare capacity" (OBSERVED or INFERRED)
//   NPD-Willingness  = "and is willing to sell the spare capacity" (ASSUMED
//                       unless empirically measured)
//
// Evidence tiers:
//   Tier A — Observed movement: trip definitely happened
//   Tier B — Observed empty capacity: spare capacity definitely existed
//   Tier C — Inferred capacity: spare capacity is estimated (not observed)
//   Tier D — Observed willingness: provider accepted similar requests
//   Tier E — Assumed willingness: willingness modeled (not observed)
//
// The ORYXX marketplace begins only at Tier B + Tier D. We currently have
// Tier A (movement) and partial Tier B (NYC taxi passenger_count = observed
// occupancy). We do NOT have Tier D (observed willingness).

import type { Loc, DataSource, Confidence, OpportunityTier } from "../types";

// --- Evidence classification for each field ---------------------------------
export type EvidenceLevel = "observed" | "inferred" | "assumed" | "unknown";

export interface EvidenceField<T> {
  value: T;
  level: EvidenceLevel;
  rationale: string;
}

// --- NPD-Movement: the raw observation -------------------------------------
export interface NpdMovement {
  id: string;
  origin: Loc;
  destination: Loc;
  originName?: string;
  destName?: string;
  departureSec: number;
  arrivalSec: number;
  mode: "drive" | "cycle" | "walk";
  vehicleType: EvidenceField<string>;
  observedOccupancy: EvidenceField<number | null>;
  source: DataSource;
  anonymized: boolean;
}

// --- NPD-Capacity: what spare capacity exists? -----------------------------
export interface NpdCapacity {
  id: string;
  movementId: string;
  origin: Loc;
  destination: Loc;
  departureSec: number;
  arrivalSec: number;
  totalCapacity: EvidenceField<number>;
  occupied: EvidenceField<number>;
  spare: EvidenceField<number>;
  tier: "B-observed" | "C-inferred";
  observedAvailablePeriod: {
    isAvailable: boolean;
    gapStartSec?: number;
    gapEndSec?: number;
    gapDurationSec?: number;
    level: EvidenceLevel;
  };
  source: DataSource;
}

// --- NPD-Willingness: will the mover actually serve? -----------------------
export interface NpdWillingness {
  id: string;
  capacityId: string;
  willingness: EvidenceField<number>;
  executionProbability: EvidenceField<number>;
  detourToleranceKm: EvidenceField<number>;
  minCompensation: EvidenceField<number>;
  reliability: EvidenceField<number>;
  tier: "D-observed" | "E-assumed";
}

// --- Full evidence ladder for an opportunity -------------------------------
export interface CapacityEvidenceResult {
  id: string;
  demandId: string;
  movement: NpdMovement;
  capacity: NpdCapacity;
  willingness: NpdWillingness;
  estimatedSocialSurplus: number;
  estimatedUserSaving: number;
  estimatedSupplierCompensation: number;
  baselineCost: number;
  evidenceScore: {
    movementObserved: boolean;
    capacityObserved: boolean;
    willingnessObserved: boolean;
    observedTiers: number;
    classification: "FULL-EVIDENCE" | "MOVEMENT+CAPACITY" | "MOVEMENT-ONLY" | "WEAK";
  };
  dependsOnLatentSupply: boolean;
  reasonOrdinaryWouldMiss: string;
}

// --- Experiment result: capacity evidence lab -------------------------------
export interface CapacityExperimentResult {
  config: CapacityExperimentConfig;
  pilot: {
    name: string;
    description: string;
    datasets: DataSource[];
  };
  totalMovements: number;
  movementsWithObservedCapacity: number;
  movementsWithObservedSpare: number;
  tierB_observedCapacity: number;
  tierC_inferredCapacity: number;
  tierD_observedWillingness: number;
  tierE_assumedWillingness: number;
  opportunities: {
    fullEvidence: number;
    movementPlusCapacity: number;
    movementOnly: number;
    weak: number;
  };
  robustOpportunitiesWithObservedCapacity: number;
  robustOpportunitiesPer1000: number;
  potentialValue: number;
  expectedValue: number;
  executedValue: number;
  topOpportunities: CapacityEvidenceResult[];
  caveats: string[];
  generatedAt: string;
}

export interface CapacityExperimentConfig {
  seed: number;
  numDemands: number;
  detourToleranceKm: number;
  minCompensation: number;
  willingness: number;
  executionProbability: number;
  pilot: "nyc-taxi" | "chicago-taxi" | "accra-fixture";
}
