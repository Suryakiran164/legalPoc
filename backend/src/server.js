require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const authRoutes = require('./routes/auth');
const scansRoutes = require('./routes/scans');
const rulesRoutes = require('./routes/rules');
const dashboardRoutes = require('./routes/dashboard');

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'legal-metrology-poc-backend' }));

app.use('/api/auth', authRoutes);
app.use('/api/scans', scansRoutes);
app.use('/api/rules', rulesRoutes);
app.use('/api/dashboard', dashboardRoutes);

// Central error handler (e.g. multer file-type/size errors)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Unexpected server error.' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Legal Metrology PoC backend listening on http://localhost:${PORT}`);
});
