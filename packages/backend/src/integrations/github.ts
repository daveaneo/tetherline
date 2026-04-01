import { execFile } from 'child_process';
import { promisify } from 'util';
import simpleGit from 'simple-git';

const execFileAsync = promisify(execFile);

export class GitHubIntegration {
  static async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('gh', ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  static async getRepoInfo(repoPath: string): Promise<{ owner: string; repo: string; url: string } | null> {
    try {
      const git = simpleGit(repoPath);
      const remotes = await git.getRemotes(true);
      const origin = remotes.find(r => r.name === 'origin');
      if (!origin?.refs?.fetch) return null;

      const url = origin.refs.fetch;
      // Parse owner/repo from URL (https or ssh)
      const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (!match) return null;
      return { owner: match[1], repo: match[2], url };
    } catch {
      return null;
    }
  }

  static async createIssue(
    repoPath: string,
    title: string,
    body: string,
    labels?: string[],
  ): Promise<{ url: string; number: number }> {
    const args = ['issue', 'create', '--title', title, '--body', body];
    if (labels && labels.length > 0) {
      for (const label of labels) {
        args.push('--label', label);
      }
    }

    const { stdout } = await execFileAsync('gh', args, {
      cwd: repoPath,
      timeout: 30000,
    });

    // gh issue create outputs the URL
    const url = stdout.trim();
    const numberMatch = url.match(/\/issues\/(\d+)/);
    return { url, number: numberMatch ? parseInt(numberMatch[1]) : 0 };
  }
}
