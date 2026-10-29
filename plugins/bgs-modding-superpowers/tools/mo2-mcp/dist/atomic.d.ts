/**
 * Atomically write text content to `path`. Creates parent dirs if missing.
 * For modlist.txt, plugins.txt, loadorder.txt and archives.txt the line endings are normalised to those of
 * the file being replaced, so callers can build content with "\n" without turning MO2's CRLF files into LF.
 */
export declare function atomicWriteText(path: string, content: string, encoding?: BufferEncoding): Promise<void>;
/** Atomically write binary content to `path`. */
export declare function atomicWriteBytes(path: string, content: Buffer): Promise<void>;
