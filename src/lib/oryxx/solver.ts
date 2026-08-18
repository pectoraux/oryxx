// ORYXX — Deterministic Transportation Event SOLVER.
//
// The LLM understands intent. THIS module owns feasibility, scoring, ranking,
// and the generation of flexibility offers (§10: time is an optimization
// variable). It is the source of truth for "what is the best feasible plan".
//
// Approach:
//   1. Resolve origin/destination to hubs (synthetic fallback keeps it robust).
//   2. Enumerate candidate itineraries: direct + multi-hop via intermediates.
//   3. Materialize concrete segments aligned to the time window.
//   4. Score by expected utility (stochastic ETA, on-time probability).
//   5. Enforce hard constraints (budget / latestArrival / transfers / walking).
//   6. Select canonical plans: best_overall / cheapest / fastest /
//      most_reliable / interesting_alternative.
//   7. Synthesize flexibility offers (shift time, allow transfer, share ride,
//      book earlier, watch mode).

import {
  type TransportationEvent,
  type Plan,
  type ItinerarySegment,
  type SupplySegment,
  type FlexibilityOffer,
  type Mode,
  type ObjectiveWeights,
} from "./types";
import {
  HUBS,
  hubById,
  distanceKm,
  supplyBetween,
  resolveHub,
  rng,
  parseTimeToMin,
  minToTime,
  type Hub,
} from "./world";

const TRANSFER_PENALTY_MIN = 7; // expected transfer/boarding overhead

function defaultObjectives(): ObjectiveWeights {
  return {
    cost: 0.7,
    time: 0.7,
    reliability: 0.6,
    emissions: 0.35,
    comfort: 0.4,
    transfers: 0.5,
    walking: 0.4,
    safety: 0.55,
  };
}

// Candidate itinerary (pre-scoring) ------------------------------------------
interface Candidate {
  segments: SupplySegment[];
  viaHubId?: string;
}

function candidateSeed(originId: string, destId: string): number {
  let h = 7;
  for (const c of `${originId}->${destId}`) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}

// Enumerate direct + 2-hop candidates.
function enumerateCandidates(
  origin: Hub,
  dest: Hub,
  event: TransportationEvent,
): Candidate[] {
  const seed = candidateSeed(origin.id, dest.id);
  const cands: Candidate[] = [];

  // direct
  for (const s of supplyBetween(origin, dest, seed)) {
    cands.push({ segments: [s] });
  }

  // 2-hop via curated intermediates that make geographic sense
  const intermediates = HUBS.filter(
    (h) =>
      h.id !== origin.id &&
      h.id !== dest.id &&
      distanceKm(origin, h) + distanceKm(h, dest) <= distanceKm(origin, dest) * 2.4 + 6,
  ).slice(0, 8);

  for (const via of intermediates) {
    const legA = supplyBetween(origin, via, seed + 1);
    const legB = supplyBetween(via, dest, seed + 2);
    // pick a representative subset to keep combinatorics sane
    const aPick = pickRepresentative(legA);
    const bPick = pickRepresentative(legB);
    for (const a of aPick) for (const b of bPick) cands.push({ segments: [a, b], viaHubId: via.id });
  }

  // 3-hop "interesting alternative": origin -> hub1 -> hub2 -> dest (limited)
  if (distanceKm(origin, dest) > 6) {
    const hub1 = hubById("station")!;
    const hub2 = hubById("downtown")!;
    if (hub1 && hub2 && ![origin.id, dest.id].includes(hub1.id) && ![origin.id, dest.id].includes(hub2.id)) {
      const l1 = pickRepresentative(supplyBetween(origin, hub1, seed + 3));
      const l2 = pickRepresentative(supplyBetween(hub1, hub2, seed + 4));
      const l3 = pickRepresentative(supplyBetween(hub2, dest, seed + 5));
      for (const a of l1) for (const b of l2) for (const c of l3) cands.push({ segments: [a, b, c], viaHubId: `${hub1.id}/${hub2.id}` });
    }
  }

  return cands;
}

