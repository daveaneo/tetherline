import fs from 'fs';
import path from 'path';

export interface ReadmeSection {
  heading: string;
  content: string;
  level: number; // 1, 2, 3
}

export interface ReadmeData {
  exists: boolean;
  raw: string;
  purpose: string; // first paragraph or "About" section
  sections: ReadmeSection[];
  moduleMentions: Map<string, string>; // directory name -> description from README
}

export function parseReadme(repoPath: string): ReadmeData {
  const readmePath = findReadme(repoPath);
  if (!readmePath) {
    return { exists: false, raw: '', purpose: '', sections: [], moduleMentions: new Map() };
  }

  const raw = fs.readFileSync(readmePath, 'utf-8');
  const sections = extractSections(raw);
  const purpose = extractPurpose(raw, sections);
  const moduleMentions = matchSectionsToDirectories(repoPath, sections);

  return { exists: true, raw, purpose, sections, moduleMentions };
}

export function parseModuleReadme(modulePath: string): ReadmeData | null {
  const readmePath = findReadme(modulePath);
  if (!readmePath) return null;
  const raw = fs.readFileSync(readmePath, 'utf-8');
  const sections = extractSections(raw);
  const purpose = extractPurpose(raw, sections);
  return { exists: true, raw, purpose, sections, moduleMentions: new Map() };
}

function findReadme(dir: string): string | null {
  const candidates = ['README.md', 'readme.md', 'Readme.md', 'README.rst', 'README.txt', 'README'];
  for (const name of candidates) {
    const full = path.join(dir, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function extractSections(markdown: string): ReadmeSection[] {
  const lines = markdown.split('\n');
  const sections: ReadmeSection[] = [];
  let currentHeading = '';
  let currentLevel = 0;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      if (currentHeading || currentContent.length > 0) {
        sections.push({
          heading: currentHeading,
          content: currentContent.join('\n').trim(),
          level: currentLevel,
        });
      }
      currentLevel = headingMatch[1].length;
      currentHeading = headingMatch[2].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  // Last section
  if (currentHeading || currentContent.length > 0) {
    sections.push({
      heading: currentHeading,
      content: currentContent.join('\n').trim(),
      level: currentLevel,
    });
  }

  return sections;
}

function extractPurpose(raw: string, sections: ReadmeSection[]): string {
  // Try "About" or "Overview" section first
  const aboutSection = sections.find(s =>
    /^(about|overview|introduction|what is|description)/i.test(s.heading)
  );
  if (aboutSection?.content) {
    return aboutSection.content.split('\n\n')[0].trim();
  }

  // Fall back to first paragraph after the title
  const firstSection = sections[0];
  if (firstSection?.content) {
    return firstSection.content.split('\n\n')[0].trim();
  }

  // Fall back to first non-empty paragraph
  const paras = raw.split('\n\n').filter(p => p.trim() && !p.trim().startsWith('#'));
  return paras[0]?.trim() ?? '';
}

function matchSectionsToDirectories(repoPath: string, sections: ReadmeSection[]): Map<string, string> {
  const mentions = new Map<string, string>();

  // Get top-level directories
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(repoPath, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== 'dist')
      .map(d => d.name);
  } catch { /* ignore */ }

  // Match section headings to directory names
  for (const section of sections) {
    const headingLower = section.heading.toLowerCase();
    for (const dir of dirs) {
      if (headingLower.includes(dir.toLowerCase()) && section.content.length > 20) {
        mentions.set(dir, section.content.split('\n\n')[0].trim());
      }
    }
  }

  return mentions;
}
