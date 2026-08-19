// ORYXX — Admin waitlist management.
// GET    /api/waitlist            → list pending (and all) entries (admin only)
// PATCH  /api/waitlist {id, action:"approve"|"reject", password?}
//         approve → creates a real User account and marks waitlist approved.
//                   password is set if provided; else a random one is generated
//                   and returned (admin can share it / force reset later).
// Only the admin role may call these.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { randomBytes } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function genPassword(): string {
  // 12-char base36 — good enough for an admin-issued temp password.
  return randomBytes(6).toString("hex");
}

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  if (!session || (session.user as any)?.role !== "admin") {
    return null;
  }
  return session;
}

export async function GET(req: Request) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  const url = new URL(req.url);
  const status = url.searchParams.get("status"); // pending | approved | rejected | all
  const where = status && status !== "all" ? { status } : undefined;
  const entries = await db.waitlist.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ entries });
}

export async function PATCH(req: Request) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const id = String(body?.id ?? "");
  const action = String(body?.action ?? "");
  if (!id || !["approve", "reject"].includes(action)) {
    return NextResponse.json({ error: "Provide id and action (approve|reject)." }, { status: 400 });
  }

  const entry = await db.waitlist.findUnique({ where: { id } });
  if (!entry) return NextResponse.json({ error: "Waitlist entry not found." }, { status: 404 });

  if (action === "reject") {
    const updated = await db.waitlist.update({
      where: { id },
      data: { status: "rejected" },
    });
    return NextResponse.json({ ok: true, entry: updated });
  }

  // approve → create a User account
  const existing = await db.user.findUnique({ where: { email: entry.email } });
  if (existing) {
    return NextResponse.json(
      { error: "A user with this email already exists." },
      { status: 409 },
    );
  }
  const password = body?.password ? String(body.password) : genPassword();
  const user = await db.user.create({
    data: {
      email: entry.email,
      name: entry.name,
      passwordHash: hashPassword(password),
      role: entry.role || "user",
      status: "active",
    },
  });
  await db.waitlist.update({
    where: { id },
    data: { status: "approved" },
  });
  return NextResponse.json({
    ok: true,
    userId: user.id,
    email: user.email,
    role: user.role,
    tempPassword: body?.password ? undefined : password,
  });
}
