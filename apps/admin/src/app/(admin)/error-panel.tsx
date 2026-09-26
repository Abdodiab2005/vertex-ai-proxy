export function ErrorPanel({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="p-4 border border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400 rounded-md"
    >
      {message}
    </div>
  );
}