// Keep one good representative per mode to limit explosion.
function pickRepresentative(segs: SupplySegment[]): SupplySegment[] {
  if (segs.length === 0) return [];
  const byMode = new Map<Mode, SupplySegment>();
  for (const s of segs) {
    const cur = byMode.get(s.mode);
    if (!cur) byMode.set(s.mode, s);
    else {
      // prefer cheaper or latent supply
      const score = s.baseCost - (s.isLatentSupply ? 2 : 0);
      const curScore = cur.baseCost - (cur.isLatentSupply ? 2 : 0);
      if (score < curScore) byMode.set(s.mode, s);
    }
  }
  return [...byMode.values()];
}

// Materialize a candidate into a concrete itinerary aligned to the time window.
function materialize(
  cand: Candidate,
  event: TransportationEvent,
  origin: Hub,
  dest: Hub,
): ItinerarySegment[] | null {
  const earliest = parseTimeToMin(event.earliestDeparture) ?? parseTimeToMin(event.preferredDeparture) ?? 8 * 60;
  const preferred = parseTimeToMin(event.preferredDeparture) ?? earliest;
  let cursor = preferred;

  const out: ItinerarySegment[] = [];
  for (let i = 0; i < cand.segments.length; i++) {
    const s = cand.segments[i];
    const fromHub = hubById(s.from) ?? (i === 0 ? origin : dest);
    const toHub = hubById(s.to) ?? dest;

    let depart = cursor;
    // align to schedule if transit/carpool
    if (s.scheduledDeparture) {
      const sd = parseTimeToMin(s.scheduledDeparture);
      if (sd != null) {
        // pick the next scheduled departure at/after cursor (within 60 min, else use cursor)
        if (sd >= cursor) depart = sd;
        else if (sd + 60 >= cursor) depart = sd + 60; // loosely, next cycle
        else depart = cursor; // scheduled NPD too far off; treat as ad-hoc
      }
    }
    // respect earliest departure on first leg
    if (i === 0 && depart < earliest) depart = earliest;

    const transferPad = i === 0 ? 0 : TRANSFER_PENALTY_MIN;
    depart = depart + transferPad;
    const arrive = depart + s.baseDurationMin;

    out.push({
      mode: s.mode,
      provider: s.provider,
      from: fromHub.name,
      to: toHub.name,
      depart: minToTime(depart),
      arrive: minToTime(arrive),
      durationMin: s.baseDurationMin,
      cost: s.baseCost,
      distanceKm: s.distanceKm,
      reliability: s.reliability,
      emissionsKgCo2e: s.emissionsKgCo2e,
      comfort: s.comfort,
      safety: s.safety,
      walkingKm: s.walkingKm,
      isLatentSupply: !!s.isLatentSupply,
      notes: s.isLatentSupply ? "Latent supply (NPD): spare capacity on a pre-existing trip" : undefined,
    });
    cursor = arrive;
  }
  return out;
}

// Stochastic ETA variance (minutes, 1-sigma-ish) -----------------------------
function etaVariance(segs: ItinerarySegment[]): number {
  let v = 0;
  for (const s of segs) {
    let segVar: number;
    if (s.mode === "walk") segVar = s.durationMin * 0.12;
    else if (s.mode === "train") segVar = s.durationMin * 0.06;
    else if (s.mode === "bus") segVar = s.durationMin * 0.18;
    else if (s.mode === "ferry") segVar = s.durationMin * 0.14;
    else if (s.mode === "rideshare") segVar = s.durationMin * 0.16;
    else if (s.mode === "carpool") segVar = s.durationMin * 0.22;
    else segVar = s.durationMin * 0.2;
    v += segVar * segVar;
  }
  // transfers add covariance-ish overhead variance
  const transfers = Math.max(0, segs.length - 1);
  v += transfers * TRANSFER_PENALTY_MIN * 0.6 * (transfers * TRANSFER_PENALTY_MIN * 0.6);
  return Math.sqrt(v);
}

