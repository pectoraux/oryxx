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
//
// TEMPORAL FEASIBILITY (Defect 1): for any connecting scheduled segment
// (transit/carpool with a scheduledDeparture), the (effective) scheduled
// departure MUST be at or after the previous segment's arrival + transfer pad.
// If the scheduled departure is strictly before previousArrive + transferPad,
// the connection is infeasible and we return null. Non-scheduled (rideshare/walk)
// segments keep the forward-push behavior (they leave as soon as you're ready).
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

    const transferPad = i === 0 ? 0 : TRANSFER_PENALTY_MIN;
    // previousArrive for i>0 is the cursor (cursor is set to the previous
    // segment's arrive at the end of each iteration).
    const previousArrive = i === 0 ? null : cursor;

    let depart: number;
    if (s.scheduledDeparture) {
      const sd = parseTimeToMin(s.scheduledDeparture);
      if (sd != null) {
        // existing schedule-alignment logic: pick the next scheduled departure
        // at/after cursor (within 60 min, else use cursor as ad-hoc fallback).
        if (sd >= cursor) depart = sd;
        else if (sd + 60 >= cursor) depart = sd + 60; // next cycle
        else depart = cursor; // scheduled NPD too far off; treat as ad-hoc

        // TEMPORAL FEASIBILITY — reject if the connection cannot be caught:
        // (a) the literal scheduled departure is strictly before previousArrive + transferPad
        //     (catches the "08:10 departs, 08:12 arrives" phantom-cycle case), AND
        // (b) the effective aligned departure is strictly before previousArrive + transferPad
        //     (defensive: never trust a connection that gives less than the pad).
        if (i > 0 && previousArrive != null) {
          if (sd < previousArrive + transferPad) return null;
          if (depart < previousArrive + transferPad) return null;
        }
      } else {
        // scheduledDeparture present but unparseable — fall back to ad-hoc.
        depart = cursor + transferPad;
      }
    } else {
      // non-scheduled (rideshare/walk): forward-push — leaves as soon as you're
      // ready, i.e. previousArrive + transferPad.
      depart = cursor + transferPad;
    }

    // respect earliest departure on first leg (preserve leg-0 enforcement)
    if (i === 0 && depart < earliest) depart = earliest;

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
//
// Defect 2: confidence is grounded in REAL data freshness (SupplySegment.
// dataFreshnessMin) rather than a synthetic proxy. ItinerarySegment does not
// carry dataFreshnessMin (we deliberately do not extend types.ts beyond the
// single syntheticWorld addition), so the original SupplySegments are passed
// in alongside and used for the freshness computation.
function buildPlan(
  segs: ItinerarySegment[],
  supplySegs: SupplySegment[],
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

  // confidence: penalize stale data, high variance, many transfers, latent supply uncertainty.
  // Defect 2: avgFresh is the REAL average of SupplySegment.dataFreshnessMin
  // (no longer the fake `2` proxy). Staler data → larger freshnessPenalty →
  // lower confidence.
  const avgFresh = avg(supplySegs.map((s) => s.dataFreshnessMin));
  const transferPenalty = transfers * 0.04;
  const variancePenalty = Math.min(0.25, sigma / 60);
  const latentPenalty = segs.some((s) => s.isLatentSupply) ? 0.06 : 0;
  const freshnessPenalty = Math.min(0.3, Math.max(0, avgFresh / 30));
  const confidence = round2(
    Math.max(0.4, Math.min(0.98, 0.95 - transferPenalty - variancePenalty - latentPenalty - freshnessPenalty)),
  );

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
    // Defect 2: the world graph in this prototype is synthetic. Surfaced so
    // the UI / API consumers can never mistake this for real supply data.
    syntheticWorld: true,
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
    const plan = buildPlan(segs, c.segments, event, null);
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
//
// Defect 3: every offer with a counterfactual action (shift_time / allow_transfer
// / share_ride) is now backed by an ACTUAL re-solve of the modified event via
// the injected `reSolve` function. deltaCost is the REAL difference between the
// re-solved best plan and the current best plan — no fabricated formula.
// `book_earlier` and `wait_watch` cannot be counterfactual in a synthetic world
// (no advance-purchase supply, no real price-feeds), so they are surfaced as
// honestly-labelled informational offers with no fabricated number.
//
// Recursion boundary: `reSolve` MUST be wired to `solveCore`, NOT to
// `solveTransportationEvent` (which itself calls buildFlexibilityOffers).
// `solveCore` returns sorted plans WITHOUT computing flexibility offers, so a
// re-solve cannot recurse into another buildFlexibilityOffers call.

export type ReSolveFn = (
  modifiedEvent: TransportationEvent,
) => { totalCost: number; confidence: number } | null;

// Local time-shift helper (mirrors src/components/oryxx/oryx-console.tsx's
// addMinutes, kept local to solver.ts so the dependency boundary stays clean).
function addMinutesToTime(hhmm: string, deltaMin: number): string {
  const m = parseTimeToMin(hhmm);
  if (m == null) return hhmm;
  const next = ((m + deltaMin) % 1440 + 1440) % 1440;
  return minToTime(next);
}

function buildFlexibilityOffers(
  best: Plan | undefined,
  cheapest: Plan | undefined,
  event: TransportationEvent,
  reSolve: ReSolveFn,
): FlexibilityOffer[] {
  const offers: FlexibilityOffer[] = [];
  if (!best) return offers;

  // Helper: push a counterfactual offer only if the re-solve produced a strictly
  // cheaper plan. deltaCost is the REAL delta (result.totalCost - best.totalCost).
  const pushCounterfactual = (
    id: string,
    kind: FlexibilityOffer["kind"],
    modified: TransportationEvent,
    titleFor: (delta: number) => string,
    rationale: string,
    deltaEtaMin: number,
  ): void => {
    const r = reSolve(modified);
    if (!r) return; // no feasible plan under modified constraint → omit
    const delta = round2(r.totalCost - best.totalCost);
    if (delta >= 0) return; // not beneficial → omit (counterfactual offers must be honest)
    offers.push({
      id,
      kind,
      title: titleFor(delta),
      rationale,
      deltaCost: delta,
      deltaEtaMin,
      newConfidence: r.confidence,
      appliesToPlanId: best.id,
    });
  };

  // 1. shift time later (+25 min on earliest & preferred)
  {
    const laterMin = 25;
    const modified: TransportationEvent = {
      ...event,
      earliestDeparture: addMinutesToTime(event.earliestDeparture, laterMin),
      preferredDeparture: event.preferredDeparture
        ? addMinutesToTime(event.preferredDeparture, laterMin)
        : event.preferredDeparture,
    };
    pushCounterfactual(
      "flex-later",
      "shift_time",
      modified,
      (d) => `Leave ${laterMin} min later → save $${Math.abs(d).toFixed(2)}`,
      "Off-peak demand lowers dynamic rideshare pricing and improves transit frequency. Re-solved against the modified time window.",
      laterMin,
    );
  }

  // 2. shift time earlier (-20 min)
  {
    const earlierMin = 20;
    const modified: TransportationEvent = {
      ...event,
      earliestDeparture: addMinutesToTime(event.earliestDeparture, -earlierMin),
      preferredDeparture: event.preferredDeparture
        ? addMinutesToTime(event.preferredDeparture, -earlierMin)
        : event.preferredDeparture,
    };
    pushCounterfactual(
      "flex-earlier",
      "shift_time",
      modified,
      (d) => `Leave ${earlierMin} min earlier → save $${Math.abs(d).toFixed(2)}`,
      "Earlier departure avoids peak congestion and raises on-time probability. Re-solved against the modified time window.",
      -earlierMin,
    );
  }

  // 3. allow one more transfer
  {
    const currentMax = event.constraints.maxTransfers ?? 2;
    const modified: TransportationEvent = {
      ...event,
      constraints: { ...event.constraints, maxTransfers: currentMax + 1 },
    };
    pushCounterfactual(
      "flex-transfer",
      "allow_transfer",
      modified,
      (d) => `Allow ${currentMax + 1} transfers → save $${Math.abs(d).toFixed(2)}`,
      "An extra transfer unlocks a cheaper transit+carpool combination. Re-solved with the relaxed constraint.",
      8, // informational ETA delta estimate
    );
  }

  // 4. share ride — re-weight objectives to surface latent supply (NPDs)
  if (!best.usesLatentSupply) {
    const modified: TransportationEvent = {
      ...event,
      objectives: { ...event.objectives, cost: 1, comfort: 0.15, safety: 0.5 },
    };
    pushCounterfactual(
      "flex-share",
      "share_ride",
      modified,
      (d) => `Share a ride (carpool / latent supply) → save $${Math.abs(d).toFixed(2)}`,
      "Re-weighted to surface latent supply (NPD) — a pre-existing trip with spare capacity on a similar route. Re-solved with the modified priorities.",
      5, // informational ETA delta estimate
    );
  }

  // 5. book earlier — INFORMATIONAL ONLY (no counterfactual possible in a
  // synthetic world: there is no advance-purchase supply to re-solve against).
  // No fabricated dollar amount.
  offers.push({
    id: "flex-book",
    kind: "book_earlier",
    title: `Book 3 days earlier → estimated savings (requires real supply contracts; not measurable in the synthetic world)`,
    rationale:
      "Advance booking unlocks contracted capacity and avoids surge windows — but ORYXX's prototype world has no advance-purchase supply to re-solve against, so no counterfactual dollar amount is reported.",
    deltaCost: 0,
    deltaEtaMin: 0,
    newConfidence: best.confidence,
    appliesToPlanId: best.id,
  });

  // 6. wait & watch — INFORMATIONAL simulated estimate, clearly labelled.
  const low = round2(best.totalCost * 0.78);
  const high = round2(best.totalCost * 0.92);
  offers.push({
    id: "flex-watch",
    kind: "wait_watch",
    title: `Let ORYXX search for 24h → simulated estimate $${low.toFixed(2)}–$${high.toFixed(2)}`,
    rationale:
      "Continuous optimization may surface a latent-supply match or a price dip. This is a simulation estimate, not a counterfactual solve — the synthetic world has no real-time price feeds.",
    deltaCost: round2(low - best.totalCost),
    deltaEtaMin: 0,
    newConfidence: best.confidence,
    appliesToPlanId: best.id,
  });

  // Silence the unused `cheapest` parameter lint if any — kept in the signature
  // for API stability; the cheapest plan currently informs future
  // counterfactuals but isn't required for the four we surface today.
  void cheapest;

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

// --- Core solver (no flexibility, no fallback synthesis) ---------------------
// Defect 3 (recursion boundary): the public `solveTransportationEvent` calls
// buildFlexibilityOffers, and buildFlexibilityOffers needs to re-solve modified
// events via `reSolve`. To prevent infinite recursion (reSolve → solve →
// buildFlexibilityOffers → reSolve → ...), `reSolve` is wired to `solveCore`,
// which returns ONLY sorted plans — it does NOT compute flexibility offers
// and does NOT synthesise a fallback plan. Both the top-level public solve and
// the counterfactual re-solve go through solveCore.
function solveCore(event: TransportationEvent): Plan[] {
  const o = resolveHub(event.origin);
  const d = resolveHub(event.destination);
  const { plans: sorted } = rankPlans(event, o.hub, d.hub);
  return sorted;
}

// Synthesise a minimal direct rideshare plan when no feasible plan exists under
// the constraints, so the UX always has something to show.
function synthesizeFallbackPlan(event: TransportationEvent): Plan | null {
  const o = resolveHub(event.origin);
  const d = resolveHub(event.destination);
  const seed = candidateSeed(o.hub.id, d.hub.id);
  const direct = supplyBetween(o.hub, d.hub, seed).find((s) => s.mode === "rideshare");
  if (!direct) return null;
  const segs = materialize({ segments: [direct] }, event, o.hub, d.hub);
  if (!segs) return null;
  const plan = buildPlan(segs, [direct], event, "best_overall");
  plan.id = "plan-0";
  plan.headline = "Direct rideshare (no other feasible plan found under constraints)";
  return plan;
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
  const sorted = solveCore(event);

  // reSolve: counterfactual re-solve of a modified event. Returns the
  // totalCost + confidence of the modified event's best plan, or null if no
  // feasible plan exists under the modified constraints. Critically: this
  // calls solveCore (NOT solveTransportationEvent), so it cannot recurse into
  // buildFlexibilityOffers.
  const reSolve: ReSolveFn = (modifiedEvent) => {
    const plans = solveCore(modifiedEvent);
    if (plans.length === 0) return null;
    const p = plans[0];
    return { totalCost: p.totalCost, confidence: p.confidence };
  };

  if (sorted.length === 0) {
    // synthesise a minimal direct rideshare plan so the UX always has something
    const plan = synthesizeFallbackPlan(event);
    if (plan) {
      const offers = buildFlexibilityOffers(plan, plan, event, reSolve);
      return {
        plans: [plan],
        flexibilityOffers: offers,
        watchEstimate: { low: round2(plan.totalCost * 0.78), high: round2(plan.totalCost * 0.92), hours: 24 },
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
  // Defect 3: buildFlexibilityOffers now takes the reSolve callback so each
  // counterfactual offer reflects a real re-solve, not a fabricated formula.
  const offers = buildFlexibilityOffers(best, cheapest, event, reSolve);
  const low = round2(best.totalCost * 0.78);
  const high = round2(best.totalCost * 0.92);

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
