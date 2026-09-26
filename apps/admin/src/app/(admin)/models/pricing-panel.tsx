"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessageForStatus, fetchAdminApi } from "../../../lib/admin-api";
import { useAdminSession } from "../admin-session";
import type { ModelView, PricingRuleView } from "../../../lib/types";
import { FormError, FormAlert } from "../form-alert";

const inputClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full";
const labelClassName = "text-sm font-medium text-zinc-900 dark:text-zinc-100";
const buttonClassName =
  "px-4 py-2 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 transition-colors";

export function PricingPanel({ model, history }: { model: ModelView; history: PricingRuleView[] }) {
  const router = useRouter();
  const { csrfToken } = useAdminSession();

  const [billingDimension, setBillingDimension] = useState("");
  const [price, setPrice] = useState("");
  const [unitSize, setUnitSize] = useState("1000000");
  const [currency, setCurrency] = useState("USD");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | string[] | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);

    try {
      const payload: Record<string, string> = {
        billingDimension: billingDimension.trim(),
        price: price.trim(),
        currency: currency.trim(),
      };
      if (unitSize.trim()) payload.unitSize = unitSize.trim();
      if (effectiveFrom.trim()) payload.effectiveFrom = new Date(effectiveFrom).toISOString();

      const res = await fetchAdminApi(`/models/${encodeURIComponent(model.id)}/pricing`, {
        method: "POST",
        csrfToken,
        body: payload,
      });

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }

      if (res.status !== 201) {
        let msg = "Failed to add pricing rule";
        try {
          const body = await res.json();
          msg = typeof errorMessageForStatus(res.status, body) === "string" ? errorMessageForStatus(res.status, body) as string : msg;
        } catch {}
        setError(msg);
        return;
      }

      setPrice("");
      setEffectiveFrom("");
      setSuccess("Pricing rule added.");
      router.refresh();
    } catch {
      setError("Something went wrong");
    } finally {
      setIsSubmitting(false);
    }
  };
  
  const handleShortcut = async () => {
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);
    let hasError = false;
    const msgs: string[] = [];

    const makeRequest = async (dim: string) => {
      const payload: Record<string, string> = {
        billingDimension: dim,
        price: price.trim(),
        currency: currency.trim(),
      };
      if (unitSize.trim()) payload.unitSize = unitSize.trim();
      if (effectiveFrom.trim()) payload.effectiveFrom = new Date(effectiveFrom).toISOString();

      const res = await fetchAdminApi(`/models/${encodeURIComponent(model.id)}/pricing`, {
        method: "POST",
        csrfToken,
        body: payload,
      });
      if (res.status !== 201) {
        hasError = true;
        try {
          const body = await res.json();
          msgs.push(`Failed for ${dim}: ${typeof errorMessageForStatus(res.status, body) === "string" ? errorMessageForStatus(res.status, body) : 'Error'}`);
        } catch {
          msgs.push(`Failed for ${dim}`);
        }
      }
    };

    await makeRequest("input_tokens");
    await makeRequest("output_tokens");
    
    if (hasError) {
      setError(msgs);
    } else {
      setPrice("");
      setEffectiveFrom("");
      setSuccess("Shortcut applied for input and output tokens.");
    }
    setIsSubmitting(false);
    router.refresh();
  };

  const handleDelete = async (ruleId: string) => {
    setError(null);
    setIsSubmitting(true);
    try {
      const res = await fetchAdminApi(`/models/${encodeURIComponent(model.id)}/pricing/${encodeURIComponent(ruleId)}`, {
        method: "DELETE",
        csrfToken,
      });
      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }
      setConfirmingDelete(null);
      router.refresh();
    } catch {
      setError("Something went wrong");
    } finally {
      setIsSubmitting(false);
    }
  };

  const now = new Date();

  return (
    <div className="bg-white dark:bg-zinc-900 p-6 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-8 max-w-4xl">
      <div>
        <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Current prices</h3>
        {model.currentPricing.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-left">
              <thead className="border-b border-zinc-200 dark:border-zinc-800">
                <tr className="text-zinc-500 dark:text-zinc-400">
                  <th className="px-3 py-2 font-medium">Dimension</th>
                  <th className="px-3 py-2 font-medium">Price</th>
                  <th className="px-3 py-2 font-medium">Unit</th>
                  <th className="px-3 py-2 font-medium">Currency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {model.currentPricing.map(p => (
                  <tr key={p.billingDimension}>
                    <td className="px-3 py-2 text-zinc-900 dark:text-zinc-100">{p.billingDimension}</td>
                    <td className="px-3 py-2 text-zinc-900 dark:text-zinc-100">{p.price}</td>
                    <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">per {p.unitSize}</td>
                    <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">{p.currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No active pricing rules.</p>
        )}
      </div>

      <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
        <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4">Set price</h3>
        {error && <FormError error={error} />}
        {success && <FormAlert tone="success">{success}</FormAlert>}
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="dim" className={labelClassName}>Billing dimension</label>
              <input
                id="dim"
                list="dimensions-list"
                value={billingDimension}
                onChange={e => setBillingDimension(e.target.value)}
                disabled={isSubmitting}
                className={inputClassName}
                placeholder="e.g. input_tokens"
                required
              />
              <datalist id="dimensions-list">
                <option value="input_tokens" />
                <option value="output_tokens" />
                <option value="cached_input_tokens" />
                <option value="reasoning_tokens" />
                <option value="audio_input_tokens" />
                <option value="audio_output_tokens" />
                <option value="image_output_tokens" />
                <option value="image_units" />
              </datalist>
            </div>
            
            <div className="flex flex-col gap-1.5">
              <label htmlFor="price" className={labelClassName}>Price</label>
              <input
                id="price"
                pattern="^\d{1,10}(\.\d{1,8})?$"
                title="Decimal string, e.g. 0.05"
                value={price}
                onChange={e => setPrice(e.target.value)}
                disabled={isSubmitting}
                className={inputClassName}
                placeholder="0.00"
                required
              />
            </div>
            
            <div className="flex flex-col gap-1.5">
              <label htmlFor="unit" className={labelClassName}>Unit size</label>
              <input
                id="unit"
                type="text"
                pattern="^\d+$"
                value={unitSize}
                onChange={e => setUnitSize(e.target.value)}
                disabled={isSubmitting}
                className={inputClassName}
                required
              />
            </div>
            
            <div className="flex flex-col gap-1.5">
              <label htmlFor="curr" className={labelClassName}>Currency</label>
              <input
                id="curr"
                type="text"
                value={currency}
                onChange={e => setCurrency(e.target.value)}
                disabled={isSubmitting}
                className={inputClassName}
                required
              />
            </div>
            
            <div className="flex flex-col gap-1.5">
              <label htmlFor="eff" className={labelClassName}>Effective from</label>
              <input
                id="eff"
                type="datetime-local"
                value={effectiveFrom}
                onChange={e => setEffectiveFrom(e.target.value)}
                disabled={isSubmitting}
                className={inputClassName}
              />
              <span className="text-xs text-zinc-500">Leave empty for now</span>
            </div>
          </div>
          
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={isSubmitting || !billingDimension.trim() || !price.trim()} className={buttonClassName}>
              Set price
            </button>
            <button type="button" onClick={handleShortcut} disabled={isSubmitting || !price.trim()} className="px-4 py-2 text-sm font-medium text-zinc-900 bg-zinc-200 rounded-md hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 transition-colors">
              Set input & output tokens
            </button>
          </div>
        </form>
      </div>

      <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
        <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-4">History</h3>
        {history.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-left">
              <thead className="border-b border-zinc-200 dark:border-zinc-800">
                <tr className="text-zinc-500 dark:text-zinc-400">
                  <th className="px-3 py-2 font-medium">Dimension</th>
                  <th className="px-3 py-2 font-medium">Price</th>
                  <th className="px-3 py-2 font-medium">Unit</th>
                  <th className="px-3 py-2 font-medium">From</th>
                  <th className="px-3 py-2 font-medium">To</th>
                  <th className="px-3 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {history.map(r => {
                  const isFuture = new Date(r.effectiveFrom) > now;
                  return (
                    <tr key={r.id}>
                      <td className="px-3 py-2 text-zinc-900 dark:text-zinc-100">{r.billingDimension}</td>
                      <td className="px-3 py-2 text-zinc-900 dark:text-zinc-100">{r.price} {r.currency}</td>
                      <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">{r.unitSize}</td>
                      <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">{new Date(r.effectiveFrom).toLocaleString()}</td>
                      <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">{r.effectiveTo ? new Date(r.effectiveTo).toLocaleString() : "—"}</td>
                      <td className="px-3 py-2 text-right">
                        {isFuture && (
                          confirmingDelete === r.id ? (
                            <div className="flex items-center gap-2 justify-end">
                              <span className="text-xs text-red-600">Sure?</span>
                              <button onClick={() => handleDelete(r.id)} disabled={isSubmitting} className="text-xs text-white bg-red-600 px-2 py-1 rounded">Yes</button>
                              <button onClick={() => setConfirmingDelete(null)} disabled={isSubmitting} className="text-xs text-zinc-700 bg-zinc-200 px-2 py-1 rounded dark:bg-zinc-700 dark:text-zinc-300">No</button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmingDelete(r.id)}
                              disabled={isSubmitting}
                              className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 font-medium"
                            >
                              Delete
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No pricing history.</p>
        )}
      </div>
    </div>
  );
}
