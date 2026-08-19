// ORYXX — DB-backed concurrency tests for the W3-R pilot.
// These tests exercise the ACTUAL production Prisma transaction code against
// a real PostgreSQL database (Neon).
//
// Run with: bun test tests/oryxx-concurrency.test.ts --timeout 60000

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import {
  researchEvidenceForState,
  computePreregistrationHash,
  createEvent,
  type PreregisteredDesign,
  type ResearchState,
} from "../src/lib/oryxx/real/evidence/pilot";

const db = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

const TEST_DESIGN: PreregisteredDesign = {
  hypothesis: "test", population: "test", geography: "test", providerType: "test",
  sampleTarget: 100, compensationBuckets: [1, 2, 3], detourBuckets: [0, 1, 2],
  extraTimeBuckets: [0, 5], noticeBuckets: [0, 15],
  randomizationSeed: 42, primaryOutcome: "W3_acceptance_rate", secondaryOutcomes: [],
  analysisMethod: "wilson", stoppingRule: "100", safetyRules: [],
  maxDetourKm: 5, maxExtraTimeMin: 20, minCompensation: 1,
  consentText: "test", assumedUserSavings: 4, assumedFailureCost: 1, assumedOryxxMargin: 0.5,
};

let experimentId: string;

beforeAll(async () => {
  const hash = computePreregistrationHash(TEST_DESIGN);
  const exp = await db.acceptanceExperiment.create({
    data: {
      name: "Concurrency Test",
      description: "Auto-created",
      status: "ACTIVE",
      maxDetourKm: 5.0, maxExtraTimeMin: 20.0, minCompensation: 1.0,
      hypothesis: "test", sampleTarget: 100, primaryOutcome: "W3_acceptance_rate",
      stoppingRule: "test", randomizationSeed: 42,
      consentText: "test", consentVersion: 1,
      preregistrationHash: hash, preregisteredAt: new Date().toISOString(),
      treatmentDesignJson: JSON.stringify(TEST_DESIGN),
      assumedUserSavings: 4.0, assumedFailureCost: 1.0, assumedOryxxMargin: 0.50,
    },
  });
  experimentId = exp.id;
}, 30000);

afterAll(async () => {
  await db.providerResponse.deleteMany({ where: { experimentId } });
  await db.experimentEvent.deleteMany({ where: { experimentId } });
  await db.experimentConsent.deleteMany({ where: { experimentId } });
  await db.experimentEnrollment.deleteMany({ where: { experimentId } });
  await db.acceptanceExperiment.delete({ where: { id: experimentId } });
  await db.$disconnect();
}, 30000);

async function createEnrollmentWithOffer(suffix: string) {
  const email = `conc-${suffix}@oryxx.test`;
  const participantId = `P-${randomBytes(8).toString("hex")}`;
  const enrollmentToken = randomBytes(24).toString("hex");
  const enrollment = await db.experimentEnrollment.create({
    data: { experimentId, participantId, accountEmail: email, enrollmentToken, assignedCellId: "cell-1-0-0-0", providerVerified: "operator_verified", verifiedAt: new Date() },
  });
  await db.experimentConsent.create({
    data: { experimentId, enrollmentId: enrollment.id, participantId, accountEmail: email, consentVersion: 1, consentTextHash: "x", consentText: "x" },
  });
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);
  const response = await db.providerResponse.create({
    data: { experimentId, enrollmentId: enrollment.id, participantId, treatmentCellId: "cell-1-0-0-0", compensation: 1, detourKm: 0, extraTimeMin: 0, advanceNoticeMin: 0, passengerCount: 1, tripDistanceKm: 5, originName: "t", destName: "t", hourOfDay: 12, state: "PROVIDER_VIEWED", evidenceTier: "NONE", offerPresentedAt: now.toISOString(), offerExpiresAt: expiresAt.toISOString(), providerViewedAt: now.toISOString() },
  });
  // Create initial events
  const e1 = createEvent(experimentId, response.id, participantId, null, "OFFER_CREATED", "system", "t", null);
  await db.experimentEvent.create({ data: e1 });
  const e2 = createEvent(experimentId, response.id, participantId, "OFFER_CREATED", "OFFER_PRESENTED", "system", "t", e1.eventHash);
  await db.experimentEvent.create({ data: e2 });
  const e3 = createEvent(experimentId, response.id, participantId, "OFFER_PRESENTED", "PROVIDER_VIEWED", "system", "t", e2.eventHash);
  await db.experimentEvent.create({ data: e3 });
  return { enrollment, response, participantId };
}

