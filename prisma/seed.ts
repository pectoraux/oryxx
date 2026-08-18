// ORYXX — database seed.
// Creates the admin account (ekontetevi@gmail / Payswap123456) and the four
// demo accounts (shared password "oryxx-demo"). Idempotent: re-runnable.
//
// Run with: bun run db:seed
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";

const db = new PrismaClient();

async function main() {
  const adminEmail = "ekontetevi@gmail";
  const adminPassword = "Payswap123456";

  const admin = await db.user.upsert({
    where: { email: adminEmail },
    update: { role: "admin", status: "active" },
    create: {
      email: adminEmail,
      name: "ORYXX Admin",
      passwordHash: hashPassword(adminPassword),
      role: "admin",
      status: "active",
    },
  });
  console.log(`✓ admin: ${admin.email} (role=${admin.role})`);

  const demos = [
    { email: "demo.rider@oryxx.app", name: "Demo Rider", role: "demo-rider" },
    { email: "demo.driver@oryxx.app", name: "Demo Driver", role: "demo-driver" },
    { email: "demo.shipper@oryxx.app", name: "Demo Shipper", role: "demo-shipper" },
    { email: "demo.fleet@oryxx.app", name: "Demo Fleet Manager", role: "demo-fleet" },
  ];
  const demoPwd = hashPassword("oryxx-demo");
  for (const d of demos) {
    const u = await db.user.upsert({
      where: { email: d.email },
      update: { role: d.role, status: "active", passwordHash: demoPwd },
      create: { email: d.email, name: d.name, role: d.role, status: "active", passwordHash: demoPwd },
    });
    console.log(`✓ demo: ${u.email} (role=${u.role})`);
  }

  console.log("\nSeed complete.");
  console.log("  Admin login:    ekontetevi@gmail / Payswap123456");
  console.log("  Demo logins:   demo.{rider,driver,shipper,fleet}@oryxx.app / oryxx-demo");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