// Normal CDF approximation (Abramowitz & Stegun) — for on-time probability
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Score & build a Plan from materialized segments. ---------------------------
function buildPlan(
  segs: ItinerarySegment[],
  event: TransportationEvent,
  tag: Plan["tag"] | null,
): Plan {
  const latest = parseTimeToMin(event.latestArrival);
  const arriveMin = parseTimeToMin(segs[segs.length - 1].arrive) ?? 0;
  const departMin = parseTimeToMin(segs[0].depart) ?? 0;

  const totalCost = round2(segs.reduce((a, s) => a + s.cost, 0));
  const totalDuration = segs.reduce((a, s) => a + s.durationMin, 0) + Math.max(0, segs.length - 1) * TRANSFER_PENALTY_MIN;
  const transfers = Math.max(0, segs.length - 1);
  const walkingKm = round2(segs.reduce((a, s) => a + s.walkingKm, 0));
  const emissions = round2(segs.reduce((a, s) => a + s.emissionsKgCo2e, 0));
  const comfort = avg(segs.map((s) => s.comfort));
  const safety = avg(segs.map((s) => s.safety));
  // joint reliability ~ product, softened
  const relRaw = segs.reduce((acc, s) => acc * Math.max(0.3, s.reliability), 1);
  const reliability = round2(relRaw);

  const sigma = etaVariance(segs);
  let onTime = 1;
  if (latest != null) {
    const slack = latest - arriveMin;
    onTime = round2(Math.max(0.05, Math.min(0.999, normCdf(slack / Math.max(sigma, 1)))));
  }

  // confidence: penalize stale data, high variance, many transfers, latent supply uncertainty
  const avgFresh = avg(segs.map((s) => 2)); // proxy; real impl uses dataFreshnessMin
  const transferPenalty = transfers * 0.04;
  const variancePenalty = Math.min(0.25, sigma / 60);
  const latentPenalty = segs.some((s) => s.isLatentSupply) ? 0.06 : 0;
  const confidence = round2(Math.max(0.4, Math.min(0.98, 0.95 - transferPenalty - variancePenalty - latentPenalty + avgFresh * 0.001)));

  const score = expectedUtility({
    cost: totalCost,
    duration: totalDuration,
    reliability,
    emissions,
    comfort,
    transfers,
    walkingKm,
    safety,
    onTime,
    event,
  });

  return {
    id: "",
    tag: tag ?? "interesting_alternative",
    headline: "",
    segments: segs,
    totalCost,
    totalDurationMin: Math.round(totalDuration),
    depart: segs[0].depart,
    arrive: segs[segs.length - 1].arrive,
    etaVarianceMin: Math.round(sigma),
    onTimeProbability: onTime,
    reliability,
    emissionsKgCo2e: emissions,
    transfers,
    walkingKm,
    comfort: round2(comfort),
    safety: round2(safety),
    score: round2(score),
    confidence,
    tradeoffNote: "",
    usesLatentSupply: segs.some((s) => s.isLatentSupply),
  };
}

interface ScoreInput {
  cost: number;
  duration: number;
  reliability: number;
  emissions: number;
  comfort: number;
  transfers: number;
  walkingKm: number;
  safety: number;
  onTime: number;
  event: TransportationEvent;
}

// Pool-relative normalization happens in rankPlans; here we produce a raw
// utility in 0..1 using logistic transforms on absolute scales.
function expectedUtility(x: ScoreInput): number {
  const w = { ...defaultObjectives(), ...x.event.objectives };
  // risk tolerance modulates reliability/safety emphasis
  const riskBoost = x.event.riskTolerance === "risk-averse" ? 0.18 : x.event.riskTolerance === "risk-seeking" ? -0.12 : 0;

  const nCost = 1 / (1 + Math.exp((x.cost - 22) / 12)); // $22 ~ median
  const nTime = 1 / (1 + Math.exp((x.duration - 45) / 18)); // 45m median
  const nRel = x.reliability * (0.7 + 0.3 * x.onTime);
  const nEm = 1 / (1 + Math.exp((x.emissions - 1.5) / 0.8));
  const nCom = x.comfort;
  const nTrans = 1 / (1 + x.transfers * 0.6);
  const nWalk = 1 / (1 + x.walkingKm * 0.5);
  const nSafe = x.safety;

  const tot =
    w.cost * nCost +
    w.time * nTime +
    (w.reliability + riskBoost) * nRel +
    w.emissions * nEm +
    w.comfort * nCom +
    w.transfers * nTrans +
    w.walking * nWalk +
    (w.safety + riskBoost) * nSafe;
  const wsum =
    w.cost + w.time + w.reliability + riskBoost + w.emissions + w.comfort + w.transfers + w.walking + w.safety + riskBoost;
  return Math.max(0, Math.min(1, tot / Math.max(0.0001, wsum)));
}

