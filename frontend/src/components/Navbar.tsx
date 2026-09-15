import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
      isActive ? 'border-brass text-ink' : 'border-transparent text-ink/55 hover:text-ink'
    }`;

  return (
    <header className="border-b border-line bg-paper/95 backdrop-blur sticky top-0 z-20">
      <div className="max-w-6xl mx-auto px-5 flex items-center justify-between h-16">
        <div className="flex items-center gap-8">
          <div className="leading-tight">
            <p className="font-semibold tracking-tight">Metrology Compliance Register</p>
            <p className="text-[11px] text-ink/50 font-mono">Legal Metrology (Packaged Commodities) Rules, 2011 — PoC</p>
          </div>
          {user && (
            <nav className="flex gap-1">
              <NavLink to="/" end className={linkClass}>Dashboard</NavLink>
              <NavLink to="/upload" className={linkClass}>New Scan</NavLink>
              <NavLink to="/history" className={linkClass}>Scan History</NavLink>
            </nav>
          )}
        </div>
        {user && (
          <div className="flex items-center gap-4 text-sm">
            <span className="text-ink/60">{user.name} <span className="text-ink/40">· {user.role}</span></span>
            <button
              onClick={() => { logout(); navigate('/login'); }}
              className="px-3 py-1.5 border border-line rounded-sm hover:bg-ink hover:text-paper transition-colors"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
