const { z } = require('zod');
const { run } = require('../services/bitrix/createContactFromLead');

const schema = z.object({
  leadId: z.coerce.number().int().positive(),
});

async function createContactFromLead(req, res) {
  const leadId = req.params.leadId ?? req.body.leadId ?? req.body.lead_id;
  const parsed = schema.safeParse({ leadId });

  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }

  const result = await run({ leadId: parsed.data.leadId });
  return res.status(result.ok ? 200 : 422).json(result);
}

module.exports = { createContactFromLead };
