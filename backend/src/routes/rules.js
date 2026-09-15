// Admin-facing CRUD for the rule set (so the rule engine stays fully
// configurable via Supabase tables instead of hard-coded in application logic).
const express = require('express');
const { supabase } = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase.from('rules').select('*').order('rule_id');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list rules.' });
  }
});

router.put('/:ruleId', requireRole('admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('rules')
      .upsert({ ...req.body, rule_id: req.params.ruleId }, { onConflict: 'rule_id' })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update rule.' });
  }
});

module.exports = router;
