// netlify/functions/translate.js
// Gives contextually accurate English meanings for a list of Japanese words,
// using the full sentence for context (fixes wrong meanings from naive
// word-by-word translation, e.g. パン -> "bread" not "camera panning").

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { sentence, words } = JSON.parse(event.body || '{}');
    if (!sentence || !Array.isArray(words) || !words.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'sentence and words[] are required' }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Server is missing GEMINI_API_KEY' }) };
    }

    const uniqueWords = Array.from(new Set(words)).slice(0, 60); // safety cap

    const prompt =
      'You are a Japanese-English dictionary helping a beginner read manga.\n\n' +
      'Full sentence: ' + sentence + '\n\n' +
      'Words to define (dictionary/base forms): ' + JSON.stringify(uniqueWords) + '\n\n' +
      'For each word, give the SHORT (2-6 word) English meaning that is actually correct ' +
      'for how it is used in THIS sentence — not just the most common dictionary sense if ' +
      'context implies something else. Also give one natural, fluent English translation of the whole sentence.\n\n' +
      'Respond with ONLY valid JSON, no other text, in exactly this shape:\n' +
      '{"sentence_translation": "...", "words": [{"word": "...", "meaning": "..."}]}';

    const requestBody = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const MAX_ATTEMPTS = 3;
    let resp, data;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      });
      data = await resp.json();

      const isOverloaded = !resp.ok && (resp.status === 503 || resp.status === 429 ||
        /overloaded|high demand|try again/i.test(data.error?.message || ''));

      if (resp.ok || !isOverloaded || attempt === MAX_ATTEMPTS) break;
      await new Promise(r => setTimeout(r, attempt * 800));
    }

    if (!resp.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: data.error?.message || 'Gemini request failed' }) };
    }

    const rawText = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { statusCode: 502, body: JSON.stringify({ error: 'Could not parse translation response' }) };
    }

    const meanings = {};
    (parsed.words || []).forEach(w => { if (w && w.word) meanings[w.word] = w.meaning || ''; });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sentenceTranslation: parsed.sentence_translation || '',
        meanings
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
