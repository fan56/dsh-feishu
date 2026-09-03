/**
 * Image media-type sniffing — pure byte arithmetic, no dsh or Lark imports.
 *
 * Feishu image messages carry only an opaque `image_key`; the resource
 * download returns raw bytes with no declared MIME. The attachment service
 * requires a caller-declared media type VERIFIED against the decoded bytes,
 * so the type must come from the bytes themselves (a wrong declaration fails
 * admission and the image never reaches the session).
 */

/** The media types the dsh attachment path accepts (structural — mirrors dsh-attachment). */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/**
 * Sniff the media type from image magic bytes; undefined for anything the
 * attachment path does not accept (sticker-like formats, truncated payloads).
 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }
  // JPEG: FF D8 FF (the third byte varies by marker; SOI + SOS prefix is fixed).
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF: 'GIF8' (87a/89a both start with it).
  if (bytes.length >= 4
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif'
  }
  // WEBP: 'RIFF' .... 'WEBP'.
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return undefined
}

/** File-extension for an accepted media type (display name for the attachment). */
export function imageExtensionOf(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
  }
}
