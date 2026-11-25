import { normalizeRemotePattern } from './remote-pattern.js';

describe('normalizeRemotePattern', () => {
  it.each([
    ['github.com/org/repo', 'github.com/org/repo'],
    ['https://github.com/Org/Repo.git', 'github.com/org/repo'],
    ['https://github.com/org/repo/', 'github.com/org/repo'],
    [
      'git@github.com:MakitJenamin/TeamLens.git',
      'github.com/makitjenamin/teamlens',
    ],
    [
      'ssh://git@gitlab.example.com/team/app.git',
      'gitlab.example.com/team/app',
    ],
    [
      'ssh://git@gitlab.example.com:2222/team/app.git',
      'gitlab.example.com/team/app',
    ],
    ['  GitHub.com/ACME/*  ', 'github.com/acme/*'],
    ['github.com/acme/*/', 'github.com/acme/*'],
    ['https://user@bitbucket.org/acme/web.git/', 'bitbucket.org/acme/web'],
    ['github.com/org/my.repo_name-2', 'github.com/org/my.repo_name-2'],
    // Dạng scp: org toàn số không phải cổng.
    ['git@github.com:12345/app.git', 'github.com/12345/app'],
    ['github.com:12345/app', 'github.com/12345/app'],
    ['https://github.com:443/org/repo.git', 'github.com/org/repo'],
  ])('chuẩn hóa %s → %s', (input, expected) => {
    expect(normalizeRemotePattern(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'github.com',
    'github.com/org',
    'github.com/*/*',
    'github.com/org/repo/extra',
    'github.com/org/re*po',
    'github.com//repo',
    '*/org/repo',
    'github.com/org/..',
  ])('từ chối %j', (input) => {
    expect(normalizeRemotePattern(input)).toBeNull();
  });
});
