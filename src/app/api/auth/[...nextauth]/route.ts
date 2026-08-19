// ORYXX — NextAuth catch-all route.
// Handles /api/auth/* (signin, signout, session, csrf, etc.).
import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth/options";

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
