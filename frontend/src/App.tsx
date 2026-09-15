import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Upload from './pages/Upload';
import ScanDetail from './pages/ScanDetail';
import ScanHistory from './pages/ScanHistory';

export default function App() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
        <Route path="/upload" element={<ProtectedRoute><Upload /></ProtectedRoute>} />
        <Route path="/history" element={<ProtectedRoute><ScanHistory /></ProtectedRoute>} />
        <Route path="/scans/:id" element={<ProtectedRoute><ScanDetail /></ProtectedRoute>} />
      </Routes>
    </div>
  );
}
