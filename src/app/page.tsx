"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import {
  Navigation,
  Radar,
  Github,
  LogIn,
  ShieldCheck,
  Loader2,
  Sparkles,
  FlaskConical,
  Beaker,
  Globe,
  Layers,
  Filter,
  UserCheck,
  Activity,
} from "lucide-react";
import { AuthGate } from "@/components/auth/auth-gate";
import { UserMenu } from "@/components/auth/user-menu";
import { WaitlistAdmin } from "@/components/auth/waitlist-admin";
import { OryxConsole } from "@/components/oryxx/oryx-console";
import { MarketSimulator } from "@/components/oryxx/market-simulator";
import { ExperimentLab } from "@/components/oryxx/experiment-lab";
import { RealLab } from "@/components/oryxx/real-lab";
import { CapacityLab } from "@/components/oryxx/capacity-lab";
import { WillingnessLab } from "@/components/oryxx/willingness-lab";
import { ProviderResearchUI } from "@/components/oryxx/provider-research-ui";
import { ResearchOperatorDashboard } from "@/components/oryxx/research-operator-dashboard";
import { MarketplaceConsole } from "@/components/oryxx/marketplace-console";
import { LiveSupplyLab } from "@/components/oryxx/live-supply-lab";
import { RealRoutes } from "@/components/oryxx/real-routes";
import { SystemHealth } from "@/components/oryxx/system-health";

type View =
  | "routes"        // PRODUCT: real-network routing (SLICE 1)
  | "solver"        // PRODUCT: synthetic intent solver (legacy, deterministic)
  | "marketplace"   // PRODUCT: live marketplace spine
  | "health"        // PRODUCT: operator system health
  | "market"        // RESEARCH/LABS
  | "experiment"
  | "real"
  | "capacity"
  | "willingness"
  | "participant"
  | "operator"
  | "live-supply";

export default function Home() {
  const { data: session, status } = useSession();
  const [authOpen, setAuthOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [view, setView] = useState<View>("routes");

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
          {/* View switcher — separated into PRODUCT and RESEARCH/LABS */}
          <div className="mx-auto w-full max-w-6xl px-4 pt-4">
            <div className="space-y-2">
              <div>
                <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-500">Product</div>
                <div className="inline-flex flex-wrap rounded-lg border bg-muted/30 p-0.5">
                  <TabButton view={view} setView={setView} id="routes" icon={Navigation} label="Routes (Real Network)" />
                  <TabButton view={view} setView={setView} id="solver" icon={Navigation} label="Intent Solver" />
                  <TabButton view={view} setView={setView} id="marketplace" icon={Activity} label="Marketplace" />
                  <TabButton view={view} setView={setView} id="health" icon={ShieldCheck} label="System Health" />
                </div>
              </div>
              <div>
                <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">Research / Labs (frozen — science paused)</div>
                <div className="inline-flex flex-wrap rounded-lg border bg-muted/20 p-0.5">
                  <TabButton view={view} setView={setView} id="market" icon={FlaskConical} label="Market Simulator" />
                  <TabButton view={view} setView={setView} id="experiment" icon={Beaker} label="Experiment Lab" />
                  <TabButton view={view} setView={setView} id="real" icon={Globe} label="Real-World Lab" />
                  <TabButton view={view} setView={setView} id="capacity" icon={Layers} label="Capacity Evidence" />
                  <TabButton view={view} setView={setView} id="willingness" icon={Filter} label="Willingness Lab" />
                  <TabButton view={view} setView={setView} id="participant" icon={UserCheck} label="Research Participant" />
                  {isAdmin && (
                    <TabButton view={view} setView={setView} id="operator" icon={ShieldCheck} label="Operator Dashboard" />
                  )}
                  <TabButton view={view} setView={setView} id="live-supply" icon={Globe} label="Live Supply Lab" />
                </div>
              </div>
            </div>
          </div>
          <ViewRenderer view={view} />
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
            Production build · REAL OSM/OSRM/GTFS routing · OBSERVED_ONLY Citi Bike · sandbox marketplace · frozen research layer
          </span>
        </div>
      </footer>

      <AuthGate open={authOpen} onClose={() => setAuthOpen(false)} />
    </div>
  );
}

function TabButton({
  view,
  setView,
  id,
  icon: Icon,
  label,
}: {
  view: View;
  setView: (v: View) => void;
  id: View;
  icon: any;
  label: string;
}) {
  return (
    <button
      onClick={() => setView(id)}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
        view === id ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}

function ViewRenderer({ view }: { view: View }) {
  const wrap = (children: React.ReactNode, max = "max-w-6xl") => (
    <div className={`mx-auto w-full ${max} px-4 py-6`}>{children}</div>
  );
  switch (view) {
    case "routes":
      return <div className="mx-auto w-full max-w-6xl px-4 py-6"><RealRoutes /></div>;
    case "solver":
      return <OryxConsole />;
    case "marketplace":
      return wrap(<MarketplaceConsole />);
    case "health":
      return wrap(<SystemHealth />);
    case "market":
      return wrap(<MarketSimulator />);
    case "experiment":
      return wrap(<ExperimentLab />);
    case "real":
      return wrap(<RealLab />);
    case "capacity":
      return wrap(<CapacityLab />);
    case "willingness":
      return wrap(<WillingnessLab />);
    case "participant":
      return wrap(<ProviderResearchUI />, "max-w-3xl");
    case "operator":
      return wrap(<ResearchOperatorDashboard />);
    case "live-supply":
      return wrap(<LiveSupplyLab />);
    default:
      return wrap(<RealRoutes />);
  }
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
