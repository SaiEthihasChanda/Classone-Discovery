/**
 * Reads the seed scrape targets from docs/scrape-targets.yaml.
 *
 * This file is only the STARTING POINT. Once settings are seeded into the
 * database, the Settings page is authoritative and this is not consulted again
 * (except on an explicit reset).
 *
 * Parsed with a small hand-rolled reader rather than a YAML dependency: the file
 * has a fixed, flat shape we control. Swap in `yaml` if the schema grows.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env.js';

export interface FileScrapeTarget {
  universityName: string;
  department?: string;
  url: string;
  enabled: boolean;
  note?: string;
}

export function loadScrapeTargetsFromFile(): {
  faculty: FileScrapeTarget[];
  news: FileScrapeTarget[];
} {
  const filePath = path.join(env.repoRoot, 'docs', 'scrape-targets.yaml');
  const faculty: FileScrapeTarget[] = [];
  const news: FileScrapeTarget[] = [];

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    console.warn(`[discovery] no scrape-targets.yaml at ${filePath}`);
    return { faculty, news };
  }

  let section: 'faculty' | 'news' | 'grants' | null = null;
  let current: Partial<FileScrapeTarget> = {};

  const flush = () => {
    if (current.url && current.universityName) {
      const target: FileScrapeTarget = {
        universityName: current.universityName,
        url: current.url,
        enabled: current.enabled ?? false,
        ...(current.department ? { department: current.department } : {}),
        ...(current.note ? { note: current.note } : {}),
      };
      // Disabled entries are kept: the Settings page shows them greyed out with
      // the reason, which is more useful than pretending they never existed.
      if (section === 'faculty') faculty.push(target);
      if (section === 'news') news.push(target);
    }
    current = {};
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const sectionMatch = /^(faculty|news|grants):$/.exec(trimmed);
    if (sectionMatch) {
      flush();
      section = sectionMatch[1] as 'faculty' | 'news' | 'grants';
      continue;
    }

    if (trimmed.startsWith('- ')) flush();

    const entry = trimmed.replace(/^-\s*/, '');
    const kv = /^([a-z_]+):\s*(.*)$/.exec(entry);
    if (!kv) continue;

    const [, key, value] = kv;
    const clean = (value ?? '').replace(/^["']|["']$/g, '').trim();

    if (key === 'university_name' || key === 'name') current.universityName = clean;
    else if (key === 'department') current.department = clean;
    else if (key === 'url') current.url = clean;
    else if (key === 'enabled') current.enabled = clean === 'true';
    else if (key === 'disabled_reason' || key === 'note') current.note = clean;
  }
  flush();

  return { faculty, news };
}
