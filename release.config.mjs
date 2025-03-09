/**
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
  branches: [
    {
      name: "main",
    },
  ],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        parserOpts: {
          headerPattern: /^(\w+)(?:\(([\w\$\.\-\* ]*)\))?(?:\s*.*)?\:\s(.*)$/,
          headerCorrespondence: ["type", "scope", "subject"],
        },
        releaseRules: [
          {
            breaking: true,
            release: "major",
          },
          {
            type: "ci",
            release: "patch",
          },
          {
            type: "docs",
            release: "patch",
          },
          {
            type: "feat",
            release: "minor",
          },
          {
            type: "fix",
            release: "patch",
          },
          {
            type: "chore",
            release: "patch",
          },
          {
            scope: "no-release",
            release: "patch",
          },
        ],
      },
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits",
        parserOpts: {
          headerPattern: /^(\w+)(?:\(([\w\$\.\-\* ]*)\))?(?:\s*.*)?\:\s(.*)$/,
          headerCorrespondence: ["type", "scope", "subject"],
        },
        presetConfig: {
          types: [
            {
              type: "ci",
              section: "CI/CD",
              hidden: false,
            },
            {
              type: "chore",
              section: "CI/CD",
              hidden: false,
            },
            {
              type: "docs",
              section: "Docs",
              hidden: false,
            },
            {
              type: "feat",
              section: "Features",
              hidden: false,
            },
            {
              type: "fix",
              section: "Bug Fixes",
              hidden: false,
            },
          ],
        },
      },
    ],
    "@semantic-release/changelog",
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md"],
        message: "chore(release): ${nextRelease.version} [ci skip]",
      },
    ],
    [
      "@semantic-release/exec",
      {
        prepareCmd: "npm version ${nextRelease.version} --no-git-tag-version",
      },
    ],
  ],
};
