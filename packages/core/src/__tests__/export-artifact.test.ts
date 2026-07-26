import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildExportArtifact, type ExportStateLike } from "../interaction/export-artifact.js";

describe("EPUB export", () => {
  it("builds a self-contained EPUB 3 archive without template runtime dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-epub-"));
    try {
      const bookDir = join(root, "books", "demo");
      await mkdir(join(bookDir, "chapters"), { recursive: true });
      await writeFile(
        join(bookDir, "chapters", "0001-opening.md"),
        "# Opening & Arrival\n\nA door <opens>.",
        "utf-8",
      );

      const state: ExportStateLike = {
        bookDir: () => bookDir,
        loadBookConfig: async () => ({ title: "Book & Beyond", language: "en" }),
        loadChapterIndex: async () => [{ number: 1, status: "approved", wordCount: 3 }],
      };

      const artifact = await buildExportArtifact(state, "demo", { format: "epub" });
      expect(Buffer.isBuffer(artifact.payload)).toBe(true);
      const payload = artifact.payload as Buffer;

      // The first local file header must contain an uncompressed mimetype entry.
      expect(payload.readUInt32LE(0)).toBe(0x04034b50);
      expect(payload.readUInt16LE(8)).toBe(0);
      const fileNameLength = payload.readUInt16LE(26);
      expect(payload.subarray(30, 30 + fileNameLength).toString("utf-8")).toBe("mimetype");

      const zip = await JSZip.loadAsync(payload);
      expect(await zip.file("mimetype")?.async("string")).toBe("application/epub+zip");
      expect(await zip.file("META-INF/container.xml")?.async("string")).toContain("OEBPS/content.opf");

      const packageDocument = await zip.file("OEBPS/content.opf")?.async("string");
      expect(packageDocument).toContain("<dc:title>Book &amp; Beyond</dc:title>");
      expect(packageDocument).toContain('properties="nav"');
      expect(packageDocument).toContain('idref="chapter-1"');

      const navigation = await zip.file("OEBPS/nav.xhtml")?.async("string");
      expect(navigation).toContain('href="chapter-1.xhtml"');
      expect(navigation).toContain("Opening &amp; Arrival");

      const chapter = await zip.file("OEBPS/chapter-1.xhtml")?.async("string");
      expect(chapter).toContain("A door &lt;opens&gt;.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
