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
    let result = await callGemini(allIndices);

    // Safety net: if any word still has no meaning (model skipped it, or the whole
    // response came back technically valid but empty), retry those by ID.
    // Bug fixed here: this used to require "some but not all" words missing, which
    // meant a 100%-empty response — the worst case — was the one case that never
    // got retried, and silently rendered as blank for every word with no error shown.
    let gapIndices = allIndices.filter(i => {
      const w = uniqueWords[i];
      return !result.meanings[w] || !result.meanings[w].trim();
    });
    if (gapIndices.length && gapIndices.length <= 30) {
      try {
        const fillIn = await callGemini(gapIndices);
        Object.assign(result.meanings, fillIn.meanings);
        Object.assign(result.readings, fillIn.readings);
      } catch (e) {
        // Retry request itself failed — fall through to the total-failure check below.
      }
    }

    // If it's STILL entirely empty after a retry, this is a genuine failure, not a
    // handful of shrugged-off words — say so explicitly rather than returning a
    // silent 200 with nothing in it, so the app can show a clear error and let the
    // user retry, instead of every word quietly showing "meaning unavailable".
    if (Object.keys(result.meanings).length === 0 && uniqueWords.length > 0) {
      throw new Error('Gemini returned an empty translation after retrying — likely a transient issue, please try again');
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
