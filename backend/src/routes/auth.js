// Minimal email/password auth backed by Supabase ("users" table).
// PoC-level only: passwords are hashed with a simple salted SHA-256 here
// (see utils/validators.js) rather than bcrypt, to avoid a native build
// dependency. Swap in bcrypt for anything beyond a PoC.
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { supabase } = require('../config/supabase');
const { hashPassword, verifyPassword } = require('../utils/validators');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password || password.length < 6) {
      return res.status(400).json({ error: 'Email and a password (6+ chars) are required.' });
    }
    const normalizedEmail = email.toLowerCase();
    const { data: existing, error: lookupError } = await supabase
      .from('users')
      .select('uid')
      .eq('email', normalizedEmail)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const uid = uuidv4();
    const { hash, salt } = hashPassword(password);
    const userDoc = {
      uid,
      email: normalizedEmail,
      name: name || email.split('@')[0],
      role: role === 'admin' ? 'admin' : 'inspector', // only two roles for the PoC
      password_hash: hash,
      password_salt: salt,
      created_at: new Date().toISOString(),
    };
    const { error: insertError } = await supabase.from('users').insert(userDoc);
    if (insertError) throw insertError;

    const token = issueToken(userDoc);
    res.status(201).json({ token, user: publicUser(userDoc) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const { data: userDoc, error: lookupError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!userDoc) return res.status(401).json({ error: 'Invalid credentials.' });
    const ok = verifyPassword(password, userDoc.password_hash, userDoc.password_salt);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

    const token = issueToken(userDoc);
    res.json({ token, user: publicUser(userDoc) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

function issueToken(userDoc) {
  return jwt.sign(
    { uid: userDoc.uid, email: userDoc.email, role: userDoc.role, name: userDoc.name },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
}

function publicUser(userDoc) {
  return { uid: userDoc.uid, email: userDoc.email, name: userDoc.name, role: userDoc.role };
}

module.exports = router;
