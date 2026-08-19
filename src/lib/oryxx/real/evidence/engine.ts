// ORYXX — Capacity Evidence Engine.
//
// This is the scientific instrument that separates:
//   - OBSERVED movement (Tier A): trip definitely happened
//   - OBSERVED capacity (Tier B): spare seats known (e.g. NYC passenger_count)
//   - INFERRED capacity (Tier C): spare seats assumed (e.g. Chicago without passenger_count)
//   - OBSERVED willingness (Tier D): provider acceptance measured (NONE in current pilot)
//   - ASSUMED willingness (Tier E): willingness modeled (ALL in current pilot)
//
// The headline metric is NOT "opportunities per 1000" — it's:
//   "How many opportunities have OBSERVED capacity (Tier B)?"
//   "How many have OBSERVED willingness (Tier D)?"
//
// This prevents the movement≠capacity conflation the reviewer identified.

import type {
  NpdMovement,
  NpdCapacity,
  NpdWillingness,
  CapacityEvidenceResult,
  CapacityExperimentResult,
  CapacityExperimentConfig,
} from "./types";
import type { DemandObservation, DataSource } from "../types";
import type { Loc, GeographicNode } from "../types";
import { haversineKm } from "../providers/interface";
import { buildNycNpdMovements, NycTaxiProvider, PILOT_NYC, NYC_TAXI_SOURCE, loadNycZones } from "../providers/nyc-taxi";
import { projectToKm } from "../providers/interface";
import { rng } from "../../market/generate";
import { describe } from "../../market/experiment/statistics";

const TAXI_TOTAL_CAPACITY = 4; // standard taxi has 4 passenger seats

// --- Build NPD-Capacity from NPD-Movement ----------------------------------
// Key distinction: if observedOccupancy is OBSERVED (passenger_count known),
// spare = totalCapacity - observedOccupancy is OBSERVED (Tier B).
// If observedOccupancy is UNKNOWN, spare is INFERRED (Tier C).
export function buildNpdCapacity(movement: NpdMovement, source: DataSource): NpdCapacity {
  const occ = movement.observedOccupancy;
  const observedOccupancyValue = occ.value;

  if (observedOccupancyValue != null && occ.level === "observed") {
    // Tier B: OBSERVED capacity
    const spare = Math.max(0, TAXI_TOTAL_CAPACITY - observedOccupancyValue);
    return {
      id: `CAP-${movement.id}`,
      movementId: movement.id,
      origin: movement.origin,
      destination: movement.destination,
      departureSec: movement.departureSec,
      arrivalSec: movement.arrivalSec,
      totalCapacity: { value: TAXI_TOTAL_CAPACITY, level: "observed", rationale: "Standard NYC yellow taxi has 4 passenger seats (TLC regulation)" },
      occupied: { value: observedOccupancyValue, level: "observed", rationale: "passenger_count field in NYC TLC data" },
      spare: { value: spare, level: "observed", rationale: `4 seats - ${observedOccupancyValue} observed passengers = ${spare} spare` },
      tier: "B-observed",
      observedAvailablePeriod: {
        isAvailable: false, // we don't have inter-trip gap data in this sample
        level: "unknown",
      },
      source,
    };
  } else {
    // Tier C: INFERRED capacity (no passenger_count)
    return {
      id: `CAP-${movement.id}`,
      movementId: movement.id,
      origin: movement.origin,
      destination: movement.destination,
      departureSec: movement.departureSec,
      arrivalSec: movement.arrivalSec,
      totalCapacity: { value: TAXI_TOTAL_CAPACITY, level: "observed", rationale: "Vehicle type is taxi (4 seats)" },
      occupied: { value: 1, level: "inferred", rationale: "No passenger_count — assumed 1 occupant (the fare-paying passenger)" },
      spare: { value: 3, level: "inferred", rationale: "Assumed 4-1=3 spare, but occupancy is NOT observed" },
      tier: "C-inferred",
      observedAvailablePeriod: {
        isAvailable: false,
        level: "unknown",
      },
      source,
    };
  }
}

// --- Build NPD-Willingness (always Tier E in current pilot) ----------------
export function buildNpdWillingness(
  capacityId: string,
  config: CapacityExperimentConfig,
): NpdWillingness {
  return {
    id: `WIL-${capacityId}`,
    capacityId,
    willingness: { value: config.willingness, level: "assumed", rationale: "No observed willingness data — this is a scenario parameter, NOT a measurement" },
    executionProbability: { value: config.executionProbability, level: "assumed", rationale: "No observed execution data — scenario parameter" },
    detourToleranceKm: { value: config.detourToleranceKm, level: "assumed", rationale: "No observed detour tolerance — scenario parameter" },
    minCompensation: { value: config.minCompensation, level: "assumed", rationale: "No observed compensation preference — scenario parameter" },
    reliability: { value: 0.7, level: "assumed", rationale: "No observed reliability data — scenario parameter" },
    tier: "E-assumed",
  };
}

