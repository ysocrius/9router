"use client";

import { useState, useEffect } from "react";
import Card from "@/shared/components/Card";
import Badge from "@/shared/components/Badge";

/** Color-coded horizontal progress bar */
function ProgressBar({ value, max }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const colorClass = pct >= 80 ? "bg-error" : pct >= 50 ? "bg-warning" : "bg-success";
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-1 h-1.5 rounded-full bg-bg-subtle overflow-hidden min-w-[80px]">
        <div
          className={`h-full rounded-full transition-all duration-300 ${colorClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-text-muted whitespace-nowrap shrink-0 tabular-nums">
        {value.toLocaleString()} / {max.toLocaleString()}
      </span>
    </div>
  );
}

/** Renders "Xd Yh" countdown to resetAt */
function ResetCountdown({ resetAt }) {
  if (!resetAt) return <span className="text-text-muted text-xs">—</span>;
  const ms = new Date(resetAt) - Date.now();
  if (ms <= 0) return <span className="text-xs text-success font-medium">Resetting…</span>;
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  return (
    <span className="text-xs text-text-muted whitespace-nowrap tabular-nums">
      {days > 0 ? `${days}d ` : ""}{hours}h
    </span>
  );
}

/**
 * Pivot table showing per-API-key usage for the current Kiro billing cycle.
 * Data is fetched from GET /api/usage/monthly and refreshed every 60 seconds.
 */
export default function UserMonthTable() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/usage/monthly");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) { setData(json); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center py-12 text-text-muted">
      <span className="material-symbols-outlined text-[32px] animate-spin">progress_activity</span>
    </div>
  );

  if (error) return (
    <Card padding="md">
      <p className="text-sm text-error">Failed to load billing cycle data: {error}</p>
    </Card>
  );

  if (!data?.users?.length) return (
    <Card padding="md">
      <p className="text-sm text-text-muted">
        No seat-bound API keys found.{" "}
        Bind a key to a Kiro seat on the <strong>Endpoint</strong> page to start tracking usage here.
      </p>
    </Card>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Cycle header */}
      {data.cycle && (
        <div className="flex items-center gap-1.5 text-xs text-text-muted">
          <span className="material-symbols-outlined text-[14px]">calendar_today</span>
          <span>
            Billing cycle resets{" "}
            <ResetCountdown resetAt={data.cycle.resetAt} />
            {" "}({new Date(data.cycle.resetAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })})
          </span>
        </div>
      )}

      {/* Table */}
      <Card padding="none" className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wide">Key</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wide">Seat</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wide">Mode</th>
              <th className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wide" style={{ minWidth: 200 }}>Usage This Cycle</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-text-muted uppercase tracking-wide">Requests</th>
              <th className="px-4 py-3 text-right text-xs font-semibold text-text-muted uppercase tracking-wide">Resets In</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {data.users.map((user) => {
              const resetAt = user.liveCredit?.resetAt || data.cycle?.resetAt;
              const usageValue = user.mode === "kiro-credit"
                ? (user.liveCredit?.used ?? 0)
                : (user.thisCycle?.requests ?? 0);

              return (
                <tr key={user.keyId} className="hover:bg-bg-subtle/50 transition-colors">
                  <td className="px-4 py-3">
                    <span className="font-medium text-text-main">{user.keyName}</span>
                  </td>
                  <td className="px-4 py-3 text-text-muted text-xs">{user.seatName}</td>
                  <td className="px-4 py-3">
                    <Badge variant={user.mode === "kiro-credit" ? "primary" : "neutral"} size="sm">
                      {user.mode === "kiro-credit" ? "Credit" : "Requests"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3" style={{ minWidth: 200 }}>
                    <ProgressBar value={usageValue} max={user.limit} />
                  </td>
                  <td className="px-4 py-3 text-right text-text-muted text-xs tabular-nums">
                    {(user.thisCycle?.requests ?? 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ResetCountdown resetAt={resetAt} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
