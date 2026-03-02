/**
 * CLI image path detection — extracts @/path/to/image.ext references from user input.
 */

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
  "heic",
  "heif",
]);

// Match @/path, @./path, @~/path — followed by image extension
const IMAGE_PATH_PATTERN = /@([~.]?\/[^\s]+\.(\w+))/g;

/** Extract image file paths from user input text. */
export function extractImagePaths(input: string): string[] {
  const paths: string[] = [];
  const re = new RegExp(IMAGE_PATH_PATTERN.source, IMAGE_PATH_PATTERN.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(input)) !== null) {
    const filePath = match[1]!;
    const ext = match[2]!.toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      paths.push(filePath);
    }
  }

  return paths;
}

/** Remove @path image references from input text, trimming extra whitespace. */
export function removeImagePaths(input: string): string {
  return input
    .replace(/@([~.]?\/[^\s]+\.(\w+))/g, (full, _path, ext) => {
      return IMAGE_EXTENSIONS.has(ext.toLowerCase()) ? "" : full;
    })
    .replace(/\s{2,}/g, " ")
    .trim();
}
