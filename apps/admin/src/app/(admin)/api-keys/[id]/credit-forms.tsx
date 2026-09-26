"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  errorMessageForStatus,
  fetchAdminApi,
  readResponseBody,
} from "../../../../lib/admin-api";
import { isCreditWriteResponse } from "../../../../lib/types";
import { useAdminSession } from "../../admin-session";
import { FormAlert, FormError } from "../../form-alert";

const inputClassName =
  "px-3 py-2 text-sm rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 w-full";

const labelClassName = "text-sm font-medium text-zinc-900 dark:text-zinc-100";

const submitClassName =
  "px-3 py-1.5 text-sm font-medium text-white bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 rounded-md hover:bg-zinc-800 dark:hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed";

const MONEY = /^-?\d{1,12}(\.\d{1,6})?$/;

type CreditKind = "credit_added" | "credit_removed" | "manual_adjustment" | "refund";

const FORMS: ReadonlyArray<{
  type: CreditKind;
  title: string;
  submitLabel: string;
  descriptionRequired: boolean;
  allowNegative: boolean;
  hint: string;
}> = [
  {
    type: "credit_added",
    title: "Add credit",
    submitLabel: "Add credit",
    descriptionRequired: false,
    allowNegative: false,
    hint: "A positive decimal such as 10.50. Description is optional.",
  },
  {
    type: "credit_removed",
    title: "Remove credit",
    submitLabel: "Remove credit",
    descriptionRequired: true,
    allowNegative: false,
    hint: "A positive decimal. The ledger stores it as a debit. Description is required.",
  },
  {
    type: "manual_adjustment",
    title: "Adjust credit",
    submitLabel: "Adjust",
    descriptionRequired: true,
    allowNegative: true,
    hint: "A non-zero decimal, positive or negative, such as -1.25. Description is required.",
  },
  {
    type: "refund",
    title: "Refund",
    submitLabel: "Refund",
    descriptionRequired: true,
    allowNegative: false,
    hint: "A positive decimal. Description is required.",
  },
];

export function CreditForms({ apiKeyId }: { apiKeyId: string }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {FORMS.map((form) => (
        <CreditForm key={form.type} apiKeyId={apiKeyId} {...form} />
      ))}
    </div>
  );
}

function CreditForm({
  apiKeyId,
  type,
  title,
  submitLabel,
  descriptionRequired,
  allowNegative,
  hint,
}: {
  apiKeyId: string;
  type: CreditKind;
  title: string;
  submitLabel: string;
  descriptionRequired: boolean;
  allowNegative: boolean;
  hint: string;
}) {
  const router = useRouter();
  const { csrfToken } = useAdminSession();
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | string[] | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const amountId = `credit-amount-${type}`;
  const descriptionId = `credit-description-${type}`;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    const trimmedAmount = amount.trim();
    const trimmedDescription = description.trim();
    const amountError = validateAmount(trimmedAmount, allowNegative);
    if (amountError !== null) {
      setError(amountError);
      return;
    }
    if (descriptionRequired && trimmedDescription.length === 0) {
      setError("A description is required for this change.");
      return;
    }

    const body: { type: CreditKind; amount: string; description?: string } = {
      type,
      amount: trimmedAmount,
    };
    if (trimmedDescription.length > 0) {
      body.description = trimmedDescription;
    }

    setIsSubmitting(true);
    try {
      const res = await fetchAdminApi(`/api-keys/${encodeURIComponent(apiKeyId)}/credits`, {
        method: "POST",
        csrfToken,
        body,
      });
      const responseBody = await readResponseBody(res);

      if (res.status === 401) {
        router.replace("/login");
        router.refresh();
        return;
      }

      if ((res.status !== 200 && res.status !== 201) || !isCreditWriteResponse(responseBody)) {
        setError(errorMessageForStatus(res.status, responseBody));
        return;
      }

      setAmount("");
      setDescription("");
      setSuccess(`Remaining credit: ${responseBody.summary.remaining}`);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-white dark:bg-zinc-900 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm space-y-3"
    >
      <fieldset className="space-y-3" disabled={isSubmitting}>
        <legend className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</legend>
        {error && <FormError error={error} />}
        {success && <FormAlert tone="success">{success}</FormAlert>}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={amountId} className={labelClassName}>
            Amount
          </label>
          <input
            id={amountId}
            name="amount"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            dir="ltr"
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className={inputClassName}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={descriptionId} className={labelClassName}>
            Description{descriptionRequired ? " (required)" : ""}
          </label>
          <textarea
            id={descriptionId}
            name="description"
            rows={2}
            required={descriptionRequired}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className={inputClassName}
          />
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
        <button type="submit" className={submitClassName}>
          {isSubmitting ? "Saving..." : submitLabel}
        </button>
      </fieldset>
    </form>
  );
}

function validateAmount(amount: string, allowNegative: boolean): string | null {
  if (!MONEY.test(amount)) {
    return "Enter a decimal amount with at most 6 decimal places, such as 10.50.";
  }
  if (!allowNegative && amount.startsWith("-")) {
    return "Enter a positive amount.";
  }
  if (isZeroMoney(amount)) {
    return "Amount cannot be zero.";
  }
  return null;
}

function isZeroMoney(amount: string): boolean {
  const unsigned = amount.startsWith("-") ? amount.slice(1) : amount;
  const [whole = "", fraction = ""] = unsigned.split(".");
  return /^0+$/.test(whole) && /^0*$/.test(fraction);
}
