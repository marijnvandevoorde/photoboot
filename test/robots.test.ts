import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A crawler follows only the most specific group that names it, so the AI
// crawler group must repeat every private Disallow of the `*` group.
const PRIVATE = ['/s/', '/g/', '/share/', '/api/', '/admin', '/settings.html', '/sign'];

function groups(text: string): { agents: string[]; disallow: string[] }[] {
  const out: { agents: string[]; disallow: string[] }[] = [];
  let current: { agents: string[]; disallow: string[] } | undefined;
  let lastWasAgent = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    const [key, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (/^user-agent$/i.test(key)) {
      if (!lastWasAgent || !current) {
        current = { agents: [], disallow: [] };
        out.push(current);
      }
      current.agents.push(value);
      lastWasAgent = true;
    } else if (line) {
      if (/^disallow$/i.test(key) && current) current.disallow.push(value);
      lastWasAgent = false;
    }
  }
  return out;
}

describe('robots.txt', () => {
  const parsed = groups(readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8'));

  it('names the AI crawlers', () => {
    const agents = parsed.flatMap((g) => g.agents);
    for (const bot of ['*', 'GPTBot', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended']) {
      expect(agents).toContain(bot);
    }
  });

  it('keeps guest and admin pages private in every group', () => {
    expect(parsed.length).toBeGreaterThan(1);
    for (const g of parsed) expect(g.disallow).toEqual(expect.arrayContaining(PRIVATE));
  });
});
