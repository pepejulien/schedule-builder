// POST /api/parse-screenshot  { image_base64, media_type }
// Calls the Anthropic Messages API (vision + structured output) to extract
// per-day wave times + route counts from an Amazon DSP portal screenshot.
// Returns { days: [{day, waves:[{portal_time, count}]}], warnings: [] } in
// PORTAL times — the -20 min offset is applied client-side.
import { requireAuth } from '../lib/session.mjs';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['days', 'warnings'],
  properties: {
    days: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['day', 'waves'],
        properties: {
          day: { type: 'string', enum: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] },
          waves: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['portal_time', 'count'],
              properties: {
                portal_time: { type: 'string', description: 'e.g. "10:45 AM"' },
                count: { type: 'integer' },
              },
            },
          },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

const PROMPT = `You are reading a screenshot of an Amazon DSP route-planning portal.
Extract, for each operating day, the wave dispatch times and how many routes are
in each wave. Return PORTAL times exactly as shown (do not shift them).
Map each day to its weekday abbreviation (Sun, Mon, Tue, Wed, Thu, Fri, Sat).
If a day has no routes it is closed — omit it. Put anything ambiguous or
unreadable in "warnings". Only report what you can actually see.`;

export default async (req) => {
  if (!requireAuth(req)) return new Response('Unauthorized', { status: 401 });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response('AI screenshot parsing is not configured (no API key). Enter counts manually.', { status: 502 });
  }

  let body;
  try { body = await req.json(); } catch { return new Response('Bad request', { status: 400 }); }
  const { image_base64, media_type } = body || {};
  if (!image_base64) return new Response('No image provided', { status: 400 });

  const payload = {
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: media_type || 'image/png', data: image_base64 } },
        { type: 'text', text: PROMPT },
      ],
    }],
  };

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    return new Response('Could not reach the AI service. Enter counts manually.', { status: 502 });
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return new Response('The AI service returned an error. Enter counts manually.\n' + detail.slice(0, 300), { status: 502 });
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    return new Response('The AI declined to read this image. Enter counts manually.', { status: 502 });
  }
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock) return new Response('The AI returned no result. Enter counts manually.', { status: 502 });

  let parsed;
  try { parsed = JSON.parse(textBlock.text); } catch {
    return new Response('The AI result could not be parsed. Enter counts manually.', { status: 502 });
  }
  return Response.json(parsed);
};