function rankPlans(
  event: TransportationEvent,
  origin: Hub,
  dest: Hub,
): { plans: Plan[]; allRaw: Plan[] } {
  const cands = enumerateCandidates(origin, dest, event);
  const plans: Plan[] = [];
  const seen = new Set<string>();
  for (const c of cands) {
    const segs = materialize(c, event, origin, dest);
    if (!segs || segs.length === 0) continue;
    const plan = buildPlan(segs, event, null);
    // hard constraints
    if (event.constraints.budget && plan.totalCost > event.constraints.budget) continue;
    if (event.constraints.maxTransfers != null && plan.transfers > event.constraints.maxTransfers) continue;
    if (event.constraints.maxWalkingKm != null && plan.walkingKm > event.constraints.maxWalkingKm) continue;
    if (event.latestArrival) {
      const latest = parseTimeToMin(event.latestArrival)!;
      const arrive = parseTimeToMin(plan.arrive)!;
      // allow slight tolerance via onTime; hard-fail only if obviously late
      if (arrive > latest + 5) continue;
    }
    const key = segs.map((s) => `${s.mode}:${s.provider}`).join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    plans.push(plan);
  }
  // sort by score
  const all = plans.sort((a, b) => b.score - a.score);
  return { plans: all, allRaw: all };
}

function selectCanonical(sorted: Plan[]): Plan[] {
  if (sorted.length === 0) return [];
  const out: Plan[] = [];
  const push = (p: Plan | undefined, tag: Plan["tag"], headline: string) => {
    if (!p) return;
    if (out.some((o) => o.segments.map((s) => s.provider + s.mode).join() === p.segments.map((s) => s.provider + s.mode).join())) return;
    out.push({ ...p, id: `plan-${out.length}`, tag, headline });
  };
  push(sorted[0], "best_overall", "Best overall — best expected utility given your priorities");
  const cheapest = [...sorted].sort((a, b) => a.totalCost - b.totalCost)[0];
  push(cheapest, "cheapest", "Cheapest feasible option");
  const fastest = [...sorted].sort((a, b) => a.totalDurationMin - b.totalDurationMin)[0];
  push(fastest, "fastest", "Fastest feasible option");
  const reliable = [...sorted].sort((a, b) => b.reliability * b.onTimeProbability - a.reliability * a.onTimeProbability)[0];
  push(reliable, "most_reliable", "Most reliable — highest on-time probability");
  // interesting alternative: latent supply, or most transfers-but-cheaper, or lowest emissions
  const latent = sorted.find((p) => p.usesLatentSupply);
  if (latent && latent !== sorted[0]) push(latent, "interesting_alternative", "Interesting alternative — uses latent supply (shared trip)");
  const greenest = [...sorted].sort((a, b) => a.emissionsKgCo2e - b.emissionsKgCo2e)[0];
  if (greenest && !out.includes(greenest)) push(greenest, "interesting_alternative", "Interesting alternative — lowest emissions");
  return out.slice(0, 5);
}

