'use strict';
// Machine translation for tenant-submitted text (currently: maintenance
// request descriptions), so office staff who only read English still get
// a usable English version of what a Spanish-speaking tenant wrote.
//
// Reuses the exact same ANTHROPIC_API_KEY / OPENAI_API_KEY pattern as the
// AI Coach (routes/tenant.js callAnthropic/callOpenAI) — same env vars,
// same "degrade cleanly, never fabricate" behavior. If neither key is
// configured, translateToEnglish() resolves to null rather than throwing,
// so callers can store description_en = null and the UI can show a clear
// "translation not available" note instead of crashing the request.
//
// IMPORTANT: never invent a translation. If the API call fails for any
// reason (bad key, network error, model error), this returns null — the
// caller must NOT fall back to guessing a translation itself.

async function callAnthropicTranslate(text) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_TRANSLATE_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: 'You are a translation engine. Translate the user\'s message from Spanish to English. Reply with ONLY the English translation, no preamble, no quotes, no explanation.',
      messages: [{ role: 'user', content: text }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || 'Anthropic API error');
  return data.content.map(b => b.text || '').join('').trim();
}

async function callOpenAITranslate(text) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_TRANSLATE_MODEL || 'gpt-4o-mini',
      max_tokens: 400,
      messages: [
        { role: 'system', content: 'You are a translation engine. Translate the user\'s message from Spanish to English. Reply with ONLY the English translation, no preamble, no quotes, no explanation.' },
        { role: 'user', content: text },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data.error && data.error.message) || 'OpenAI API error');
  return (data.choices[0].message.content || '').trim();
}

// Returns { text: string } on success, or { text: null, reason: 'no_key' | 'error' } if
// translation isn't available right now. Never throws — callers can await
// this directly without a try/catch.
async function translateToEnglish(text) {
  if (!text || !text.trim()) return { text: null, reason: 'error' };
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  if (!hasAnthropic && !hasOpenAI) return { text: null, reason: 'no_key' };
  try {
    const translated = hasAnthropic
      ? await callAnthropicTranslate(text.trim())
      : await callOpenAITranslate(text.trim());
    return { text: translated || null, reason: translated ? null : 'error' };
  } catch (err) {
    console.error('translateToEnglish error:', err.message);
    return { text: null, reason: 'error' };
  }
}

module.exports = { translateToEnglish };
