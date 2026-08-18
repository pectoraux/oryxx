"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  Navigation,
  Radar,
  Layers,
  Github,
  LogIn,
  ShieldCheck,
  Loader2,
  Sparkles,
  FlaskConical,
  Beaker,
} from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { UserMenu } from "@/components/auth/user-menu";
import { WaitlistAdmin } from "@/components/auth/waitlist-admin";
import { OryxConsole } from "@/components/oryxx/oryx-console";
import { MarketSimulator } from "@/components/oryxx/market-simulator";
import { ExperimentLab } from "@/components/oryxx/experiment-lab";

type View = "solver" | "market" | "experiment";

export default function Home() {
  const { data: session, status } = useSession();
  const [authOpen, setAuthOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [view, setView] = useState<View>("solver");

  const isAuthenticated = status === "authenticated";
  const isAdmin = (session?.user as any)?.role === "admin";

  // First-visit: prompt sign-in automatically.
  useEffect(() => {
    if (status === "unauthenticated") {
      const t = setTimeout(() => setAuthOpen(true), 600);
      return () => clearTimeout(t);
    }
  }, [status]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-600 text-white">
              <Navigation className="h-4 w-4" />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-bold tracking-tight">ORYXX</span>
              <span className="hidden text-[11px] text-muted-foreground sm:inline">
                transportation operating system & market
              </span>
            </div>
          </div>
          <nav className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="hidden text-xs sm:flex" asChild>
              <a href="#thesis"><Radar className="mr-1 h-3.5 w-3.5" /> Thesis</a>
            </Button>
            <Button variant="ghost" size="sm" className="hidden text-xs sm:flex" asChild>
              <a href="#architecture"><Layers className="mr-1 h-3.5 w-3.5" /> Architecture</a>
            </Button>
            {status === "loading" ? (
              <Button variant="ghost" size="sm" disabled>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              </Button>
            ) : isAuthenticated ? (
              <UserMenu
                email={session!.user!.email!}
                name={session!.user!.name}
                role={(session!.user as any).role ?? "user"}
                isAdmin={isAdmin}
                onOpenAdmin={() => setAdminOpen(true)}
              />
            ) : (
              <Button
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700"
                onClick={() => setAuthOpen(true)}
              >
                <LogIn className="mr-1 h-3.5 w-3.5" /> Sign in
              </Button>
            )}
          </nav>
        </div>
      </header>

      {status === "loading" ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
        </div>
      ) : isAuthenticated ? (
        <>
          {isAdmin && adminOpen && (
            <div className="mx-auto w-full max-w-6xl px-4 pt-6">
              <WaitlistAdmin />
            </div>
          )}
          {/* View switcher */}
          <div className="mx-auto w-full max-w-6xl px-4 pt-4">
            <div className="inline-flex rounded-lg border bg-muted/30 p-0.5">
              <button
                onClick={() => setView("solver")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  view === "solver" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Navigation className="h-3.5 w-3.5" /> Intent Solver
              </button>
              <button
                onClick={() => setView("market")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  view === "market" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <FlaskConical className="h-3.5 w-3.5" /> Market Simulator
              </button>
              <button
                onClick={() => setView("experiment")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  view === "experiment" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Beaker className="h-3.5 w-3.5" /> Experiment Lab
              </button>
            </div>
          </div>
          {view === "solver" ? <OryxConsole /> : view === "market" ? <div className="mx-auto w-full max-w-6xl px-4 py-6"><MarketSimulator /></div> : <div className="mx-auto w-full max-w-6xl px-4 py-6"><ExperimentLab /></div>}
        </>
      ) : (
        <UnauthenticatedLanding onSignIn={() => setAuthOpen(true)} />
      )}

      <footer className="mt-auto border-t bg-muted/30">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-4 text-center sm:flex-row sm:text-left">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-emerald-600 text-white">
              <Navigation className="h-3 w-3" />
            </div>
            <span className="text-xs text-muted-foreground">
              ORYXX — moving the world&apos;s people and objects from A to B better than any other
              system.
            </span>
          </div>
          <span className="text-[11px] text-muted-foreground/70">
            Prototype · simulated 3-graph · deterministic solver · LLM intent layer
          </span>
        </div>
      </footer>

      <AuthGate open={authOpen} onClose={() => setAuthOpen(false)} />
    </div>
  );
}

function UnauthenticatedLanding({ onSignIn }: { onSignIn: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="space-y-5"
      >
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-emerald-600 text-white">
          <Navigation className="h-7 w-7" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Move anything from A to B —{" "}
          <span className="text-emerald-600">optimally</span>.
        </h1>
        <p className="mx-auto max-w-xl text-sm text-muted-foreground sm:text-base">
          ORYXX is a transportation operating system and market. It parses your intent into a
          structured event, solves it deterministically across multi-hop routes, ranks the best
          feasible plans with honest confidence, and continuously re-optimizes.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            size="lg"
            className="bg-emerald-600 hover:bg-emerald-700"
            onClick={onSignIn}
          >
            <LogIn className="mr-2 h-4 w-4" /> Sign in to ORYXX
          </Button>
        </div>
        <div className="flex flex-wrap justify-center gap-2 pt-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1 rounded-full border px-2 py-1">
            <Sparkles className="h-3 w-3" /> Demo accounts available
          </span>
          <span className="flex items-center gap-1 rounded-full border px-2 py-1">
            <ShieldCheck className="h-3 w-3" /> Waitlist signup
          </span>
        </div>
      </motion.div>
    </main>
  );
}
