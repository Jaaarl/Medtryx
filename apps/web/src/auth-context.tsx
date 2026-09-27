import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { User } from "@medtryx/shared";
import {
  api,
  onAuthExpired,
  refreshCsrf,
  setCsrfToken,
  type CurrentUserResponse,
} from "./api";

type AuthContextValue = {
  user: User | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onAuthExpired(() => setUser(null));
    void refreshCsrf()
      .then(() => api.get<CurrentUserResponse>("/auth/me"))
      .then(({ user: currentUser }) => setUser(currentUser))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
    return () => onAuthExpired(undefined);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      ready,
      async signIn(email, password) {
        await refreshCsrf();
        const result = await api.post<
          CurrentUserResponse & { csrfToken: string }
        >("/auth/login", { email, password });
        setCsrfToken(result.csrfToken);
        setUser(result.user);
      },
      async signOut() {
        await api.post<void>("/auth/logout");
        setUser(null);
      },
      async changePassword(currentPassword, newPassword) {
        await api.post<void>("/auth/password", {
          currentPassword,
          newPassword,
        });
      },
    }),
    [user, ready],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
