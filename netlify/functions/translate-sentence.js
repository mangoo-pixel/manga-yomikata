// netlify/functions/translate-sentence.js
// Gives one complete English translation of the full scanned text. Split out from
// the word-by-word analysis (translate.js) into its own fast, focused call — doing
// both jobs in one request made each call slow enough to risk Netlify's ~10s
// function timeout, especially on long, multi-bubble manga page scans.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { sentence } = JSON.parse(event.body || '{}');
    if (!sentence) {
      return { statusCode: 400, body: JSON.stringify({ error: 'sentence is required' }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is missing GEMINI_API_KEY' }) };
    }

    const prompt =
      'Translate the following Japanese text into natural, fluent English. It may be a single line, ' +
      'or a whole manga page with several separate speech bubbles, captions, and sound effects ' +
      'concatenated together — if so, translate ALL of them, in order, separated by " / ". ' +
      'Translate the ENTIRE text below, start to finish — do not summarize, shorten, or stop early.\n\n' +
      'TEXT:\n' + sentence + '\n\n' +
      'Respond with ONLY the translation itself — no preamble, no quotes, no labels, no markdown.';

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    const data = await resp.json();

    if (!resp.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: data.error?.message || 'Gemini request failed' }) };
    }

    const translation = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ translation })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
