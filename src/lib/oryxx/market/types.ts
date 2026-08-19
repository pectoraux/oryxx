// ORYXX — Transportation Market domain types.
// See header comment in this file's first version — the test of the thesis.

export interface Loc {
  x: number;
  y: number;
}

export interface TimeWindow {
  start: number; // minutes from midnight
  end: number;
}

export type DemandKind = "person" | "people" | "parcel" | "pallet" | "container";

export interface DemandRequest {
  id: string;
  kind: DemandKind;
  origin: Loc;
  destination: Loc;
  window: TimeWindow;
  latestArrival?: number;
  partySize: number;
  weightKg?: number;
  budget: number;
  value: number;
  createdAt: number;
  originName: string;
  destName: string;
}

export type SupplyKind = "rideshare" | "carpool-npd" | "truck" | "transit";

export interface SupplyOffer {
  id: string;
  kind: SupplyKind;
  origin: Loc;
  destination: Loc;
  originName: string;
  destName: string;
  departure: number;
  capacitySeats: number;
  availableCapacity: number;
  minCompensation: number;
  detourToleranceKm: number;
  executionProbability: number;
  reliability: number;
  costPerKm: number;
  isCommitted: boolean;
  route: Loc[];
  scheduleFreqMin?: number;
}

export interface Match {
  demandId: string;
  supplyId: string;
  supplyKind: SupplyKind;
  price: number;
  welfare: number;
  userSurplus: number;
  driverSurplus: number;
  detourKm: number;
  departAt: number;
  arriveAt: number;
  travelTimeMin: number;
  ordinaryCost: number;
  savingVsOrdinary: number;
}

export interface MarketMetrics {
  matchedDemands: number;
  unmatchedDemands: number;
  totalDemands: number;
  matchingRate: number;
  totalUserCost: number;
  totalDriverEarnings: number;
  totalDriverCost: number;
  totalWelfare: number;
  seatUtilization: number;
  emptyVehicleKm: number;
  deadheadKm: number;
  avgTravelTimeMin: number;
  avgDetourKm: number;
  unservedDemandValue: number;
  excessSpendVsOptimal?: number;
}

export interface WasteRemoved {
  emptyVehicleKm: number;
  pctEmptyKm: number;
  userCostSavings: number;
  pctUserCost: number;
  additionalMatches: number;
  welfareGain: number;
  pctWelfare: number;
  pctMatchingRate: number;
  unservedDemandValueSaved: number;
}

export interface SimulationConfig {
  seed: number;
  numDemands: number;
  numDrivers: number;
  numNPDs: number;
  numTrucks: number;
  numTransitLines: number;
  regionKm: number;
}

export interface SimulationResult {
  config: SimulationConfig;
  generatedAt: string;
  demands: DemandRequest[];
  supplies: SupplyOffer[];
  baseline: {
    name: "Ordinary routing";
    description: string;
    metrics: MarketMetrics;
  };
  oryxx: {
    name: "ORYXX market clearing";
    description: string;
    metrics: MarketMetrics;
    matches: Match[];
  };
  wasteRemoved: WasteRemoved;
  topOpportunities: Match[];
  solverNote: string;
}
