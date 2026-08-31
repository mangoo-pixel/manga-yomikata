// netlify/functions/translate.js
// Gives contextually accurate English meanings for a list of Japanese words,
// using the full sentence for context (fixes wrong meanings from naive
// word-by-word translation, e.g. パン -> "bread" not "camera panning").
//
// Matching strategy: each word is sent with a numeric ID, and Gemini must echo
// that ID back with its answer. This is immune to the model rephrasing a word
// slightly, dropping an entry (which used to shift every later entry's position),
// or reordering — all of which previously caused silent, hard-to-diagnose gaps.

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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    function buildPrompt(indices){
      const numbered = indices.map(i => i + '. ' + uniqueWords[i]).join('\n');
      return 'You are a Japanese-English dictionary helping a beginner read manga.\n\n' +
        'Full sentence (for context): ' + sentence + '\n\n' +
        'Numbered words to define (dictionary/base forms):\n' + numbered + '\n\n' +
        'For each numbered word, give:\n' +
        '1. "reading": how it is actually PRONOUNCED in THIS sentence, written in hiragana. ' +
        'This matters most for numbers and times — always spell out a full pronunciation, never ' +
        'leave it blank. Irregular time readings like 4時=よじ, 7時=しちじ, 9時=くじ must be correct. ' +
        'A bare number with no attached counter (e.g. "260") should be read as a plain cardinal ' +
        'number (e.g. "にひゃくろくじゅう") — never leave a number\'s reading empty.\n' +
        '2. "meaning": the SHORT (2-6 word) English meaning that is actually correct for how it is ' +
        'used in THIS sentence — not just the most common dictionary sense if context implies something else. ' +
        'Even short particles, counters, numbers, or bound fragments with no independent meaning MUST get a ' +
        'real entry — describe their grammatical function instead (e.g. "counter for cups", "possessive particle"). ' +
        'A bare number\'s meaning can simply be the number itself written out (e.g. "260").\n' +
        'NEVER leave "reading" or "meaning" empty, and NEVER skip a numbered word — every number listed ' +
        'above must appear exactly once in your output, matched by its "id".\n\n' +
        'Also give one natural, fluent English translation of the whole sentence.\n\n' +
        'Respond with ONLY valid JSON, no other text, no markdown code fences, in exactly this shape:\n' +
        '{"sentence_translation": "...", "words": [{"id": 0, "reading": "...", "meaning": "..."}]}';
    }

    async function callGemini(indices){
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(indices) }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error?.message || 'Gemini request failed');

      let rawText = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

      let parsed;
      try { parsed = JSON.parse(rawText); }
      catch { throw new Error('Could not parse translation response: ' + rawText.slice(0, 150)); }

      const meanings = {}, readings = {};
      const respWords = Array.isArray(parsed.words) ? parsed.words : [];
      respWords.forEach(entry => {
        if (!entry || typeof entry.id !== 'number') return;
        const word = uniqueWords[entry.id];
        if (word === undefined) return; // out-of-range id — ignore rather than corrupt data
        meanings[word] = entry.meaning || '';
        if (entry.reading) readings[word] = entry.reading;
      });
      return { sentenceTranslation: parsed.sentence_translation || '', meanings, readings };
    }

    const allIndices = uniqueWords.map((_, i) => i);
    const result = await callGemini(allIndices);

    // Single Gemini call only — this function must stay fast. Retrying here (like the
    // previous version did) can chain two Gemini calls inside one ~10s function window,
    // which is exactly what caused the 504 timeouts this was meant to prevent. If any
    // words are missing a meaning, the caller (the browser) retries just those specific
    // words as its own separate, fast request — see fillMissingTranslations in index.html.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
