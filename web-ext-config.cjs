module.exports = {
  // Development-only files should not be shipped in the add-on or linted as
  // part of the packaged extension.
  ignoreFiles: [
    'tests/**',
    'README.md',
    'PROVENANCE.md',
    'LICENSE',
    '.gitignore',
    'web-ext-config.cjs'
  ]
};
