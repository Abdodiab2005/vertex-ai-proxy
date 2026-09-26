export function FormAlert({
  children,
  tone = "error",
}: {
  children: React.ReactNode;
  tone?: "error" | "success";
}) {
  const classes =
    tone === "success"
      ? "p-3 text-sm text-green-700 bg-green-50 rounded-md border border-green-200 dark:text-green-400 dark:bg-green-950 dark:border-green-900"
      : "p-3 text-sm text-red-600 bg-red-50 rounded-md border border-red-200 dark:text-red-400 dark:bg-red-950 dark:border-red-900";

  return (
    <div role="alert" className={classes}>
      {children}
    </div>
  );
}

export function FormError({ error }: { error: string | string[] }) {
  if (typeof error === "string") {
    return <FormAlert>{error}</FormAlert>;
  }

  return (
    <FormAlert>
      <ul className="list-disc ps-5 space-y-1">
        {error.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>
    </FormAlert>
  );
}
