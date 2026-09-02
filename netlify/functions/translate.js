// netlify/functions/translate.js
// Gives contextually accurate English meanings for Japanese text, and — importantly —
// detects when the client's word-by-word tokenizer has WRONGLY split a real compound
// word into individual kanji (e.g. 純米酒 split into 純/米/酒, each read in isolation as
// "jun"/"bei"/"shu" instead of the correct combined reading "junmaishu"). Gemini sees
// the words in their original sentence order and can merge these back into one entry
// with the correct whole-word reading and meaning.
//
// Matching strategy: every incoming word gets a sequential position ID matching its
// exact position in the browser's token list (duplicates are NOT deduplicated — that
// would break the positional adjacency needed to detect compounds, and also risks
// giving two occurrences of the same word the same reading even if context differs).
// Gemini returns "groups" of one or more consecutive IDs that belong together as a
// single unit, each with one combined reading/meaning. Every incoming ID must appear
// in exactly one group.

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

    // Safety cap only, not a normal ceiling — a dense full manga page with several
    // speech bubbles easily tokenizes to 80-100+ words, so 80 was cutting real content
    // off silently. 150 comfortably covers a full page while still guarding against
    // pathological inputs (e.g. accidentally scanning many pages at once).
    const wordList = words.slice(0, 150);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    function buildPrompt(){
      const numbered = wordList.map((w, i) => i + '. ' + w).join('\n');
      return 'You are a Japanese-English dictionary and translator helping a beginner read manga.\n\n' +
        'SOURCE TEXT (for context — this may be a single line, or a whole page with several ' +
        'separate speech bubbles, captions, and sound effects concatenated together):\n' + sentence + '\n\n' +
        'A tokenizer has split this text into the following pieces, IN ORDER, numbered by position:\n' +
        numbered + '\n\n' +
        'IMPORTANT — the tokenizer sometimes WRONGLY splits a real compound word into separate kanji ' +
        'that are each correct alone but WRONG when read separately as part of the compound. For example ' +
        '純, 米, 酒 individually read "jun", "bei", "shu" — but as the single compound word 純米酒 (pure rice ' +
        'sake) they read together as "じゅんまいしゅ" (junmaishu), which is NOT the same as reading each ' +
        'kanji on its own. When you see CONSECUTIVE numbered pieces like this that form one real compound ' +
        'word, proper noun, or set phrase — where the combined reading is genuinely different from just ' +
        'concatenating each piece\'s own reading — merge them into ONE group with the correct combined ' +
        'reading and meaning for the whole thing.\n\n' +
        'Do NOT over-merge: ordinary sentences (a noun followed by a particle, a verb followed by its ' +
        'ending, etc.) should stay as separate, single-piece groups — merging is ONLY for genuine compounds ' +
        'where reading the pieces separately would give a wrong or unnatural result.\n\n' +
        'Return "groups": one entry per group. Each group has:\n' +
        '- "ids": the array of consecutive position numbers it covers (a single unmerged piece is just [n]).\n' +
        '- "reading": how the WHOLE group is pronounced together, in hiragana. Always spell out numbers ' +
        'and times fully (e.g. 4時=よじ, a bare number like "260" = "にひゃくろくじゅう"). Never leave empty.\n' +
        '- "meaning": a SHORT (2-6 word) English meaning correct for how it\'s used in this context. Even ' +
        'particles, counters, or fragments with no independent meaning need a real entry describing their ' +
        'grammatical function (e.g. "counter for cups", "possessive particle"). Never leave empty.\n\n' +
        'EVERY position number from 0 to ' + (wordList.length - 1) + ' must appear in EXACTLY ONE group\'s ' +
        '"ids" array — no number skipped, no number in two groups.\n\n' +
        'Respond with ONLY valid JSON, no other text, no markdown code fences, in exactly this shape:\n' +
        '{"groups": [{"ids": [0], "reading": "...", "meaning": "..."}, ' +
        '{"ids": [1,2,3], "reading": "...", "meaning": "..."}]}';
    }

    async function callGemini(){
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt() }] }],
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

      const rawGroups = Array.isArray(parsed.groups) ? parsed.groups : [];
      const covered = new Set();
      const groups = [];

      rawGroups.forEach(g => {
        if (!g || !Array.isArray(g.ids) || !g.ids.length) return;
        // Only accept in-range, not-already-covered ids — protects against a
        // malformed response corrupting the final word list.
        const ids = g.ids.filter(id => typeof id === 'number' && id >= 0 && id < wordList.length && !covered.has(id));
        if (!ids.length) return;
        ids.forEach(id => covered.add(id));
        groups.push({ ids, reading: g.reading || '', meaning: g.meaning || '' });
      });

      // Fill in any position the model didn't cover (shouldn't normally happen, but
      // guarantees every word still shows up rather than silently vanishing).
      for (let i = 0; i < wordList.length; i++) {
        if (!covered.has(i)) groups.push({ ids: [i], reading: '', meaning: '' });
      }
      groups.sort((a, b) => a.ids[0] - b.ids[0]);

      return { groups };
    }

    const result = await callGemini();

    // Single Gemini call only — this function must stay fast. Retrying here (like an
    // earlier version did) can chain two Gemini calls inside one ~10s function window,
    // which is exactly what caused 504 timeouts before. If any group is missing a
    // meaning, the caller (the browser) retries just that specific group as its own
    // separate, fast request.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message || err) }) };
  }
};
