"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Navigation,
  Loader2,
  LogIn,
  UserPlus,
  ShieldCheck,
  Users,
  Car,
  Truck,
  Ship,
  X,
} from "lucide-react";

type Mode = "login" | "signup";

const DEMO_ACCOUNTS = [
  { email: "demo.rider@oryxx.app", role: "Rider", icon: Users, color: "text-sky-600" },
  { email: "demo.driver@oryxx.app", role: "Driver", icon: Car, color: "text-amber-600" },
  { email: "demo.shipper@oryxx.app", role: "Shipper", icon: Ship, color: "text-teal-600" },
  { email: "demo.fleet@oryxx.app", role: "Fleet Manager", icon: Truck, color: "text-violet-600" },
];

export function AuthGate({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [requestedRole, setRequestedRole] = useState("user");
  const [loading, setLoading] = useState<"login" | "signup" | "demo" | null>(null);

  const handleLogin = async () => {
    if (!email || !password) return;
    setLoading("login");
    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
    setLoading(null);
    if (res?.error) {
      toast({ title: "Login failed", description: "Check your email and password.", variant: "destructive" });
      return;
    }
    toast({ title: "Welcome back", description: "You're signed in to ORYXX." });
    onClose();
  };

  const handleSignup = async () => {
    if (!email) {
      toast({ title: "Email required", description: "Enter your email to join the waitlist.", variant: "destructive" });
      return;
    }
    setLoading("signup");
    try {
      const r = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, role: requestedRole }),
      });
      const j = await r.json();
      setLoading(null);
      if (!r.ok) {
        toast({ title: "Could not join waitlist", description: j.error ?? "Try again.", variant: "destructive" });
        return;
      }
      toast({
        title: "You're on the waitlist",
        description: "An admin will create your account. You'll get access when approved.",
      });
      setMode("login");
    } catch (e) {
      setLoading(null);
      toast({ title: "Network error", description: "Try again.", variant: "destructive" });
    }
  };

  const handleDemo = async (demoEmail: string) => {
    setLoading("demo");
    const res = await signIn("credentials", {
      email: demoEmail,
      password: "oryxx-demo", // demo accounts share this password (seeded)
      redirect: false,
    });
    setLoading(null);
    if (res?.error) {
      toast({ title: "Demo login failed", description: "The demo account may not be provisioned yet.", variant: "destructive" });
      return;
    }
    toast({ title: "Demo session started", description: `Signed in as ${demoEmail}.` });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto p-0 sm:max-w-md">
        <DialogHeader className="px-5 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-600 text-white">
              <Navigation className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-base">Sign in to ORYXX</DialogTitle>
              <DialogDescription className="text-xs">
                Transportation operating system & market
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="px-5 pb-5">
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="login" className="text-xs">
                <LogIn className="mr-1.5 h-3.5 w-3.5" /> Sign in
              </TabsTrigger>
              <TabsTrigger value="signup" className="text-xs">
                <UserPlus className="mr-1.5 h-3.5 w-3.5" /> Join waitlist
              </TabsTrigger>
            </TabsList>

            {/* LOGIN */}
            <TabsContent value="login" className="mt-4 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="login-email" className="text-xs text-muted-foreground">Email</Label>
                <Input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="login-password" className="text-xs text-muted-foreground">Password</Label>
                <Input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                />
              </div>
              <Button
                onClick={handleLogin}
                disabled={loading === "login"}
                className="w-full bg-emerald-600 hover:bg-emerald-700"
              >
                {loading === "login" ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Signing in…</>
                ) : (
                  <><LogIn className="mr-2 h-4 w-4" /> Sign in</>
                )}
              </Button>
            </TabsContent>

            {/* SIGNUP → waitlist */}
            <TabsContent value="signup" className="mt-4 space-y-3">
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">
                <ShieldCheck className="mr-1 inline h-3.5 w-3.5" />
                ORYXX is in a controlled rollout. Signing up adds you to the waitlist — an admin
                creates your account when approving access.
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="su-email" className="text-xs text-muted-foreground">Email</Label>
                <Input
                  id="su-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="su-name" className="text-xs text-muted-foreground">Name (optional)</Label>
                <Input
                  id="su-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="su-role" className="text-xs text-muted-foreground">Requested role</Label>
                <select
                  id="su-role"
                  value={requestedRole}
                  onChange={(e) => setRequestedRole(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="user">User / Rider</option>
                  <option value="demo-driver">Driver</option>
                  <option value="demo-shipper">Shipper</option>
                  <option value="demo-fleet">Fleet manager</option>
                </select>
              </div>
              <Button
                onClick={handleSignup}
                disabled={loading === "signup"}
                className="w-full bg-emerald-600 hover:bg-emerald-700"
              >
                {loading === "signup" ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Joining…</>
                ) : (
                  <><UserPlus className="mr-2 h-4 w-4" /> Join the waitlist</>
                )}
              </Button>
            </TabsContent>
          </Tabs>

          <div className="relative my-4">
            <Separator />
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-[10px] uppercase tracking-wide text-muted-foreground">
              or quick demo login
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {DEMO_ACCOUNTS.map((d) => (
              <button
                key={d.email}
                onClick={() => handleDemo(d.email)}
                disabled={loading !== null}
                className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2.5 text-left transition hover:bg-muted hover:shadow-sm disabled:opacity-50"
              >
                <d.icon className={`h-4 w-4 ${d.color}`} />
                <div className="min-w-0">
                  <p className="text-xs font-medium leading-tight">{d.role}</p>
                  <p className="truncate text-[10px] text-muted-foreground">demo · instant</p>
                </div>
              </button>
            ))}
          </div>

          <p className="mt-3 text-center text-[10px] text-muted-foreground">
            By continuing you agree that ORYXX may process transportation intents on your behalf
            within your selected autonomy level.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
