import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api/client';

interface User {
  uid: string;
  email: string;
  name: string;
  role: 'admin' | 'inspector';
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem('lm_user');
    if (stored) setUser(JSON.parse(stored));
    setLoading(false);
  }, []);

  async function login(email: string, password: string) {
    const { data } = await api.post('/auth/login', { email, password });
    persist(data.token, data.user);
  }

  async function register(email: string, password: string, name: string) {
    const { data } = await api.post('/auth/register', { email, password, name });
    persist(data.token, data.user);
  }

  function persist(token: string, user: User) {
    localStorage.setItem('lm_token', token);
    localStorage.setItem('lm_user', JSON.stringify(user));
    setUser(user);
  }

  function logout() {
    localStorage.removeItem('lm_token');
    localStorage.removeItem('lm_user');
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