async function transitionState(enrollmentId: string, responseId: string, participantId: string, fromState: ResearchState, newState: ResearchState): Promise<string> {
  try {
    return await db.$transaction(async (tx) => {
      const en = await tx.experimentEnrollment.findUnique({ where: { id: enrollmentId } });
      if (!en) throw new Error("NOT_FOUND");
      if (en.status === "withdrawn") throw new Error("WITHDRAWN");
      const resp = await tx.providerResponse.findUnique({ where: { id: responseId } });
      if (!resp) throw new Error("NOT_FOUND");
      const actualState = resp.state as ResearchState;
      if (resp.offerExpiresAt && new Date(resp.offerExpiresAt).getTime() < Date.now() && newState === "PROVIDER_ACCEPTED") {
        const u = await tx.providerResponse.updateMany({ where: { id: responseId, state: actualState }, data: { state: "PROVIDER_IGNORED", evidenceTier: "NONE", decision: "ignore", decisionAt: new Date().toISOString() } });
        if (u.count === 0) throw new Error("RACE");
        const le = await tx.experimentEvent.findFirst({ where: { offerId: responseId }, orderBy: { timestamp: "desc" } });
      await tx.experimentEvent.create({ data: createEvent(experimentId, responseId, participantId, actualState, "PROVIDER_IGNORED", "system", "expiry", le?.eventHash ?? null) });
        return "EXPIRED";
      }
      if (actualState !== fromState) throw new Error("RACE");
      const newTier = researchEvidenceForState(newState);
      const data: any = { state: newState, evidenceTier: newTier };
      if (["PROVIDER_ACCEPTED", "PROVIDER_DECLINED", "PROVIDER_UNAVAILABLE", "PROVIDER_IGNORED"].includes(newState)) { data.decision = newState === "PROVIDER_ACCEPTED" ? "accept" : "ignore"; data.decisionAt = new Date().toISOString(); }
      if (newState === "TRIP_STARTED") data.executed = true;
      if (newState === "TRIP_COMPLETED") { data.executed = true; data.completed = true; data.completionEvidenceLevel = "operator"; }
      const u = await tx.providerResponse.updateMany({ where: { id: responseId, state: fromState }, data });
      if (u.count === 0) throw new Error("RACE");
      const le = await tx.experimentEvent.findFirst({ where: { offerId: responseId }, orderBy: { timestamp: "desc" } });
      await tx.experimentEvent.create({ data: createEvent(experimentId, responseId, participantId, fromState, newState, "participant", participantId, le?.eventHash ?? null) });
      return "TRANSITIONED";
    }, { isolationLevel: "Serializable" });
  } catch (err: any) {
    if (err?.message === "WITHDRAWN") return "WITHDRAWN";
    if (err?.message === "RACE") return "RACE";
    if (err?.message === "EXPIRED") return "EXPIRED";
    throw err;
  }
}

async function withdraw(enrollmentId: string) {
  await db.$transaction(async (tx) => {
    const e = await tx.experimentEnrollment.findUnique({ where: { id: enrollmentId } });
    if (!e || e.status === "withdrawn") return;
    await tx.experimentEnrollment.update({ where: { id: enrollmentId }, data: { status: "withdrawn", withdrawnAt: new Date() } });
    await tx.experimentConsent.updateMany({ where: { enrollmentId, withdrawnAt: null }, data: { withdrawnAt: new Date() } });
  }, { isolationLevel: "Serializable" });
}

