"use client";

import { motion } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Clock3,
  GitBranch,
  Users,
  CalendarClock,
  Search,
  ArrowDownRight,
  ArrowUpRight,
} from "lucide-react";
import type { FlexibilityOffer } from "@/lib/oryxx/types";

const KIND_ICON = {
  shift_time: Clock3,
  allow_transfer: GitBranch,
  share_ride: Users,
  book_earlier: CalendarClock,
  wait_watch: Search,
} as const;

const KIND_LABEL = {
  shift_time: "Shift time",
  allow_transfer: "Add transfer",
  share_ride: "Share ride",
  book_earlier: "Book earlier",
  wait_watch: "Watch & wait",
} as const;

export function FlexibilityOffers({
  offers,
  onApply,
  appliedId,
}: {
  offers: FlexibilityOffer[];
  onApply: (offer: FlexibilityOffer) => void;
  appliedId?: string | null;
}) {
  if (offers.length === 0) return null;
  return (
    <Card className="py-0">
      <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Clock3 className="h-4 w-4 text-emerald-600" />
          <span className="text-sm font-semibold">
            Flexibility offers — time is an optimization variable
          </span>
        </div>
        <Badge variant="outline" className="text-[10px] text-muted-foreground">
          {offers.length} options
        </Badge>
      </div>
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
        {offers.map((o, i) => {
          const Icon = KIND_ICON[o.kind];
          const applied = appliedId === o.id;
          return (
            <motion.div
              key={o.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: i * 0.03 }}
            >
              <div
                className={`flex h-full flex-col justify-between gap-2 rounded-lg border p-3 transition ${
                  applied
                    ? "border-emerald-500 bg-emerald-500/10"
                    : "border-border bg-muted/20 hover:bg-muted/40"
                }`}
              >
                <div className="flex items-start gap-2">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-emerald-600/10 text-emerald-700 dark:text-emerald-300">
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium leading-snug">{o.title}</p>
                    <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                      {o.rationale}
                    </p>
                  </div>
                  <div className="flex flex-col items-end">
                    {o.deltaCost < 0 ? (
                      <span className="flex items-center gap-0.5 text-xs font-semibold text-emerald-600">
                        <ArrowDownRight className="h-3 w-3" />
                        {`$${Math.abs(o.deltaCost).toFixed(2)}`}
                      </span>
                    ) : (
                      <span className="flex items-center gap-0.5 text-xs font-semibold text-rose-600">
                        <ArrowUpRight className="h-3 w-3" />${o.deltaCost.toFixed(2)}
                      </span>
                    )}
                    {o.deltaEtaMin !== 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        {o.deltaEtaMin > 0 ? `+${o.deltaEtaMin}m` : `${o.deltaEtaMin}m`}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="text-[9px] uppercase">
                    {KIND_LABEL[o.kind]}
                  </Badge>
                  <Button
                    size="sm"
                    variant={applied ? "default" : "outline"}
                    onClick={() => onApply(o)}
                    disabled={applied}
                    className={`h-7 text-[11px] ${
                      applied ? "bg-emerald-600 hover:bg-emerald-700" : ""
                    }`}
                  >
                    {applied ? "Applied" : "Apply"}
                  </Button>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </Card>
  );
}
