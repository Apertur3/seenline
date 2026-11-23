# Seenline plugin for Claude Code

This plugin adds one skill. When you ask Claude to read, summarise or check a PDF, Word, PowerPoint, Excel, CSV, HTML,
email or subtitle file, the skill has Claude run the `seenline` command on it. Seenline converts the file to Markdown on
your computer and lists text a reader cannot see (white, tiny, clipped, off-page, hidden by styles) in a separate
`[Hidden in the original]` block, so Claude reads the visible content and can tell you about anything hidden.

Install it in Claude Code with `/plugin install seenline --marketplace Apertur3/seenline`. The plugin contains no code. It needs Seenline installed: see
[Quick start](https://github.com/Apertur3/seenline#quick-start). Seenline runs locally, makes no network requests and
writes no files.

Seenline is a detection aid, not a security boundary: it does not catch every way of hiding text. See
[what it does not catch](https://github.com/Apertur3/seenline#what-it-does-not-catch). MIT licence.

## Privacy

The plugin contains no code and collects nothing. Its skill has Claude run the `seenline` command on files you ask about.
Seenline reads them on your computer, makes no network requests, writes no files and keeps nothing; no data goes to the
publisher or any other party. What Claude does with the converted text is covered by your Claude plan's terms.
