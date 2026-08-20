"use client";

// ORYXX — Provider Research Participant UI
//
// This component is shown to verified research participants (transportation
// providers enrolled in the W3-R pilot). It is explicitly framed as a
// RESEARCH STUDY — NOT an ORYXX marketplace booking.
//
// Provider journey:
//   INVITED → ACCOUNT CREATED → IDENTITY VERIFIED → EXPERIMENT ENROLLED
//   → CONSENTED → ELIGIBLE → OFFERED → DECISION → COMPLETION
//
// State recovery:
//   On mount and on experiment selection, the UI calls mode=get_enrollment
//   to recover the participant's enrollment, consent, and current offer
//   from the session. This survives page refresh, browser reopen, and
//   sign-out/sign-in. Identity is derived from the authenticated session
//   (server-side) — the client never supplies identity.
//
// Stale-state fix:
//   createOffer() and transition() use the response object/id returned by
//   the API directly (not React closure state) for dependent transitions.
//   After each successful transition, React state is updated with the
//   returned response.

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import {
  AlertCircle, ShieldCheck, Clock, MapPin, DollarSign, Bell, CheckCircle2,
  XCircle, HelpCircle, Loader2, FileText, UserCheck, LogOut,
} from "lucide-react";

interface ExperimentInfo {
  id: string;
  name: string;
  status: string;
  hypothesis: string | null;
  consentText: string | null;
  consentVersion: number;
  preregistrationHash: string | null;
}

interface Enrollment {
  id: string;
  experimentId: string;
  participantId: string;
  enrollmentToken: string;
  providerVerified: string;
  assignedCellId: string | null;
  status: string;
  withdrawnAt: string | null;
}

interface OfferResponse {
  id: string;
  treatmentCellId: string;
  compensation: number;
  detourKm: number;
  extraTimeMin: number;
  advanceNoticeMin: number;
  passengerCount: number;
  tripDistanceKm: number;
  originName: string;
  destName: string;
  hourOfDay: number;
  state: string;
  decision: string | null;
  evidenceTier: string;
  offerPresentedAt: string | null;
  offerExpiresAt: string | null;
  providerViewedAt: string | null;
}

interface RecoveredState {
  enrolled: boolean;
  enrollment?: Enrollment;
  experiment?: ExperimentInfo & { requiresConsent: boolean; maxDetourKm: number; maxExtraTimeMin: number; minCompensation: number };
  consented: boolean;
  consent?: { consentVersion: number; consentedAt: string; withdrawnAt: string | null } | null;
  response?: OfferResponse | null;
}

