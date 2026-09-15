import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Login failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] flex items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm border border-line bg-white p-8 rounded-sm">
        <h1 className="text-lg font-semibold mb-1">Sign in</h1>
        <p className="text-sm text-ink/55 mb-6">Access the compliance scan register.</p>

        {error && <div className="mb-4 text-sm border border-signal-missing/30 bg-signal-missing/10 text-signal-missing px-3 py-2 rounded-sm">{error}</div>}

        <label className="block text-xs font-medium text-ink/60 mb-1">Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required
          className="w-full mb-4 px-3 py-2 border border-line rounded-sm focus:outline-none focus:ring-2 focus:ring-brass/40" />

        <label className="block text-xs font-medium text-ink/60 mb-1">Password</label>
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required
          className="w-full mb-6 px-3 py-2 border border-line rounded-sm focus:outline-none focus:ring-2 focus:ring-brass/40" />

        <button disabled={busy} className="w-full bg-ink text-paper py-2.5 rounded-sm font-medium hover:bg-slate-950 disabled:opacity-60">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="text-sm text-ink/55 mt-5 text-center">
          No account? <Link to="/register" className="text-brass font-medium">Register</Link>
        </p>
      </form>
    </div>
  );
}
