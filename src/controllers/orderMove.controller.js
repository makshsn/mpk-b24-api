const { z } = require('zod');
const { run } = require('../services/bitrix/moveLeadOrderToClosed');

const schema = z.object({
  leadId: z.coerce.number().int().positive(),
});

async function moveLeadOrder(req, res) {
  const leadId = req.params.leadId ?? req.query.leadId ?? req.body.leadId ?? req.body.ID;
  const parsed = schema.safeParse({ leadId });

  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }

  const result = await run({ leadId: parsed.data.leadId });
  return res.status(result.ok ? 200 : 422).json(result);
}

module.exports = { moveLeadOrder };