// Flexibility offers (§10: time is an optimization variable) ----------------
function buildFlexibilityOffers(
  best: Plan | undefined,
  cheapest: Plan | undefined,
  event: TransportationEvent,
): FlexibilityOffer[] {
  const offers: FlexibilityOffer[] = [];
  if (!best) return offers;

  const preferred = parseTimeToMin(event.preferredDeparture ?? event.earliestDeparture) ?? 8 * 60;

  // 1. shift time later (off-peak) — model dynamic pricing drop
  const laterMin = 25;
  const saveLater = Math.round((best.totalCost * 0.12 + 2) * 10) / 10;
  offers.push({
    id: "flex-later",
    kind: "shift_time",
    title: `Leave ${laterMin} min later → save $${saveLater.toFixed(2)}`,
    rationale: "Off-peak demand lowers dynamic rideshare pricing and improves transit frequency.",
    deltaCost: -saveLater,
    deltaEtaMin: laterMin,
    newConfidence: Math.min(0.98, best.confidence + 0.02),
    appliesToPlanId: best.id,
  });

  // 2. shift time earlier
  const earlierMin = 20;
  const saveEarlier = Math.round((best.totalCost * 0.08 + 1) * 10) / 10;
  offers.push({
    id: "flex-earlier",
    kind: "shift_time",
    title: `Leave ${earlierMin} min earlier → save $${saveEarlier.toFixed(2)} and arrive calmer`,
    rationale: "Earlier departure avoids peak congestion and raises on-time probability.",
    deltaCost: -saveEarlier,
    deltaEtaMin: -earlierMin,
    newConfidence: Math.min(0.99, best.confidence + 0.04),
    appliesToPlanId: best.id,
  });

  // 3. allow one more transfer → cheaper
  const currentMax = event.constraints.maxTransfers ?? 2;
  const saveTransfer = Math.round((best.totalCost * 0.15 + 1.5) * 10) / 10;
  offers.push({
    id: "flex-transfer",
    kind: "allow_transfer",
    title: `Allow ${currentMax + 1} transfers → save $${saveTransfer.toFixed(2)}`,
    rationale: "An extra transfer unlocks a cheaper transit+carpool combination.",
    deltaCost: -saveTransfer,
    deltaEtaMin: 8,
    newConfidence: Math.max(0.5, best.confidence - 0.03),
    appliesToPlanId: best.id,
  });

  // 4. share ride (carpool) if not already
  if (!best.usesLatentSupply) {
    const saveShare = Math.round((best.totalCost * 0.4 + 1) * 10) / 10;
    offers.push({
      id: "flex-share",
      kind: "share_ride",
      title: `Share a ride (carpool / latent supply) → save $${saveShare.toFixed(2)}`,
      rationale: "Match with a pre-existing trip (NPD) that has spare capacity on a similar route.",
      deltaCost: -saveShare,
      deltaEtaMin: 5,
      newConfidence: Math.max(0.5, best.confidence - 0.05),
      appliesToPlanId: best.id,
    });
  }

  // 5. book earlier (advance) — only if event is in future
  const saveAdvance = Math.round((best.totalCost * 0.2) * 10) / 10;
  offers.push({
    id: "flex-book",
    kind: "book_earlier",
    title: `Book 3 days earlier → expected savings $${saveAdvance.toFixed(2)}`,
    rationale: "Advance booking unlocks contracted capacity and avoids surge windows.",
    deltaCost: -saveAdvance,
    deltaEtaMin: 0,
    newConfidence: Math.min(0.99, best.confidence + 0.03),
    appliesToPlanId: best.id,
  });

  // 6. watch mode estimate
  const low = Math.round((best.totalCost * 0.78) * 100) / 100;
  const high = Math.round((best.totalCost * 0.92) * 100) / 100;
  offers.push({
    id: "flex-watch",
    kind: "wait_watch",
    title: `Let ORYXX search for 24h → estimated $${low.toFixed(2)}–$${high.toFixed(2)}`,
    rationale: "Continuous optimization may surface a latent-supply match or a price dip.",
    deltaCost: -(Math.round((best.totalCost - low) * 100) / 100),
    deltaEtaMin: 0,
    newConfidence: best.confidence,
    appliesToPlanId: best.id,
  });

  return offers;
}

// Honest unknowns (§19) -------------------------------------------------------
function buildUnknowns(event: TransportationEvent, originSynthetic: boolean, destSynthetic: boolean): string[] {
  const u: string[] = [];
  if (originSynthetic) u.push(`Origin "${event.origin}" was not in ORYXX's hub graph — geometry is inferred.`);
  if (destSynthetic) u.push(`Destination "${event.destination}" was not in ORYXX's hub graph — geometry is inferred.`);
  u.push("Real-time traffic, weather, and incident feeds are simulated in this prototype.");
  if (event.objectives.emissions > 0.6) u.push("Emissions factors are coarse estimates; real ORYXX would use verified EF datasets.");
  return u;
}

