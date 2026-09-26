const { changelogSection } = require("../scripts/changelog_section");

const CHANGELOG = `# Changelog

## 2.3.0

- **New**: Something new
- **Fix**: Something fixed

## 2.2.9

- **Fix**: Older fix

## 2.2.8
`;

describe("changelogSection", () => {
  it("returns one version's section, heading included", () => {
    expect(changelogSection(CHANGELOG, "2.3.0")).toBe(
      "## 2.3.0\n\n- **New**: Something new\n- **Fix**: Something fixed\n"
    );
  });

  it("stops at the next version heading", () => {
    expect(changelogSection(CHANGELOG, "2.2.9")).toBe(
      "## 2.2.9\n\n- **Fix**: Older fix\n"
    );
  });

  it("matches the exact version only", () => {
    expect(changelogSection(CHANGELOG, "2.3")).toBeNull();
    expect(changelogSection(CHANGELOG, "2.4.0")).toBeNull();
  });

  it("treats an empty section as missing", () => {
    expect(changelogSection(CHANGELOG, "2.2.8")).toBeNull();
  });

  it("handles CRLF line endings", () => {
    expect(changelogSection(CHANGELOG.replace(/\n/g, "\r\n"), "2.2.9")).toBe(
      "## 2.2.9\n\n- **Fix**: Older fix\n"
    );
  });

  it("finds the section of the released 2.2.9 in the real changelog", () => {
    const fs = require("fs");
    const path = require("path");
    const section = changelogSection(
      fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8"),
      "2.2.9"
    );
    expect(section).toMatch(/^## 2\.2\.9\n\n- /);
  });
});
