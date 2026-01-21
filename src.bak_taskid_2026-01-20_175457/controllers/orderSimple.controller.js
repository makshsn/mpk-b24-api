const { z } = require('zod');
const setSvc = require('../services/bitrix/setCurrentOrderNoFromLead');
const moveSvc = require('../services/bitrix/moveCurrentToClosedFromLead');

const schema = z.object({
  leadId: z.coerce.number().int().positive(),
});

async function setCurrentOrderNo(req, res) {
  const leadId = req.params.leadId ?? req.query.leadId ?? req.body.leadId ?? req.body.ID;
  const parsed = schema.safeParse({ leadId });
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });

  const result = await setSvc.run({ leadId: parsed.data.leadId });
  return res.status(result.ok ? 200 : 422).json(result);
}

async function moveCurrentToClosed(req, res) {
  const leadId = req.params.leadId ?? req.query.leadId ?? req.body.leadId ?? req.body.ID;
  const parsed = schema.safeParse({ leadId });
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });

  const result = await moveSvc.run({ leadId: parsed.data.leadId });
  return res.status(result.ok ? 200 : 422).json(result);
}

module.exports = { setCurrentOrderNo, moveCurrentToClosed };
