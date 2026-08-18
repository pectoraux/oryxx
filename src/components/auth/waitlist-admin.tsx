"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import {
  ClipboardList,
  Check,
  X,
  RefreshCw,
  Loader2,
  Mail,
  Clock,
  KeyRound,
} from "lucide-react";

interface WaitlistEntry {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  createdAt: string;
}

export function WaitlistAdmin() {
  const { toast } = useToast();
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">("pending");
  const [acting, setActing] = useState<string | null>(null);
  const [issuedPwd, setIssuedPwd] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/waitlist?status=${filter}`);
      const j = await r.json();
      if (r.ok) setEntries(j.entries ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [filter]);

  const approve = async (id: string, withPassword?: string) => {
    setActing(id);
    try {
      const r = await fetch("/api/waitlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "approve", password: withPassword || undefined }),
      });
      const j = await r.json();
      if (!r.ok) {
        toast({ title: "Approval failed", description: j.error, variant: "destructive" });
        return;
      }
      if (j.tempPassword) {
        setIssuedPwd((p) => ({ ...p, [id]: j.tempPassword }));
        toast({
          title: "Account created",
          description: `Temp password issued: ${j.tempPassword} — share it securely with ${j.email}.`,
        });
      } else {
        toast({ title: "Account created", description: `${j.email} can now sign in.` });
      }
      load();
    } finally {
      setActing(null);
    }
  };

  const reject = async (id: string) => {
    setActing(id);
    try {
      const r = await fetch("/api/waitlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action: "reject" }),
      });
      if (r.ok) {
        toast({ title: "Entry rejected" });
        load();
      }
    } finally {
      setActing(null);
    }
  };

  return (
    <Card className="py-0">
      <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-emerald-600" />
          <span className="text-sm font-semibold">Waitlist management</span>
          <Badge variant="outline" className="text-[10px]">admin</Badge>
        </div>
        <div className="flex items-center gap-1">
          {(["pending", "approved", "rejected", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded px-2 py-1 text-[11px] capitalize transition ${
                filter === f ? "bg-emerald-600 text-white" : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {f}
            </button>
          ))}
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      <ScrollArea className="max-h-80 w-full">
        <div className="p-2">
          {entries.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center text-center text-[11px] text-muted-foreground">
              <ClipboardList className="mb-1 h-5 w-5 opacity-40" />
              No {filter} entries.
            </div>
          ) : (
            <div className="space-y-1.5">
              {entries.map((e) => (
                <motion.div
                  key={e.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col gap-2 rounded-md border bg-card p-2.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Mail className="h-3 w-3 text-muted-foreground" />
                      <span className="truncate text-sm font-medium">{e.email}</span>
                      <Badge
                        variant="outline"
                        className={
                          e.status === "pending"
                            ? "border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-300"
                            : e.status === "approved"
                            ? "border-emerald-500/40 text-[10px] text-emerald-700 dark:text-emerald-300"
                            : "border-rose-500/40 text-[10px] text-rose-700 dark:text-rose-300"
                        }
                      >
                        {e.status}
                      </Badge>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                      {e.name && <span>{e.name}</span>}
                      <span className="capitalize">· {e.role.replace("demo-", "")}</span>
                      <span>· <Clock className="inline h-2.5 w-2.5" /> {new Date(e.createdAt).toLocaleDateString()}</span>
                    </div>
                    {issuedPwd[e.id] && (
                      <div className="mt-1 flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                        <KeyRound className="h-2.5 w-2.5" />
                        temp password: <code className="font-mono">{issuedPwd[e.id]}</code>
                      </div>
                    )}
                  </div>
                  {e.status === "pending" && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 border-rose-500/30 text-[11px] text-rose-600 hover:bg-rose-500/10"
                        onClick={() => reject(e.id)}
                        disabled={acting === e.id}
                      >
                        {acting === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 bg-emerald-600 text-[11px] hover:bg-emerald-700"
                        onClick={() => approve(e.id)}
                        disabled={acting === e.id}
                      >
                        {acting === e.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        Approve & create account
                      </Button>
                    </div>
                  )}
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </Card>
  );
}