export function ProviderResearchUI() {
  const { toast } = useToast();
  const [experiments, setExperiments] = useState<ExperimentInfo[]>([]);
  const [selectedExpId, setSelectedExpId] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [consented, setConsented] = useState<boolean>(false);
  const [offer, setOffer] = useState<OfferResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchExperiments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/oryxx/willingness/experiment", { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const activeExps = (data.experiments || []).filter((e: any) => e.status === "ACTIVE");
      setExperiments(activeExps);
    } catch (e) {
      toast({ title: "Failed to load experiments", description: String(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchExperiments(); }, [fetchExperiments]);

  // Recover enrollment/consent/offer from the session-bound endpoint.
  // Identity is derived from the authenticated session server-side.
  // This survives page refresh, browser reopen, sign-out/sign-in.
  const recoverState = useCallback(async (expId: string) => {
    setLoading(true);
    try {
      const res = await fetch("/api/oryxx/willingness/experiment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "get_enrollment", experimentId: expId }),
      });
      if (!res.ok) {
        setEnrollment(null);
        setConsented(false);
        setOffer(null);
        return;
      }
      const data: RecoveredState = await res.json();
      if (data.enrolled && data.enrollment) {
        setEnrollment(data.enrollment);
        setConsented(data.consented);
        setOffer(data.response ?? null);
      } else {
        setEnrollment(null);
        setConsented(false);
        setOffer(null);
      }
    } catch {
      setEnrollment(null);
      setConsented(false);
      setOffer(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const selectExperiment = (expId: string) => {
    setSelectedExpId(expId);
    recoverState(expId);
  };

  const enroll = async () => {
    if (!selectedExpId) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/oryxx/willingness/experiment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "enroll", experimentId: selectedExpId }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          toast({ title: "Already enrolled", description: data.error, variant: "default" });
          // Recover the existing enrollment
          await recoverState(selectedExpId);
        } else {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
      } else {
        setEnrollment(data.enrollment);
        toast({ title: "Enrolled", description: "You are now enrolled in the research study." });
      }
    } catch (e) {
      toast({ title: "Enrollment failed", description: String(e), variant: "destructive" });
    } finally {
      setActionLoading(false);
    }
  };

  const giveConsent = async () => {
    if (!enrollment) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/oryxx/willingness/experiment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "consent", enrollmentToken: enrollment.enrollmentToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setConsented(true);
      toast({ title: "Consent recorded", description: "You may now view research offers." });
    } catch (e) {
      toast({ title: "Consent failed", description: String(e), variant: "destructive" });
    } finally {
      setActionLoading(false);
    }
  };

  // FIXED: createOffer uses the returned response object directly for
  // dependent transitions — does NOT read React `offer` closure state.
  // After each transition, React state is updated with the returned
  // response object.
  const createOffer = async () => {
    if (!enrollment) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/oryxx/willingness/experiment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "create_offer", enrollmentToken: enrollment.enrollmentToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const newOffer: OfferResponse = data.response;
      setOffer(newOffer);
      // Use the returned response ID directly (not closure state) for transitions.
      // Chain: OFFER_CREATED → OFFER_PRESENTED → PROVIDER_VIEWED.
      // The accept button only appears when state === PROVIDER_VIEWED.
      const presented = await transitionWith(newOffer.id, "OFFER_PRESENTED", newOffer);
      if (presented) {
        await transitionWith(newOffer.id, "PROVIDER_VIEWED", presented);
      }
    } catch (e) {
      toast({ title: "Offer creation failed", description: String(e), variant: "destructive" });
    } finally {
      setActionLoading(false);
    }
  };

  // FIXED: transitionWith accepts responseId explicitly (not from closure).
  // After a successful transition, updates React state with the response.
  const transitionWith = async (responseId: string, newState: string, currentOffer: OfferResponse | null, acceptDecline?: string) => {
    if (!enrollment) return null;
    try {
      const res = await fetch("/api/oryxx/willingness/experiment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "transition",
          enrollmentToken: enrollment.enrollmentToken,
          responseId,
          newState,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const updated: OfferResponse = { ...(currentOffer ?? offer)!, state: newState } as OfferResponse;
      setOffer(updated);
      if (newState === "PROVIDER_ACCEPTED") {
        toast({ title: "Decision recorded", description: "You ACCEPTED the research offer. W3-R evidence recorded." });
      } else if (newState === "PROVIDER_DECLINED") {
        toast({ title: "Decision recorded", description: "You DECLINED the research offer." });
      } else if (newState === "PROVIDER_UNAVAILABLE") {
        toast({ title: "Decision recorded", description: "You marked yourself NOT AVAILABLE." });
      }
      return updated;
    } catch (e) {
      toast({ title: "Transition failed", description: String(e), variant: "destructive" });
      return null;
    }
  };

  // User-facing transition (for ACCEPT/DECLINE/NOT AVAILABLE buttons).
  // Uses the current offer from state — but passes the responseId explicitly.
  const decide = async (newState: string) => {
    if (!offer) return;
    await transitionWith(offer.id, newState, offer);
  };

  const withdraw = async () => {
    if (!enrollment) return;
    if (!confirm("Are you sure you want to withdraw from the research study? Historical data will be retained.")) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/oryxx/willingness/experiment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "withdraw", enrollmentToken: enrollment.enrollmentToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setEnrollment({ ...enrollment, status: "withdrawn" });
      toast({ title: "Withdrawn", description: "You have withdrawn from the study. No new offers will be shown." });
    } catch (e) {
      toast({ title: "Withdrawal failed", description: String(e), variant: "destructive" });
    } finally {
      setActionLoading(false);
    }
  };

  const selectedExp = experiments.find((e) => e.id === selectedExpId);
  const offerExpired = offer?.offerExpiresAt ? new Date(offer.offerExpiresAt).getTime() < Date.now() : false;
  const canDecide = offer && ["PROVIDER_VIEWED"].includes(offer.state) && !offerExpired && enrollment?.status === "active";

  return (
    <div className="space-y-4" data-testid="provider-research-ui">
      {/* RESEARCH STUDY FRAMING — always visible */}
      <Card className="p-4 border-amber-300 bg-amber-50 dark:bg-amber-950/20" data-testid="research-disclaimer">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="space-y-1">
            <h3 className="font-semibold text-amber-900 dark:text-amber-200">RESEARCH STUDY</h3>
            <p className="text-sm text-amber-800 dark:text-amber-300">
              This is a research study about transportation provider willingness. This is NOT an ORYXX marketplace booking.
              Your responses are pseudonymous. You may withdraw at any time.
            </p>
          </div>
        </div>
      </Card>

      {/* Step 1: Select experiment */}
      {!selectedExpId && (
        <Card className="p-6" data-testid="experiment-list">
          <h2 className="text-lg font-semibold mb-3">Active Research Studies</h2>
          {loading ? (
            <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading...</div>
          ) : experiments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active research studies available. Check back later or contact the research operator.</p>
          ) : (
            <div className="space-y-2">
              {experiments.map((exp) => (
                <button
                  key={exp.id}
                  onClick={() => selectExperiment(exp.id)}
                  className="w-full text-left p-3 rounded-lg border hover:bg-accent transition-colors"
                  data-testid={`experiment-${exp.id}`}
                >
                  <div className="font-medium">{exp.name}</div>
                  <div className="text-xs text-muted-foreground mt-1">Hypothesis: {exp.hypothesis}</div>
                  <div className="flex gap-2 mt-2">
                    <Badge variant="secondary">{exp.status}</Badge>
                    <Badge variant="outline">Consent v{exp.consentVersion}</Badge>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Loading state during recovery */}
      {selectedExpId && loading && (
        <Card className="p-6">
          <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Recovering your enrollment...</div>
        </Card>
      )}

      {/* Step 2: Enrollment + Consent (only if not enrolled) */}
      {selectedExpId && !loading && !enrollment && (
        <Card className="p-6 space-y-4" data-testid="enroll-section">
          <div>
            <h2 className="text-lg font-semibold">{selectedExp?.name}</h2>
            <p className="text-sm text-muted-foreground mt-1">{selectedExp?.hypothesis}</p>
          </div>
          <Button onClick={enroll} disabled={actionLoading} data-testid="enroll-button">
            {actionLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <UserCheck className="h-4 w-4 mr-2" />}
            Enroll in Research Study
          </Button>
          <Button variant="ghost" onClick={() => setSelectedExpId(null)}>Back to studies</Button>
        </Card>
      )}

      {/* Step 3: Consent (only if enrolled but not consented) */}
      {enrollment && !consented && enrollment.status === "active" && (
        <Card className="p-6 space-y-4" data-testid="consent-section">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            <h2 className="text-lg font-semibold">Informed Consent</h2>
          </div>
          <ScrollArea className="h-48 rounded border p-4 bg-muted/50">
            <pre className="text-sm whitespace-pre-wrap font-sans">{selectedExp?.consentText}</pre>
          </ScrollArea>
          <div className="text-xs text-muted-foreground space-y-1">
            <p>• Study purpose: research on provider willingness to accept pooled-trip offers.</p>
            <p>• What is collected: pseudonymous responses, decision, timestamps. No PII beyond your account email.</p>
            <p>• Compensation: research stimulus only — no payment, wallet, or billing.</p>
            <p>• Withdrawal: you may withdraw at any time. Historical data is retained for research integrity.</p>
            <p>• Data retention: indefinite (pseudonymous). Contact the research operator to withdraw.</p>
            <p>• Safety limits: detour ≤ {selectedExp ? "5km" : "?"}, extra time ≤ {selectedExp ? "20min" : "?"}, min compensation ${selectedExp ? "1" : "?"}.</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={giveConsent} disabled={actionLoading} data-testid="consent-button">
              {actionLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
              I Consent
            </Button>
          </div>
        </Card>
      )}

      {/* Consent already recorded (recovered) */}
      {enrollment && consented && enrollment.status === "active" && (
        <Card className="p-3 border-green-300 bg-green-50 dark:bg-green-950/20" data-testid="consent-recorded">
          <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4" />
            <span>Consent recorded. You may view research offers.</span>
          </div>
        </Card>
      )}

      {/* Step 4: Verification check */}
      {enrollment && enrollment.providerVerified !== "operator_verified" && enrollment.status === "active" && (
        <Card className="p-4 border-blue-300 bg-blue-50 dark:bg-blue-950/20" data-testid="verification-pending">
          <div className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-blue-600" />
            <span>Provider verification pending. The research operator must verify your identity before offers are shown.</span>
          </div>
          <div className="text-xs text-muted-foreground mt-1">Verification level: <Badge variant="outline">{enrollment.providerVerified}</Badge></div>
        </Card>
      )}

      {/* Verified badge */}
      {enrollment && enrollment.providerVerified === "operator_verified" && enrollment.status === "active" && (
        <Card className="p-3 border-green-300 bg-green-50 dark:bg-green-950/20">
          <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
            <ShieldCheck className="h-4 w-4" />
            <span>Provider verified (operator_verified)</span>
          </div>
        </Card>
      )}

      {/* Step 5: Offer */}
      {enrollment && consented && enrollment.providerVerified === "operator_verified" && enrollment.status === "active" && (
        <AnimatePresence mode="wait">
          {!offer ? (
            <motion.div key="create" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Card className="p-6">
                <Button onClick={createOffer} disabled={actionLoading} className="w-full" data-testid="create-offer-button">
                  {actionLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Bell className="h-4 w-4 mr-2" />}
                  View Research Offer
                </Button>
              </Card>
            </motion.div>
          ) : (
            <motion.div key="offer" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <Card className="p-6 space-y-4" data-testid="offer-card">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Research Offer</h2>
                  {offerExpired && <Badge variant="destructive">EXPIRED</Badge>}
                </div>

                {/* Current scenario */}
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-muted-foreground">Current Transportation Scenario</h3>
                  <div className="flex items-center gap-2 text-sm">
                    <MapPin className="h-4 w-4" />
                    <span>{offer.originName} → {offer.destName}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Clock className="h-4 w-4" />
                    <span>Hour: {offer.hourOfDay}:00 · Distance: {offer.tripDistanceKm}km · Passengers: {offer.passengerCount}</span>
                  </div>
                </div>

                <Separator />

                {/* Additional request */}
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-muted-foreground">Additional Transportation Request</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-center gap-2 p-2 rounded border">
                      <DollarSign className="h-4 w-4 text-green-600" />
                      <div>
                        <div className="text-xs text-muted-foreground">Compensation</div>
                        <div className="font-semibold" data-testid="offer-compensation">${offer.compensation.toFixed(2)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 p-2 rounded border">
                      <MapPin className="h-4 w-4 text-orange-600" />
                      <div>
                        <div className="text-xs text-muted-foreground">Additional Distance</div>
                        <div className="font-semibold" data-testid="offer-detour">{offer.detourKm} km</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 p-2 rounded border">
                      <Clock className="h-4 w-4 text-blue-600" />
                      <div>
                        <div className="text-xs text-muted-foreground">Additional Time</div>
                        <div className="font-semibold">{offer.extraTimeMin} min</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 p-2 rounded border">
                      <Bell className="h-4 w-4 text-purple-600" />
                      <div>
                        <div className="text-xs text-muted-foreground">Notice</div>
                        <div className="font-semibold">{offer.advanceNoticeMin} min</div>
                      </div>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Offer expiry */}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Offer expires:</span>
                  <span className={offerExpired ? "text-red-600 font-medium" : "font-medium"}>
                    {offer.offerExpiresAt ? new Date(offer.offerExpiresAt).toLocaleString() : "—"}
                  </span>
                </div>

                {/* Decision buttons */}
                {canDecide ? (
                  <div className="grid grid-cols-3 gap-2">
                    <Button
                      onClick={() => decide("PROVIDER_ACCEPTED")}
                      disabled={actionLoading}
                      className="bg-green-600 hover:bg-green-700"
                      data-testid="accept-button"
                    >
                      <CheckCircle2 className="h-4 w-4 mr-2" /> ACCEPT
                    </Button>
                    <Button
                      onClick={() => decide("PROVIDER_DECLINED")}
                      disabled={actionLoading}
                      variant="destructive"
                      data-testid="decline-button"
                    >
                      <XCircle className="h-4 w-4 mr-2" /> DECLINE
                    </Button>
                    <Button
                      onClick={() => decide("PROVIDER_UNAVAILABLE")}
                      disabled={actionLoading}
                      variant="secondary"
                      data-testid="unavailable-button"
                    >
                      <HelpCircle className="h-4 w-4 mr-2" /> NOT AVAILABLE
                    </Button>
                  </div>
                ) : (
                  <div className="text-center text-sm text-muted-foreground" data-testid="offer-state">
                    {offerExpired ? "Offer expired — marked as PROVIDER_IGNORED." :
                     offer.state === "OFFER_CREATED" ? "Offer created." :
                     offer.state === "OFFER_PRESENTED" ? "Offer presented." :
                     offer.state === "PROVIDER_ACCEPTED" ? "You accepted this offer. Thank you for participating." :
                     offer.state === "PROVIDER_DECLINED" ? "You declined this offer." :
                     offer.state === "PROVIDER_UNAVAILABLE" ? "You marked yourself not available." :
                     offer.state === "PROVIDER_IGNORED" ? "Offer expired (ignored)." :
                     offer.state === "TRIP_STARTED" ? "Research interaction in progress." :
                     offer.state === "TRIP_COMPLETED" ? "Research interaction completed. W4-R recorded." :
                     offer.state === "TRIP_CANCELLED" ? "Research interaction cancelled." :
                     `State: ${offer.state}`}
                  </div>
                )}
              </Card>
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {/* Withdrawal */}
      {enrollment && enrollment.status === "active" && (
        <Card className="p-4">
          <Button onClick={withdraw} variant="ghost" size="sm" disabled={actionLoading} data-testid="withdraw-button">
            <LogOut className="h-4 w-4 mr-2" /> Withdraw from Study
          </Button>
        </Card>
      )}

      {enrollment && enrollment.status === "withdrawn" && (
        <Card className="p-4 border-muted" data-testid="withdrawn-state">
          <p className="text-sm text-muted-foreground text-center">
            You have withdrawn from this study. Historical data is retained for research integrity. No new offers will be shown.
          </p>
        </Card>
      )}
    </div>
  );
}