// --- Public entry point -----------------------------------------------------
export interface SolveInput {
  event: TransportationEvent;
}

export function solveTransportationEvent(event: TransportationEvent): {
  plans: Plan[];
  flexibilityOffers: FlexibilityOffer[];
  watchEstimate?: { low: number; high: number; hours: number };
  unknowns: string[];
  originSynthetic: boolean;
  destSynthetic: boolean;
} {
  const o = resolveHub(event.origin);
  const d = resolveHub(event.destination);
  const { plans: sorted } = rankPlans(event, o.hub, d.hub);

  if (sorted.length === 0) {
    // synthesise a minimal direct rideshare plan so the UX always has something
    const seed = candidateSeed(o.hub.id, d.hub.id);
    const direct = supplyBetween(o.hub, d.hub, seed).find((s) => s.mode === "rideshare");
    if (direct) {
      const segs = materialize({ segments: [direct] }, event, o.hub, d.hub)!;
      const plan = buildPlan(segs, event, "best_overall");
      plan.id = "plan-0";
      plan.headline = "Direct rideshare (no other feasible plan found under constraints)";
      const offers = buildFlexibilityOffers(plan, plan, event);
      return {
        plans: [plan],
        flexibilityOffers: offers,
        watchEstimate: { low: Math.round(plan.totalCost * 0.78 * 100) / 100, high: Math.round(plan.totalCost * 0.92 * 100) / 100, hours: 24 },
        unknowns: buildUnknowns(event, o.synthetic, d.synthetic),
        originSynthetic: o.synthetic,
        destSynthetic: d.synthetic,
      };
    }
    return {
      plans: [],
      flexibilityOffers: [],
      unknowns: [...buildUnknowns(event, o.synthetic, d.synthetic), "No feasible plan found under current constraints."],
      originSynthetic: o.synthetic,
      destSynthetic: d.synthetic,
    };
  }

  const canonical = selectCanonical(sorted);
  const best = canonical[0];
  const cheapest = canonical.find((p) => p.tag === "cheapest") ?? best;
  const offers = buildFlexibilityOffers(best, cheapest, event);
  const low = Math.round((best.totalCost * 0.78) * 100) / 100;
  const high = Math.round((best.totalCost * 0.92) * 100) / 100;

  // attach tradeoff notes
  for (const p of canonical) {
    p.tradeoffNote = tradeoffNote(p, best, canonical);
  }

  return {
    plans: canonical,
    flexibilityOffers: offers,
    watchEstimate: { low, high, hours: 24 },
    unknowns: buildUnknowns(event, o.synthetic, d.synthetic),
    originSynthetic: o.synthetic,
    destSynthetic: d.synthetic,
  };
}

function tradeoffNote(p: Plan, best: Plan, all: Plan[]): string {
  if (p === best) {
    return `Best expected utility at ${(p.score * 100).toFixed(0)}% given your weighted objectives.`;
  }
  const costDelta = p.totalCost - best.totalCost;
  const timeDelta = p.totalDurationMin - best.totalDurationMin;
  const parts: string[] = [];
  if (costDelta < -0.01) parts.push(`$${Math.abs(costDelta).toFixed(2)} cheaper than best overall`);
  if (costDelta > 0.01) parts.push(`$${costDelta.toFixed(2)} more than cheapest`);
  if (timeDelta < -1) parts.push(`${Math.abs(timeDelta)}m faster than best overall`);
  if (timeDelta > 1) parts.push(`${timeDelta}m slower than fastest`);
  if (p.usesLatentSupply) parts.push("uses shared latent supply");
  if (p.emissionsKgCo2e < best.emissionsKgCo2e) parts.push("lower emissions");
  return parts.length ? parts.join("; ") + "." : "Alternative within tolerance.";
}

// utils ----------------------------------------------------------------------
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
