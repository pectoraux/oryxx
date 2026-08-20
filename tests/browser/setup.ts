// ORYXX — Browser test setup script.
//
// Creates the test database state needed for the browser E2E tests:
//   - Test admin account
//   - Test participant account
//   - Test participant B account (for cross-participant authorization)
//   - Test experiment (created, preregistered, activated)
//
// Run AFTER prisma db push, BEFORE the Next.js dev server starts.
// Idempotent — safe to re-run.

import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import {
  computePreregistrationHash,
  type PreregisteredDesign,
} from "../src/lib/oryxx/real/evidence/pilot";

const db = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
  },
});

const TEST_DESIGN: PreregisteredDesign = {
  hypothesis: "Providers will accept pooled-trip offers when comp >= $3 and detour <= 2km.",
  population: "ride-hail drivers",
  geography: "NYC",
  providerType: "taxi/FHV",
  sampleTarget: 100,
  compensationBuckets: [1, 2, 3, 4, 5],
  detourBuckets: [0, 0.5, 1, 2, 3],
  extraTimeBuckets: [0, 2, 5, 10],
  noticeBuckets: [0, 15, 60],
  randomizationSeed: 42,
  primaryOutcome: "W3_acceptance_rate",
  secondaryOutcomes: ["W4-R_completion_rate", "net_value"],
  analysisMethod: "per-cell Wilson CI",
  stoppingRule: "Stop after 100 responses or 30 days.",
  safetyRules: [],
  maxDetourKm: 5,
  maxExtraTimeMin: 20,
  minCompensation: 1,
  consentText: "RESEARCH STUDY - THIS IS NOT A MARKETPLACE BOOKING. You are participating in research about provider willingness. You may withdraw at any time.",
  assumedUserSavings: 4,
  assumedFailureCost: 1,
  assumedOryxxMargin: 0.5,
};

async function main() {
  const adminEmail = process.env.TEST_ADMIN_EMAIL || "e2e-admin@oryxx.test";
  const adminPassword = process.env.TEST_ADMIN_PASSWORD || "E2E-Admin-Pw-123!";
  const participantEmail = process.env.TEST_PARTICIPANT_EMAIL || "e2e-participant@oryxx.test";
  const participantPassword = process.env.TEST_PARTICIPANT_PASSWORD || "E2E-Participant-Pw-123!";
  const participantBEmail = process.env.TEST_PARTICIPANT_B_EMAIL || "e2e-participant-b@oryxx.test";
  const participantBPassword = process.env.TEST_PARTICIPANT_B_PASSWORD || "E2E-ParticipantB-Pw-123!";

  // Create admin account
  await db.user.upsert({
    where: { email: adminEmail },
    update: { role: "admin", status: "active", passwordHash: hashPassword(adminPassword) },
    create: { email: adminEmail, name: "E2E Admin", role: "admin", status: "active", passwordHash: hashPassword(adminPassword) },
  });

  // Create participant account
  await db.user.upsert({
    where: { email: participantEmail },
    update: { role: "user", status: "active", passwordHash: hashPassword(participantPassword) },
    create: { email: participantEmail, name: "E2E Participant", role: "user", status: "active", passwordHash: hashPassword(participantPassword) },
  });

  // Create participant B account (for cross-participant test)
  await db.user.upsert({
    where: { email: participantBEmail },
    update: { role: "user", status: "active", passwordHash: hashPassword(participantBPassword) },
    create: { email: participantBEmail, name: "E2E Participant B", role: "user", status: "active", passwordHash: hashPassword(participantBPassword) },
  });

  // Clean up any previous test experiment
  const prevExps = await db.acceptanceExperiment.findMany({
    where: { name: "E2E Browser Test Experiment" },
  });
  for (const exp of prevExps) {
    const enrolls = await db.experimentEnrollment.findMany({ where: { experimentId: exp.id }, select: { id: true } });
    const eids = enrolls.map((e) => e.id);
    if (eids.length > 0) {
      await db.providerResponse.deleteMany({ where: { enrollmentId: { in: eids } } });
      await db.experimentConsent.deleteMany({ where: { enrollmentId: { in: eids } } });
    }
    await db.experimentEvent.deleteMany({ where: { experimentId: exp.id } });
    await db.experimentEnrollment.deleteMany({ where: { experimentId: exp.id } });
    await db.acceptanceExperiment.delete({ where: { id: exp.id } }).catch(() => {});
  }

  // Create + preregister + activate the test experiment
  const hash = computePreregistrationHash(TEST_DESIGN);
  const exp = await db.acceptanceExperiment.create({
    data: {
      name: "E2E Browser Test Experiment",
      description: "Auto-created for browser E2E test. Cleaned up after run.",
      status: "ACTIVE",
      maxDetourKm: 5.0,
      maxExtraTimeMin: 20.0,
      minCompensation: 1.0,
      hypothesis: TEST_DESIGN.hypothesis,
      sampleTarget: 100,
      primaryOutcome: "W3_acceptance_rate",
      stoppingRule: TEST_DESIGN.stoppingRule,
      randomizationSeed: 42,
      consentText: TEST_DESIGN.consentText,
      consentVersion: 1,
      preregistrationHash: hash,
      preregisteredAt: new Date().toISOString(),
      treatmentDesignJson: JSON.stringify(TEST_DESIGN),
      assumedUserSavings: 4.0,
      assumedFailureCost: 1.0,
      assumedOryxxMargin: 0.5,
    },
  });

  // Clean up any previous test enrollments for the participant
  await db.experimentEnrollment.deleteMany({
    where: { accountEmail: { in: [participantEmail, participantBEmail] } },
  });

  console.log(`E2E setup complete. Experiment ID: ${exp.id}`);
  console.log(`TEST_EXPERIMENT_ID=${exp.id}`);

  await db.$disconnect();
}

main().catch((e) => {
  console.error("E2E setup failed:", e);
  process.exit(1);
});
