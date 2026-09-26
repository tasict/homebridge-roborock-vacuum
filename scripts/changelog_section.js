"use strict";

// Prints the CHANGELOG.md section of one version ("## <version>" up to the
// next "## " heading), heading included — the release notes format of the
// GitHub releases. Exits non-zero when the section is missing or empty, so
// a release cannot go out without notes.
//
//   node scripts/changelog_section.js 2.3.0 [CHANGELOG.md]

const fs = require("fs");

function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start < 0) {
    return null;
  }

  let end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## ")
  );
  if (end < 0) {
    end = lines.length;
  }

  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return body ? `## ${version}\n\n${body}\n` : null;
}

module.exports = { changelogSection };

if (require.main === module) {
  const [version, file = "CHANGELOG.md"] = process.argv.slice(2);
  if (!version) {
    console.error("Usage: node scripts/changelog_section.js <version> [file]");
    process.exit(2);
  }

  const section = changelogSection(fs.readFileSync(file, "utf8"), version);
  if (!section) {
    console.error(`${file} has no "## ${version}" section with content.`);
    process.exit(1);
  }
  process.stdout.write(section);
}
