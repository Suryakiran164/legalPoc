const express = require('express');
const { supabase } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/summary', async (req, res) => {
  try {
    const { data: scans, error } = await supabase
      .from('scans')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) throw error;

    const totalScans = scans.length;
    let possibleIssues = 0;
    let requiresVerification = 0;
    let reviewed = 0;

    scans.forEach((s) => {
      possibleIssues += s.summary?.possible_issues || 0;
      requiresVerification += s.summary?.requires_verification || 0;
      if (s.human_review?.reviewed) reviewed += 1;
    });

    const recentActivity = scans.slice(0, 10).map((s) => ({
      id: s.id,
      original_filename: s.original_filename,
      status: s.status,
      created_at: s.created_at,
      commodity_name: (s.corrected_fields || s.extracted_fields || {}).commodity_name || null,
      possible_issues: s.summary?.possible_issues || 0,
      requires_verification: s.summary?.requires_verification || 0,
    }));

    res.json({
      total_scans: totalScans,
      scans_reviewed: reviewed,
      scans_pending_review: totalScans - reviewed,
      total_possible_issues: possibleIssues,
      total_requires_verification: requiresVerification,
      recent_activity: recentActivity,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build dashboard summary.' });
  }
});

module.exports = router;
