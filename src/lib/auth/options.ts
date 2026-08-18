// ORYXX — NextAuth v4 configuration.
//
// Credentials provider (email + password). JWT session strategy (required for
// Credentials). The waitlist flow is handled separately (signup just creates a
// Waitlist row, no account until an admin approves).

import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { db } from "@/lib/db";
import { verifyPassword } from "./password";

export const DEMO_ACCOUNTS = [
  { email: "demo.rider@oryxx.app", role: "demo-rider", name: "Demo Rider" },
  { email: "demo.driver@oryxx.app", role: "demo-driver", name: "Demo Driver" },
  { email: "demo.shipper@oryxx.app", role: "demo-shipper", name: "Demo Shipper" },
  { email: "demo.fleet@oryxx.app", role: "demo-fleet", name: "Demo Fleet Manager" },
];

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: {
    // We use a modal on /, but keep these for NextAuth internals / direct hits.
    signIn: "/",
    error: "/",
  },
  providers: [
    CredentialsProvider({
      name: "ORYXX",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password ?? "";
        if (!email || !password) return null;

        let user;
        try {
          user = await db.user.findUnique({ where: { email } });
        } catch (e) {
          console.error("[oryxx:auth] authorize: DB error", e);
          return null;
        }
        if (!user || !user.passwordHash) return null;
        if (user.status !== "active") return null;
        if (!verifyPassword(password, user.passwordHash)) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? undefined,
          role: user.role,
        } as any;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = (user as any).id;
        token.role = (user as any).role;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = token.id;
        (session.user as any).role = token.role;
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};

// Role helper for the frontend.
export type Role =
  | "user"
  | "admin"
  | "demo-rider"
  | "demo-driver"
  | "demo-shipper"
  | "demo-fleet";

export function roleLabel(role: string): string {
  switch (role) {
    case "admin":
      return "Administrator";
    case "demo-rider":
      return "Rider";
    case "demo-driver":
      return "Driver";
    case "demo-shipper":
      return "Shipper";
    case "demo-fleet":
      return "Fleet Manager";
    default:
      return "User";
  }
}
