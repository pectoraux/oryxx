// ORYXX — W3 Pilot: results + evidence counts + marketplace decision.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { db } from "@/lib/db";
import { emptyEvidenceCounts, wilsonCI, evaluateMarketplaceDecision, computeCellEconomics, generateTreatmentCells } from "@/lib/oryxx/real/evidence/pilot";
import type { PreregisteredExperiment } from "@/lib/oryxx/real/evidence/pilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });

  const url = new URL(req.url);
  const experimentId = url.searchParams.get("experimentId");

  const where = experimentId ? { experimentId } : {};
  const responses = await db.providerResponse.findMany({ where });

  const counts = emptyEvidenceCounts();
  counts.totalResponses = responses.length;
  counts.offersPresented = responses.filter((r) => r.state !== "OFFER_CREATED").length;
  counts.offersViewed = responses.filter((r) => ["PROVIDER_VIEWED", "PROVIDER_ACCEPTED", "PROVIDER_DECLINED", "PROVIDER_UNAVAILABLE"].includes(r.state)).length;
  counts.accepted = responses.filter((r) => ["PROVIDER_ACCEPTED", "TRIP_STARTED", "TRIP_COMPLETED"].includes(r.state)).length;
  counts.declined = responses.filter((r) => r.state === "PROVIDER_DECLINED").length;
  counts.unavailable = responses.filter((r) => r.state === "PROVIDER_UNAVAILABLE").length;
  counts.ignored = responses.filter((r) => r.state === "PROVIDER_IGNORED").length;
  counts.tripStarted = responses.filter((r) => ["TRIP_STARTED", "TRIP_COMPLETED"].includes(r.state)).length;
  counts.tripCompleted = responses.filter((r) => r.state === "TRIP_COMPLETED").length;
  counts.tripCancelled = responses.filter((r) => r.state === "TRIP_CANCELLED").length;
  counts.w3 = counts.accepted;
  counts.w4 = counts.tripCompleted;

  if (counts.offersViewed > 0) {
    counts.acceptanceRate = Math.round((counts.accepted / counts.offersViewed) * 1000) / 1000;
    counts.acceptanceCI95 = wilsonCI(counts.accepted, counts.offersViewed);
  }
  if (counts.accepted > 0) {
    counts.completionRate = Math.round((counts.tripCompleted / counts.accepted) * 1000) / 1000;
    counts.completionCI95 = wilsonCI(counts.tripCompleted, counts.accepted);
  }

  // treatment matrix (per-cell economics)
  const cells = generateTreatmentCells({
    experimentId: experimentId ?? "default",
    version: 1, hypothesis: "", population: "", geography: "", providerType: "",
    sampleTarget: 100,
    compensationBuckets: [1, 2, 3, 4, 5],
    detourBuckets: [0, 0.5, 1, 2, 3],
    extraTimeBuckets: [0, 2, 5, 10],
    noticeBuckets: [0, 15, 60],
    randomizationSeed: 42,
    primaryOutcome: "W3_acceptance_rate", secondaryOutcomes: [], analysisMethod: "",
    stoppingRule: "", safetyRules: [],
    maxDetourKm: 5, maxExtraTimeMin: 20, minCompensation: 1,
    consentText: "", requiresConsent: true,
    status: "preregistered", preregisteredAt: "", isImmutable: false,
  } as PreregisteredExperiment);

  const cellEconomics = cells.map(c => computeCellEconomics(c));

  // marketplace decision
  const decision = evaluateMarketplaceDecision(cells, counts);

  return NextResponse.json({
    evidence: counts,
    hasW3Evidence: counts.w3 > 0,
    hasW4Evidence: counts.w4 > 0,
    evidenceTier: counts.w4 > 0 ? "W4" : counts.w3 > 0 ? "W3" : "W0",
    treatmentCells: cellEconomics,
    marketplaceDecision: decision,
    responses: responses.map((r) => ({ ...r, providerId: r.providerId.substring(0, 8) + "…" })),
  });
}