// --- Generate demands (aligned to movement hours) -------------------------
export function generateCapacityDemands(
  config: CapacityExperimentConfig,
  nodes: GeographicNode[],
  movementHours: number[],
): DemandObservation[] {
  const r = rng(config.seed * 7 + 3);
  const demands: DemandObservation[] = [];
  for (let i = 0; i < config.numDemands; i++) {
    const origin = nodes[Math.floor(r() * nodes.length)];
    const dest = nodes[Math.floor(r() * nodes.length)];
    if (origin.id === dest.id) { i--; continue; }
    const hour = movementHours.length > 0
      ? movementHours[Math.floor(r() * movementHours.length)]
      : 17;
    const start = hour * 3600 + Math.floor(r() * 3600);
    const km = haversineKm({ lat: origin.lat, lon: origin.lon }, { lat: dest.lat, lon: dest.lon });
    const ordinary = 3 + 1.6 * km;
    demands.push({
      id: `D${i + 1}`,
      origin: { x: origin.x, y: origin.y },
      destination: { x: dest.x, y: dest.y },
      windowStartSec: start,
      windowEndSec: start + 1800,
      partySize: 1,
      kind: "person",
      budget: Math.round(ordinary * 1.2 * 100) / 100,
      value: Math.round(ordinary * 1.6 * 100) / 100,
      source: { name: "synthetic-demand", type: "fixture", license: "ORYXX internal", coveragePeriod: "n/a", fetchedAt: "", isFixture: true },
    });
  }
  return demands;
}

