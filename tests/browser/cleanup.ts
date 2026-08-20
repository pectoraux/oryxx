// ORYXX — Browser test cleanup script.
// Removes all test data created by the browser tests.

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
  },
});
async function main() {
  const adminEmail = process.env.TEST_ADMIN_EMAIL || "e2e-admin@oryxx.test";
  const participantEmail = process.env.TEST_PARTICIPANT_EMAIL || "e2e-participant@oryxx.test";
  const participantBEmail = process.env.TEST_PARTICIPANT_B_EMAIL || "e2e-participant-b@oryxx.test";

  // Clean up test experiment
  const exps = await db.acceptanceExperiment.findMany({
    where: { name: "E2E Browser Test Experiment" },
  });
  for (const exp of exps) {
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

  // Clean up test users
  await db.user.deleteMany({ where: { email: { in: [adminEmail, participantEmail, participantBEmail] } } });

  console.log("E2E cleanup complete.");
  await db.$disconnect();
}

main().catch((e) => {
  console.error("E2E cleanup failed:", e);
  process.exit(1);
});
