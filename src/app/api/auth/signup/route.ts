// ORYXX — Signup endpoint.
// Sign-up does NOT create a User account. It adds the email to the Waitlist
// (status=pending). An admin (ekontetevi@gmail) approves entries later, which
// is when a real account is created. This is the explicit waitlist flow.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const email = String(body?.email ?? "").trim().toLowerCase();
  const name = body?.name ? String(body.name).trim() : null;
  const role = body?.role ? String(body.role) : "user";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  }

  try {
    // upsert keeps idempotency: re-signing up just updates the timestamp/role
    const entry = await db.waitlist.upsert({
      where: { email },
      update: { name: name ?? undefined, role, status: "pending", updatedAt: new Date() },
      create: { email, name: name ?? undefined, role, status: "pending" },
    });
    return NextResponse.json({
      ok: true,
      message: "You're on the waitlist. We'll create your account when an admin approves it.",
      status: entry.status,
    });
  } catch (err) {
    console.error("[waitlist/signup]", err);
    return NextResponse.json({ error: "Could not join waitlist." }, { status: 500 });
  }
}
