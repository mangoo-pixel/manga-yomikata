// netlify/functions/ocr.js
// Reads Japanese text from a manga image using Google's Gemini vision API.
// The API key lives only here, as a Netlify environment variable — never in the browser.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { imageBase64, mimeType } = JSON.parse(event.body || '{}');
    if (!imageBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No image provided' }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is missing GEMINI_API_KEY — set it in Netlify site settings.' }) };
    }

    const prompt =
      'Transcribe only the Japanese text visible in this manga image, exactly as written, ' +
      'preserving natural reading order (right-to-left, top-to-bottom for vertical text). ' +
      'Output ONLY the raw Japanese text — no translation, no romaji, no notes, no markdown, no quotation marks.';

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType || 'image/png', data: imageBase64 } }
            ]
          }]
        })
      }
    );

    const data = await resp.json();

    if (!resp.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: data.error?.message || 'Gemini request failed' }) };
    }

    const text = (data.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '')
      .join('')
      .trim();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