// --- Run the capacity evidence experiment ----------------------------------
export function runCapacityExperiment(config: CapacityExperimentConfig): CapacityExperimentResult {
  // Load real NYC taxi movements with observed passenger_count
  const npdMovements = buildNycNpdMovements();
  const movementHours = [...new Set(npdMovements.map((m) => Math.floor(m.departureSec / 3600)))];

  // Build geographic nodes from zone centroids
  const zones = loadNycZones();
  const nodes: GeographicNode[] = Object.entries(zones).map(([zid, z]: [string, any]) => {
    const { x, y } = projectToKm(z.lat, z.lon, 40.7128, -74.0060);
    return { id: `NYC-Z${zid}`, lat: z.lat, lon: z.lon, x, y, name: `${z.zone}, ${z.borough}`, kind: "poi" as const };
  });

  // Generate demands aligned to movement hours
  const demands = generateCapacityDemands(config, nodes, movementHours);

  // Build capacity + willingness for each movement
  const capacities = npdMovements.map((m) => buildNpdCapacity(m, NYC_TAXI_SOURCE));
  const willingnesses = capacities.map((c) => buildNpdWillingness(c.id, config));

  // Count evidence tiers
  const tierB = capacities.filter((c) => c.tier === "B-observed").length;
  const tierC = capacities.filter((c) => c.tier === "C-inferred").length;
  const tierD = willingnesses.filter((w) => w.tier === "D-observed").length;
  const tierE = willingnesses.filter((w) => w.tier === "E-assumed").length;

  // For each demand, find the best capacity match with evidence classification
  const opportunities: CapacityEvidenceResult[] = [];
  let fullEvidence = 0, movementPlusCapacity = 0, movementOnly = 0, weak = 0;
  let robustWithObservedCapacity = 0;

  for (const d of demands) {
    let best: CapacityEvidenceResult | null = null;
    const dOriginLatLon = { lat: 40.7128 + d.origin.y / 111, lon: -74.0060 + d.origin.x / (111 * Math.cos((40.7128 * Math.PI) / 180)) };
    const dDestLatLon = { lat: 40.7128 + d.destination.y / 111, lon: -74.0060 + d.destination.x / (111 * Math.cos((40.7128 * Math.PI) / 180)) };

    for (let i = 0; i < npdMovements.length; i++) {
      const m = npdMovements[i];
      const c = capacities[i];
      const w = willingnesses[i];

      // spatial feasibility
      const mOriginLatLon = { lat: 40.7128 + m.origin.y / 111, lon: -74.0060 + m.origin.x / (111 * Math.cos((40.7128 * Math.PI) / 180)) };
      const mDestLatLon = { lat: 40.7128 + m.destination.y / 111, lon: -74.0060 + m.destination.x / (111 * Math.cos((40.7128 * Math.PI) / 180)) };
      const detour = (haversineKm(dOriginLatLon, mOriginLatLon) + haversineKm(dDestLatLon, mDestLatLon)) / 2;
      if (detour > w.detourToleranceKm.value) continue;

      // temporal feasibility
      if (m.departureSec < d.windowStartSec || m.departureSec > d.windowEndSec) continue;

      // capacity: must have spare
      if (c.spare.value < d.partySize) continue;

      // economics
      const baselineKm = haversineKm(dOriginLatLon, dDestLatLon);
      const baselineCost = Math.round((3 + 1.6 * baselineKm) * 100) / 100;
      const opportunityCost = Math.max(w.minCompensation.value, baselineCost * 0.6);
      if (opportunityCost >= baselineCost) continue;
      if (opportunityCost > d.budget) continue;

      const userSaving = Math.round((baselineCost - opportunityCost) * 100) / 100;
      const supplierCost = Math.round((haversineKm(mOriginLatLon, mDestLatLon) + detour) * 0.12 * 100) / 100;
      const socialSurplus = Math.round((userSaving + (opportunityCost - supplierCost)) * 100) / 100;
      if (socialSurplus <= 0) continue;

      // evidence classification
      const movementObserved = true; // always observed (Tier A)
      const capacityObserved = c.tier === "B-observed";
      const willingnessObserved = w.tier === "D-observed"; // always false in current pilot
      const observedTiers = (movementObserved ? 1 : 0) + (capacityObserved ? 1 : 0) + (willingnessObserved ? 1 : 0);
      const classification = observedTiers === 3 ? "FULL-EVIDENCE"
        : observedTiers === 2 ? "MOVEMENT+CAPACITY"
        : observedTiers === 1 ? "MOVEMENT-ONLY"
        : "WEAK";

      const result: CapacityEvidenceResult = {
        id: `EVID-${d.id}-${m.id}`,
        demandId: d.id,
        movement: m,
        capacity: c,
        willingness: w,
        estimatedSocialSurplus: socialSurplus,
        estimatedUserSaving: userSaving,
        estimatedSupplierCompensation: opportunityCost,
        baselineCost,
        evidenceScore: {
          movementObserved,
          capacityObserved,
          willingnessObserved,
          observedTiers,
          classification,
        },
        dependsOnLatentSupply: true,
        reasonOrdinaryWouldMiss: `Ordinary multimodal routing has no visibility into this observed taxi movement (${m.originName} → ${m.destName} at ${secToHHMM(m.departureSec)}). passenger_count=${c.occupied.value} → ${c.spare.value} OBSERVED spare seats. But willingness=${w.willingness.value} is ASSUMED, not measured.`,
      };

      if (!best || result.estimatedSocialSurplus > best.estimatedSocialSurplus) {
        best = result;
      }
    }

    if (best) {
      opportunities.push(best);
      // count by evidence class
      if (best.evidenceScore.classification === "FULL-EVIDENCE") fullEvidence++;
      else if (best.evidenceScore.classification === "MOVEMENT+CAPACITY") movementPlusCapacity++;
      else if (best.evidenceScore.classification === "MOVEMENT-ONLY") movementOnly++;
      else weak++;
      // robust = has observed capacity (Tier B)
      if (best.evidenceScore.capacityObserved) robustWithObservedCapacity++;
    }
  }

  // value tiers
  const potentialValue = opportunities.reduce((a, o) => a + o.estimatedSocialSurplus, 0);
  const expectedValue = opportunities.reduce((a, o) => a + o.estimatedSocialSurplus * config.executionProbability, 0);
  const executedValue = expectedValue * config.willingness;

  // honest caveats
  const caveats = [
    `Movement data is REAL: ${npdMovements.length} NYC TLC taxi trips (public domain). passenger_count is OBSERVED (Tier B capacity evidence).`,
    `Willingness is NOT observed — it is ASSUMED at ${config.willingness * 100}%. No marketplace acceptance data exists. This is the biggest unvalidated assumption.`,
    `A taxi with passenger_count=1 had 3 OBSERVED spare seats — but the taxi was on a dispatched trip, NOT available to ORYXX. Observed capacity ≠ bookable supply.`,
    `Sample: ${npdMovements.length} trips from one month. This is a methodology demonstration, not a population statistic.`,
    `Zone centroids are borough-level (~1-3km precision). Real coordinates would change spatial matching.`,
    `The headline "robust opportunities with observed capacity" = ${robustWithObservedCapacity}. These have Tier B evidence but NOT Tier D (willingness). The marketplace thesis requires Tier D.`,
  ];

  return {
    config,
    pilot: {
      name: PILOT_NYC.name,
      description: PILOT_NYC.description,
      datasets: [NYC_TAXI_SOURCE],
    },
    totalMovements: npdMovements.length,
    movementsWithObservedCapacity: npdMovements.filter((m) => m.observedOccupancy.level === "observed").length,
    movementsWithObservedSpare: npdMovements.filter((m) => m.observedOccupancy.value != null && m.observedOccupancy.value < TAXI_TOTAL_CAPACITY).length,
    tierB_observedCapacity: tierB,
    tierC_inferredCapacity: tierC,
    tierD_observedWillingness: tierD,
    tierE_assumedWillingness: tierE,
    opportunities: {
      fullEvidence,
      movementPlusCapacity,
      movementOnly,
      weak,
    },
    robustOpportunitiesWithObservedCapacity: robustWithObservedCapacity,
    robustOpportunitiesPer1000: demands.length > 0 ? Math.round((robustWithObservedCapacity / demands.length) * 1000) : 0,
    potentialValue: Math.round(potentialValue * 100) / 100,
    expectedValue: Math.round(expectedValue * 100) / 100,
    executedValue: Math.round(executedValue * 100) / 100,
    topOpportunities: opportunities.sort((a, b) => b.estimatedSocialSurplus - a.estimatedSocialSurplus).slice(0, 12),
    caveats,
    generatedAt: new Date().toISOString(),
  };
}

function secToHHMM(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
