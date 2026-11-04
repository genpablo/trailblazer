"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ActivityTab } from "@/components/operator/ActivityTab";
import { BusinessesTab } from "@/components/operator/BusinessesTab";
import { OverviewTab } from "@/components/operator/OverviewTab";
import { PlansTab } from "@/components/operator/PlansTab";
import { PoliciesTab } from "@/components/operator/PoliciesTab";
import { ApiError, api, type Me } from "@/lib/api";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "businesses", label: "Businesses" },
  { id: "plans", label: "Plans" },
  { id: "policies", label: "Policies" },
  { id: "activity", label: "Activity" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/**
 * Operator console for Traiblazer staff: plans, platform policies, businesses and an audit
 * trail. Internal tool, so English only. Access is checked by the API (non-operators get 404).
 */
export default function OperatorPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied">("loading");
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    api<Me>("/v1/auth/me")
      .then((data) => {
        setMe(data);
        setState(data.user.isOperator ? "ready" : "denied");
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/login");
        else setState("denied");
      });
  }, [router]);

  if (state === "loading") return <p className="muted p-8">Loading…</p>;
  if (state === "denied") {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-3 px-4 py-12">
        <h1 className="text-xl font-semibold">Page not found</h1>
        <Link href="/dashboard" className="underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6" lang="en">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href="/dashboard" className="muted text-sm">
            ← Dashboard
          </Link>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            Operator console
            <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs font-medium">
              Staff only
            </span>
          </h1>
        </div>
        <span className="muted text-sm">Signed in as {me?.user.email}</span>
      </header>

      <div role="tablist" className="flex flex-wrap gap-1 border-b border-[var(--border)]">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? "border-[var(--accent)] font-medium" : "muted border-transparent"}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <section role="tabpanel">
        {tab === "overview" && <OverviewTab />}
        {tab === "businesses" && <BusinessesTab />}
        {tab === "plans" && <PlansTab />}
        {tab === "policies" && <PoliciesTab />}
        {tab === "activity" && <ActivityTab />}
      </section>
    </div>
  );
}
