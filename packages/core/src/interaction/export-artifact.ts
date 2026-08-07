import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import JSZip from "jszip";

export interface ExportStateLike {
  readonly bookDir: (bookId: string) => string;
  readonly loadBookConfig: (bookId: string) => Promise<{ readonly title: string; readonly language?: string }>;
  readonly loadChapterIndex: (bookId: string) => Promise<ReadonlyArray<{
    readonly number: number;
    readonly status: string;
    readonly wordCount: number;
  }>>;
}

export interface ExportArtifact {
  readonly outputPath: string;
  readonly fileName: string;
  readonly chaptersExported: number;
  readonly totalWords: number;
  readonly format: "txt" | "md" | "epub" | "screenplay-md" | "screenplay-json" | "dialogue";
  readonly contentType: string;
  readonly payload: string | Buffer;
}

function buildChapterFileLookup(files: ReadonlyArray<string>): ReadonlyMap<number, string> {
  const lookup = new Map<number, string>();
  for (const file of files) {
    if (!file.endsWith(".md") || !/^\d{4}/.test(file)) {
      continue;
    }
    const chapterNumber = parseInt(file.slice(0, 4), 10);
    if (!lookup.has(chapterNumber)) {
      lookup.set(chapterNumber, file);
    }
  }
  return lookup;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function markdownToSimpleHtml(markdown: string): { title: string; html: string } {
  const title = markdown.match(/^#\s+(.+)/m)?.[1]?.trim() ?? "Untitled Chapter";
  const html = markdown
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("\n");
  return { title, html };
}

async function buildEpub(
  title: string,
  language: string,
  chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>,
): Promise<Buffer> {
  const zip = new JSZip();
  const bookId = `urn:uuid:${randomUUID()}`;
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // EPUB requires this to be the first archive entry and stored without compression.
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  const manifestItems: string[] = [];
  const spineItems: string[] = [];
  const navItems: string[] = [];
  for (const [index, chapter] of chapters.entries()) {
    const sequence = index + 1;
    const id = `chapter-${sequence}`;
    const href = `${id}.xhtml`;
    const safeTitle = escapeHtml(chapter.title);
    manifestItems.push(`    <item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`    <itemref idref="${id}"/>`);
    navItems.push(`      <li><a href="${href}">${safeTitle}</a></li>`);
    zip.file(`OEBPS/${href}`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}" lang="${language}">
<head><meta charset="UTF-8"/><title>${safeTitle}</title></head>
<body><h1>${safeTitle}</h1>${chapter.content}</body>
</html>`);
  }

  zip.file("OEBPS/nav.xhtml", `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
<head><meta charset="UTF-8"/><title>${escapeHtml(title)}</title></head>
<body><nav epub:type="toc" id="toc"><h1>${escapeHtml(title)}</h1><ol>
${navItems.join("\n")}
    </ol></nav></body>
</html>`);
  zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${language}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${bookId}</dc:identifier>
    <dc:title>${escapeHtml(title)}</dc:title>
    <dc:language>${language}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifestItems.join("\n")}
  </manifest>
  <spine>
${spineItems.join("\n")}
  </spine>
</package>`);

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function buildExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: "txt" | "md" | "epub" | "screenplay-md" | "screenplay-json" | "dialogue";
    readonly approvedOnly?: boolean;
    readonly outputPath?: string;
  },
): Promise<ExportArtifact> {
  const format = options.format ?? "txt";
  const index = await state.loadChapterIndex(bookId);
  const book = await state.loadBookConfig(bookId);
  const chapters = options.approvedOnly
    ? index.filter((chapter) => chapter.status === "approved")
    : index;

  if (chapters.length === 0) {
    throw new Error("No chapters to export.");
  }

  const bookDir = state.bookDir(bookId);
  const chaptersDir = join(bookDir, "chapters");
  const episodesDir = join(bookDir, "episodes");
  const projectRoot = dirname(dirname(bookDir));
  const outputPath = options.outputPath ?? join(projectRoot, `${bookId}_export.${format}`);
  const chapterFiles = buildChapterFileLookup(await readdir(chaptersDir));
  const episodeFiles = buildChapterFileLookup(await readdir(episodesDir).catch(() => []));
  const totalWords = chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0);

  if (format === "epub") {
    const epubChapters: Array<{ title: string; content: string }> = [];
    for (const chapter of chapters) {
      const match = chapterFiles.get(chapter.number);
      if (!match) {
        continue;
      }
      const markdown = await readFile(join(chaptersDir, match), "utf-8");
      const { title, html } = markdownToSimpleHtml(markdown);
      epubChapters.push({ title, content: html });
    }
    const language = book.language === "en" ? "en" : "zh-CN";
    return {
      outputPath,
      fileName: `${bookId}.epub`,
      chaptersExported: chapters.length,
      totalWords,
      format,
      contentType: "application/epub+zip",
      payload: await buildEpub(book.title, language, epubChapters),
    };
  }

  if (format === "screenplay-json" || format === "dialogue") {
    const scripts: unknown[] = [];
    const dialogueLines: string[] = [];
    for (const chapter of chapters) {
      const jsonFile = (await readdir(episodesDir).catch(() => [] as string[]))
        .find((file) => file.startsWith(String(chapter.number).padStart(4, "0"))
          && file.endsWith(".json")
          && !file.endsWith("_review.json"));
      if (!jsonFile) continue;
      const script = JSON.parse(await readFile(join(episodesDir, jsonFile), "utf-8")) as {
        scenes?: Array<{ shots?: Array<{ dialogue?: Array<{ speaker?: string; text?: string }> }> }>;
      };
      if (format === "screenplay-json") {
        scripts.push(script);
      } else {
        for (const scene of script.scenes ?? []) {
          for (const shot of scene.shots ?? []) {
            for (const line of shot.dialogue ?? []) {
              if (line.speaker && line.text) dialogueLines.push(`${line.speaker}：${line.text}`);
            }
          }
        }
      }
    }
    return {
      outputPath,
      fileName: `${bookId}.${format === "screenplay-json" ? "json" : "dialogue.txt"}`,
      chaptersExported: chapters.length,
      totalWords,
      format,
      contentType: format === "screenplay-json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
      payload: format === "screenplay-json"
        ? `${JSON.stringify({ title: book.title, episodes: scripts }, null, 2)}\n`
        : `${dialogueLines.join("\n")}\n`,
    };
  }

  if (format === "screenplay-md") {
    const parts: string[] = [`# ${book.title}\n\n---\n`];
    for (const chapter of chapters) {
      const episodeMatch = episodeFiles.get(chapter.number);
      const chapterMatch = chapterFiles.get(chapter.number);
      const match = episodeMatch ?? chapterMatch;
      if (!match) continue;
      parts.push(await readFile(join(episodeMatch ? episodesDir : chaptersDir, match), "utf-8"));
      parts.push("\n\n---\n\n");
    }
    return {
      outputPath,
      fileName: `${bookId}.screenplay.md`,
      chaptersExported: chapters.length,
      totalWords,
      format,
      contentType: "text/markdown; charset=utf-8",
      payload: parts.join(""),
    };
  }

  const parts: string[] = [];
  parts.push(format === "md" ? `# ${book.title}\n\n---\n` : `${book.title}\n\n`);
  for (const chapter of chapters) {
    const match = chapterFiles.get(chapter.number);
    if (!match) {
      continue;
    }
    parts.push(await readFile(join(chaptersDir, match), "utf-8"));
    parts.push("\n\n");
  }

  return {
    outputPath,
    fileName: `${bookId}.${format}`,
    chaptersExported: chapters.length,
    totalWords,
    format,
    contentType: format === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
    payload: parts.join(format === "md" ? "\n---\n\n" : "\n"),
  };
}

export async function writeExportArtifact(
  state: ExportStateLike,
  bookId: string,
  options: {
    readonly format?: "txt" | "md" | "epub" | "screenplay-md" | "screenplay-json" | "dialogue";
    readonly approvedOnly?: boolean;
    readonly outputPath?: string;
  },
): Promise<Omit<ExportArtifact, "payload" | "contentType" | "fileName">> {
  const artifact = await buildExportArtifact(state, bookId, options);
  await mkdir(dirname(artifact.outputPath), { recursive: true });
  await writeFile(artifact.outputPath, artifact.payload);
  return {
    outputPath: artifact.outputPath,
    chaptersExported: artifact.chaptersExported,
    totalWords: artifact.totalWords,
    format: artifact.format,
  };
}
