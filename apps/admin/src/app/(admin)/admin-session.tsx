"use client";

import { createContext, useContext } from "react";

type AdminSessionValue = {
  csrfToken: string;
  email: string;
};

const AdminSessionContext = createContext<AdminSessionValue | null>(null);

export function AdminSessionProvider({
  csrfToken,
  email,
  children,
}: {
  csrfToken: string;
  email: string;
  children: React.ReactNode;
}) {
  return (
    <AdminSessionContext.Provider value={{ csrfToken, email }}>
      {children}
    </AdminSessionContext.Provider>
  );
}

export function useAdminSession(): AdminSessionValue {
  const session = useContext(AdminSessionContext);
  if (!session) {
    throw new Error("useAdminSession must be used within AdminSessionProvider");
  }
  return session;
}
