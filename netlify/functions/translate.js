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
      'For each word, give:\n' +
      '1. "reading": how it is actually PRONOUNCED in THIS sentence, written in hiragana. ' +
      'This matters most for numbers and times — spell out the full pronunciation ' +
      '(e.g. 16時 in a time context reads as "じゅうろくじ"; irregular time readings like ' +
      '4時=よじ, 7時=しちじ, 9時=くじ must be correct; plain numbers like 16 read as "じゅうろく").\n' +
      '2. "meaning": the SHORT (2-6 word) English meaning that is actually correct for how it is ' +
      'used in THIS sentence — not just the most common dictionary sense if context implies something else.\n\n' +
      'Also give one natural, fluent English translation of the whole sentence.\n\n' +
      'IMPORTANT: every single word in the list MUST appear in your output — do not skip any, ' +
      'even short particles, counters, numbers, or fragments with no independent meaning. For those, ' +
      'describe their grammatical function instead (e.g. "counter for cups", "possessive particle", ' +
      '"question marker"). Never omit a word or leave "meaning" empty.\n\n' +
      'Respond with ONLY valid JSON, no other text, no markdown code fences, in exactly this shape:\n' +
      '{"sentence_translation": "...", "words": [{"word": "...", "reading": "...", "meaning": "..."}]}';

    const requestBody = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    // Single attempt, kept fast — retrying here (instead of client-side) risks
    // exceeding Netlify's ~10s function timeout, which causes a worse 504 error.
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody
    });
    const data = await resp.json();

    if (!resp.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: data.error?.message || 'Gemini request failed' }) };
    }

    let rawText = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    // Safety net: strip stray markdown code fences in case the model adds them despite instructions
    rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: 'Could not parse translation response: ' + rawText.slice(0, 150) })
      };
    }

    const meanings = {};
    const readings = {};
    (parsed.words || []).forEach(w => {
      if (!w || !w.word) return;
      meanings[w.word] = w.meaning || '';
      if (w.reading) readings[w.word] = w.reading;
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sentenceTranslation: parsed.sentence_translation || '',
        meanings,
        readings
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
