// ORYXX — W3 Pilot: per-cell results + marketplace decision.
// GET returns per-cell treatment matrix with W3/W4 evidence.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { db } from "@/lib/db";
import {
  generateTreatmentCells,
  computeCellEconomics,
  wilsonCI,
  evaluateMarketplaceDecision,
  type PreregisteredDesign,
  type CellResult,
} from "@/lib/oryxx/real/evidence/pilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const url = new URL(req.url);
  const experimentId = url.searchParams.get("experimentId");

  if (!experimentId) {
    // aggregate across all experiments
    const allResponses = await db.providerResponse.findMany({ select: { state: true, evidenceTier: true, decision: true } });
    const w3 = allResponses.filter((r) => r.evidenceTier === "W3-R").length;
    const w4 = allResponses.filter((r) => r.evidenceTier === "W4-R").length;
    return NextResponse.json({
      totalResponses: allResponses.length,
      w3Count: w3,
      w4Count: w4,
      hasW3Evidence: w3 > 0,
      hasW4Evidence: w4 > 0,
      message: w3 === 0 ? "W3/W4 evidence = 0. No provider has accepted a real offer." : `${w3} W3 acceptances recorded.`,
    });
  }

  const exp = await db.acceptanceExperiment.findUnique({ where: { id: experimentId } });
  if (!exp) return NextResponse.json({ error: "Experiment not found." }, { status: 404 });

  const design: PreregisteredDesign = {
    hypothesis: exp.hypothesis ?? "", population: exp.population ?? "", geography: exp.geography ?? "",
    providerType: exp.providerType ?? "", sampleTarget: exp.sampleTarget,
    compensationBuckets: [1, 2, 3, 4, 5], detourBuckets: [0, 0.5, 1, 2, 3],
    extraTimeBuckets: [0, 2, 5, 10], noticeBuckets: [0, 15, 60],
    randomizationSeed: exp.randomizationSeed, primaryOutcome: exp.primaryOutcome,
    secondaryOutcomes: [], analysisMethod: exp.analysisMethod ?? "", stoppingRule: exp.stoppingRule ?? "",
    safetyRules: [], maxDetourKm: exp.maxDetourKm, maxExtraTimeMin: exp.maxExtraTimeMin,
    minCompensation: exp.minCompensation, consentText: exp.consentText ?? "",
    assumedUserSavings: exp.assumedUserSavings, assumedFailureCost: exp.assumedFailureCost,
    assumedOryxxMargin: exp.assumedOryxxMargin,
  };

  const cells = generateTreatmentCells(design);
  const responses = await db.providerResponse.findMany({ where: { experimentId } });

  // per-cell results
  const cellResults: CellResult[] = cells.map((cell) => {
    const cellResponses = responses.filter((r) => r.treatmentCellId === cell.id);
    const econ = computeCellEconomics(cell, design);
    const offers = cellResponses.length;
    const viewed = cellResponses.filter((r) => ["PROVIDER_VIEWED", "PROVIDER_ACCEPTED", "PROVIDER_DECLINED", "PROVIDER_UNAVAILABLE"].includes(r.state)).length;
    const accepted = cellResponses.filter((r) => ["PROVIDER_ACCEPTED", "TRIP_STARTED", "TRIP_COMPLETED", "TRIP_CANCELLED"].includes(r.state)).length;
    const declined = cellResponses.filter((r) => r.state === "PROVIDER_DECLINED").length;
    const unavailable = cellResponses.filter((r) => r.state === "PROVIDER_UNAVAILABLE").length;
    const ignored = cellResponses.filter((r) => r.state === "PROVIDER_IGNORED").length;
    const started = cellResponses.filter((r) => ["TRIP_STARTED", "TRIP_COMPLETED"].includes(r.state)).length;
    const completed = cellResponses.filter((r) => r.state === "TRIP_COMPLETED").length;
    const cancelled = cellResponses.filter((r) => r.state === "TRIP_CANCELLED").length;

    return {
      cell,
      economics: econ,
      offers, viewed, accepted, declined, unavailable, ignored, started, completed, cancelled,
      acceptanceRate: viewed > 0 ? Math.round((accepted / viewed) * 1000) / 1000 : null,
      completionRate: accepted > 0 ? Math.round((completed / accepted) * 1000) / 1000 : null,
      acceptanceCI95: viewed > 0 ? wilsonCI(accepted, viewed) : null,
      completionCI95: accepted > 0 ? wilsonCI(completed, accepted) : null,
    };
  });

  // marketplace decision (per-cell, with min sample = 30)
  const decision = evaluateMarketplaceDecision(cellResults, 30);

  // event log
  const events = await db.experimentEvent.findMany({ where: { experimentId }, orderBy: { timestamp: "asc" }, take: 50 });

  return NextResponse.json({
    experiment: {
      id: exp.id, name: exp.name, status: exp.status,
      preregistrationHash: exp.preregistrationHash,
      preregisteredAt: exp.preregisteredAt,
      sampleTarget: exp.sampleTarget,
    },
    cellResults,
    marketplaceDecision: decision,
    events: events.map((e) => ({ ...e, participantId: e.participantId.substring(0, 8) + "…" })),
    totalResponses: responses.length,
    w3Count: responses.filter((r) => r.evidenceTier === "W3-R").length,
    w4Count: responses.filter((r) => r.evidenceTier === "W4-R").length,
    hasW3Evidence: responses.some((r) => r.evidenceTier === "W3-R"),
    hasW4Evidence: responses.some((r) => r.evidenceTier === "W4-R"),
  });
}
