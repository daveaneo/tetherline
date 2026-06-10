/**
 * Fenced-code extraction for the voice pipeline. Code is NEVER spoken:
 * anything inside ``` fences is lifted out of the spoken text and shipped
 * to the screen as a copyable artifact (`visual:artifact`). The live bug
 * this kills: the AI read an install script ALOUD, backticks included,
 * while the screen showed it as one unselectable caption line.
 *
 * Two consumers:
 *  - batch path (emitNarrationChunked / skill narrations): extractFencedArtifacts
 *  - streaming path: StreamingSentenceSplitter's fence mode accumulates
 *    fence content itself and uses parseFenceBody/classifyArtifact here.
 */

export interface ExtractedArtifact {
  /** Fence language tag ('' when untagged). */
  language: string;
  code: string;
}

/** Fence opener at line start: optional indent, three backticks, optional
 *  language word to end-of-line. */
const FENCE_OPEN = /(^|\n)[ \t]*```([^\n`]*)?/;

const COMMAND_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'powershell', 'cmd']);
const COMMAND_LINE = /^\s*(\$\s+)?(npm|pnpm|yarn|npx|git|cd|pip|pip3|python|python3|node|cargo|make|docker|curl|wget|brew|apt|apt-get|go|mvn|gradle|bundle|composer|cp|mv|mkdir|chmod|export|source)\b/;

/** Split a raw fence body into its language tag (first line, if it looks
 *  like one) and the code. */
export function parseFenceBody(body: string): ExtractedArtifact {
  const nl = body.indexOf('\n');
  if (nl >= 0) {
    const first = body.slice(0, nl).trim();
    if (/^[A-Za-z0-9_#+.-]{0,20}$/.test(first)) {
      return { language: first.toLowerCase(), code: trimCode(body.slice(nl + 1)) };
    }
  } else {
    // Single-line fence body. A bare language word with no code is useless;
    // treat the whole line as code.
  }
  return { language: '', code: trimCode(body) };
}

function trimCode(code: string): string {
  return code.replace(/^\n+/, '').replace(/\s+$/, '');
}

/** commands → render with a copy button labeled for terminal use. */
export function classifyArtifact(a: ExtractedArtifact): 'commands' | 'code' {
  if (COMMAND_LANGS.has(a.language)) return 'commands';
  if (a.language === '') {
    const lines = a.code.split('\n').filter(l => l.trim());
    if (lines.length > 0 && lines.every(l => COMMAND_LINE.test(l))) return 'commands';
  }
  return 'code';
}

/** Strip `inline backtick` spans, keeping their content: the words are
 *  fine to SPEAK — the backticks are not. */
export function stripInlineBackticks(sentence: string): string {
  if (!sentence.includes('`')) return sentence;
  return sentence.replace(/`([^`\n]*)`/g, '$1').replace(/`/g, '');
}

/**
 * Batch extraction: remove every complete fence (plus one trailing
 * unterminated fence — partial-on-screen beats dropped) from `text`.
 * Returns the prose with fences removed and the artifacts in order.
 */
export function extractFencedArtifacts(text: string): { clean: string; artifacts: ExtractedArtifact[] } {
  const artifacts: ExtractedArtifact[] = [];
  let rest = text;
  let clean = '';

  for (;;) {
    const open = rest.match(FENCE_OPEN);
    if (open === null || open.index === undefined) {
      clean += rest;
      break;
    }
    clean += rest.slice(0, open.index) + (open[1] ? '\n' : '');
    const bodyStart = open.index + open[0].length;
    // Body runs to the closing marker (``` at line start) or end-of-text.
    const tail = rest.slice(bodyStart);
    const close = tail.match(/\n[ \t]*```/);
    const langWord = (open[2] ?? '').trim();
    if (close && close.index !== undefined) {
      const body = tail.slice(0, close.index);
      artifacts.push(finalize(langWord, body));
      rest = tail.slice(close.index + close[0].length);
    } else {
      // Unterminated trailing fence — still an artifact (the user asked
      // for this content; partial beats silently dropped).
      artifacts.push(finalize(langWord, tail));
      rest = '';
      break;
    }
  }

  return {
    clean: clean.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    artifacts: artifacts.filter(a => a.code.length > 0),
  };
}

function finalize(langWord: string, body: string): ExtractedArtifact {
  if (/^[A-Za-z0-9_#+.-]{0,20}$/.test(langWord)) {
    return { language: langWord.toLowerCase(), code: trimCode(body) };
  }
  // The "language" slot held arbitrary text (e.g. inline ```stuff```) —
  // keep it as code content.
  return { language: '', code: trimCode(`${langWord}\n${body}`) };
}