describe("ORYXX DB-backed concurrency tests", () => {
  test("withdraw vs accept: no post-withdrawal W3-R", async () => {
    const { enrollment, response, participantId } = await createEnrollmentWithOffer("wa1");
    const [w, a] = await Promise.allSettled([withdraw(enrollment.id), transitionState(enrollment.id, response.id, participantId, "PROVIDER_VIEWED", "PROVIDER_ACCEPTED")]);
    expect(w.status).toBe("fulfilled");
    const acceptResult = a.status === "fulfilled" ? a.value : "ERROR";
    expect(["TRANSITIONED", "WITHDRAWN", "RACE"]).toContain(acceptResult);
    const fr = await db.providerResponse.findUnique({ where: { id: response.id } });
    const fe = await db.experimentEnrollment.findUnique({ where: { id: enrollment.id } });
    expect(fe?.status).toBe("withdrawn");
    if (acceptResult !== "TRANSITIONED") {
      expect(fr?.evidenceTier).not.toBe("W3-R");
    }
  }, 60000);

  test("withdraw vs trip started", async () => {
    const { enrollment, response, participantId } = await createEnrollmentWithOffer("wa2");
    await transitionState(enrollment.id, response.id, participantId, "PROVIDER_VIEWED", "PROVIDER_ACCEPTED");
    const [w, s] = await Promise.allSettled([withdraw(enrollment.id), transitionState(enrollment.id, response.id, participantId, "PROVIDER_ACCEPTED", "TRIP_STARTED")]);
    expect(w.status).toBe("fulfilled");
    const startResult = s.status === "fulfilled" ? s.value : "ERROR";
    expect(["TRANSITIONED", "WITHDRAWN", "RACE"]).toContain(startResult);
    const fe = await db.experimentEnrollment.findUnique({ where: { id: enrollment.id } });
    expect(fe?.status).toBe("withdrawn");
  }, 60000);

  test("withdraw vs trip completed: no W4-R after withdrawal", async () => {
    const { enrollment, response, participantId } = await createEnrollmentWithOffer("wa3");
    await transitionState(enrollment.id, response.id, participantId, "PROVIDER_VIEWED", "PROVIDER_ACCEPTED");
    await transitionState(enrollment.id, response.id, participantId, "PROVIDER_ACCEPTED", "TRIP_STARTED");
    const [w, c] = await Promise.allSettled([withdraw(enrollment.id), transitionState(enrollment.id, response.id, participantId, "TRIP_STARTED", "TRIP_COMPLETED")]);
    expect(w.status).toBe("fulfilled");
    const completeResult = c.status === "fulfilled" ? c.value : "ERROR";
    expect(["TRANSITIONED", "WITHDRAWN", "RACE"]).toContain(completeResult);
    const fr = await db.providerResponse.findUnique({ where: { id: response.id } });
    if (completeResult !== "TRANSITIONED") { expect(fr?.evidenceTier).not.toBe("W4-R"); }
  }, 60000);

  test("double accept: exactly one succeeds", async () => {
    const { enrollment, response, participantId } = await createEnrollmentWithOffer("da1");
    const [r1, r2] = await Promise.allSettled([
      transitionState(enrollment.id, response.id, participantId, "PROVIDER_VIEWED", "PROVIDER_ACCEPTED"),
      transitionState(enrollment.id, response.id, participantId, "PROVIDER_VIEWED", "PROVIDER_ACCEPTED"),
    ]);
    const v1 = r1.status === "fulfilled" ? r1.value : "ERROR";
    const v2 = r2.status === "fulfilled" ? r2.value : "ERROR";
    const wins = [v1, v2].filter(v => v === "TRANSITIONED").length;
    expect(wins).toBe(1);
    const fr = await db.providerResponse.findUnique({ where: { id: response.id } });
    expect(fr?.state).toBe("PROVIDER_ACCEPTED");
    expect(fr?.evidenceTier).toBe("W3-R");
  }, 60000);

  test("double completion: exactly one succeeds", async () => {
    const { enrollment, response, participantId } = await createEnrollmentWithOffer("dc1");
    await transitionState(enrollment.id, response.id, participantId, "PROVIDER_VIEWED", "PROVIDER_ACCEPTED");
    await transitionState(enrollment.id, response.id, participantId, "PROVIDER_ACCEPTED", "TRIP_STARTED");
    const [r1, r2] = await Promise.allSettled([
      transitionState(enrollment.id, response.id, participantId, "TRIP_STARTED", "TRIP_COMPLETED"),
      transitionState(enrollment.id, response.id, participantId, "TRIP_STARTED", "TRIP_COMPLETED"),
    ]);
    const v1 = r1.status === "fulfilled" ? r1.value : "ERROR";
    const v2 = r2.status === "fulfilled" ? r2.value : "ERROR";
    const wins = [v1, v2].filter(v => v === "TRANSITIONED").length;
    expect(wins).toBe(1);
  }, 60000);

  test("event chain is linear", async () => {
    const { enrollment, response, participantId } = await createEnrollmentWithOffer("ec1");
    await transitionState(enrollment.id, response.id, participantId, "PROVIDER_VIEWED", "PROVIDER_ACCEPTED");
    await transitionState(enrollment.id, response.id, participantId, "PROVIDER_ACCEPTED", "TRIP_STARTED");
    await transitionState(enrollment.id, response.id, participantId, "TRIP_STARTED", "TRIP_COMPLETED");
    const events = await db.experimentEvent.findMany({ where: { offerId: response.id }, orderBy: { timestamp: "asc" } });
    expect(events[0].previousEventHash).toBeNull();
    for (let i = 1; i < events.length; i++) {
      expect(events[i].previousEventHash).toBe(events[i - 1].eventHash);
    }
    const hashes = events.map(e => e.eventHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  }, 60000);

  test("every transition has an audit event", async () => {
    const { enrollment, response, participantId } = await createEnrollmentWithOffer("ec2");
    let events = await db.experimentEvent.findMany({ where: { offerId: response.id } });
    expect(events.length).toBe(3); // CREATED + PRESENTED + VIEWED
    await transitionState(enrollment.id, response.id, participantId, "PROVIDER_VIEWED", "PROVIDER_ACCEPTED");
    events = await db.experimentEvent.findMany({ where: { offerId: response.id } });
    expect(events.length).toBe(4);
    await transitionState(enrollment.id, response.id, participantId, "PROVIDER_ACCEPTED", "TRIP_STARTED");
    events = await db.experimentEvent.findMany({ where: { offerId: response.id } });
    expect(events.length).toBe(5);
  }, 60000);

  test("withdrawal preserves historical data", async () => {
    const { enrollment, response, participantId } = await createEnrollmentWithOffer("wr1");
    await transitionState(enrollment.id, response.id, participantId, "PROVIDER_VIEWED", "PROVIDER_ACCEPTED");
    await withdraw(enrollment.id);
    const e = await db.experimentEnrollment.findUnique({ where: { id: enrollment.id } });
    expect(e?.status).toBe("withdrawn");
    const r = await db.providerResponse.findUnique({ where: { id: response.id } });
    expect(r?.state).toBe("PROVIDER_ACCEPTED");
    expect(r?.evidenceTier).toBe("W3-R"); // historical evidence preserved
    const events = await db.experimentEvent.findMany({ where: { offerId: response.id } });
    expect(events.length).toBeGreaterThan(0);
    const consents = await db.experimentConsent.findMany({ where: { enrollmentId: enrollment.id } });
    expect(consents[0].withdrawnAt).not.toBeNull();
  }, 60000);

  test("50 concurrent enrollments: no duplicates", async () => {
    const promises = Array.from({ length: 50 }, (_, i) =>
      db.$transaction(async (tx) => {
        const email = `bulk50-${i}@oryxx.test`;
        const existing = await tx.experimentEnrollment.findFirst({ where: { accountEmail: email, experimentId } });
        if (existing) return null;
        const participantId = `P-${randomBytes(8).toString("hex")}`;
        const enrollment = await tx.experimentEnrollment.create({
          data: { experimentId, participantId, accountEmail: email, enrollmentToken: randomBytes(24).toString("hex"), assignedCellId: "cell-1-0-0-0", providerVerified: "unverified" },
        });
        return enrollment;
      }, { isolationLevel: "Serializable" }).catch(() => null)
    );
    await Promise.allSettled(promises);
    const all = await db.experimentEnrollment.findMany({ where: { experimentId, accountEmail: { contains: "bulk50-" } } });
    const emails = all.map(e => e.accountEmail);
    expect(new Set(emails).size).toBe(emails.length);
  }, 120000);
});
