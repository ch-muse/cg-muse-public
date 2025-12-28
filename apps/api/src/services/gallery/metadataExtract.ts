import zlib from "node:zlib";

export type GalleryMetadataParsed = {
  positive?: string;
  negative?: string;
  steps?: number;
  sampler?: string;
  cfg?: number;
  seed?: number;
  width?: number;
  height?: number;
  ckpt?: string;
  loras?: string[];
  scheduler?: string;
  model_hash?: string;
};

export type GalleryMetadataExtract = {
  raw: Record<string, string>;
  parsed: GalleryMetadataParsed;
  parseErrors: string[];
  source: "a1111" | "comfyui" | "none";
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8]);

const toLatin1 = (buffer: Buffer) => buffer.toString("latin1");
const toUtf8 = (buffer: Buffer) => buffer.toString("utf8");

const assignRaw = (raw: Record<string, string>, key: string, value: string) => {
  if (!key || !value) return;
  if (!raw[key]) {
    raw[key] = value;
    return;
  }
  if (raw[key] === value) return;
  raw[key] = `${raw[key]}\n${value}`;
};

const toNumber = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeString = (value: string | null | undefined) => {
  if (!value) return "";
  return value.trim();
};

const parseA1111Parameters = (text: string): GalleryMetadataParsed => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let paramsIndex = lines.findIndex((line) => line.includes("Steps:"));
  if (paramsIndex === -1) {
    paramsIndex = lines.findIndex((line) => line.includes("Sampler:"));
  }

  const promptLines = paramsIndex >= 0 ? lines.slice(0, paramsIndex) : lines;
  const paramsText = paramsIndex >= 0 ? lines.slice(paramsIndex).join(" ") : "";

  let positive = "";
  let negative = "";
  const negIndex = promptLines.findIndex((line) => line.trim().startsWith("Negative prompt:"));
  if (negIndex >= 0) {
    positive = promptLines.slice(0, negIndex).join("\n").trim();
    const negLine = promptLines[negIndex].replace(/^Negative prompt:\s*/i, "");
    negative = [negLine, ...promptLines.slice(negIndex + 1)].join("\n").trim();
  } else {
    positive = promptLines.join("\n").trim();
  }

  const params: Record<string, string> = {};
  const matches = paramsText.matchAll(/(?:^|,)\s*([^:]+?):\s*([^,]+)/g);
  for (const match of matches) {
    const key = match[1].trim();
    const value = match[2].trim();
    if (!key) continue;
    params[key.toLowerCase()] = value;
  }

  let width: number | undefined;
  let height: number | undefined;
  const sizeValue = params["size"];
  if (sizeValue) {
    const sizeMatch = sizeValue.match(/(\d+)\s*x\s*(\d+)/i);
    if (sizeMatch) {
      width = Number(sizeMatch[1]);
      height = Number(sizeMatch[2]);
    }
  }

  return {
    positive: normalizeString(positive) || undefined,
    negative: normalizeString(negative) || undefined,
    steps: toNumber(params["steps"]),
    sampler: normalizeString(params["sampler"]) || undefined,
    cfg: toNumber(params["cfg scale"] ?? params["cfg"]),
    seed: toNumber(params["seed"]),
    width,
    height,
    ckpt: normalizeString(params["model"] ?? params["checkpoint"]) || undefined,
    scheduler: normalizeString(params["scheduler"]) || undefined,
    model_hash: normalizeString(params["model hash"]) || undefined
  };
};

const extractStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractStringArray(item));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = ["name", "lora_name", "loraName", "lora"];
    for (const key of keys) {
      if (typeof record[key] === "string") {
        const trimmed = record[key].trim();
        if (trimmed) return [trimmed];
      }
    }
  }
  return [];
};

const parseComfyPrompt = (promptPayload: unknown): GalleryMetadataParsed => {
  if (!promptPayload || typeof promptPayload !== "object") return {};
  const parsed: GalleryMetadataParsed = {};
  const loras = new Set<string>();

  const nodes = Object.values(promptPayload as Record<string, unknown>);
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    const inputs = record.inputs && typeof record.inputs === "object" ? (record.inputs as Record<string, unknown>) : null;
    if (!inputs) continue;

    for (const [key, value] of Object.entries(inputs)) {
      const normalizedKey = key.toLowerCase();
      if (parsed.positive === undefined && normalizedKey === "positive" && typeof value === "string") {
        parsed.positive = normalizeString(value) || undefined;
      }
      if (parsed.negative === undefined && normalizedKey === "negative" && typeof value === "string") {
        parsed.negative = normalizeString(value) || undefined;
      }
      if (parsed.ckpt === undefined && ["ckpt_name", "checkpoint", "model", "model_name"].includes(normalizedKey)) {
        if (typeof value === "string") {
          parsed.ckpt = normalizeString(value) || undefined;
        }
      }
      if (parsed.width === undefined && ["width", "empty_latent_width"].includes(normalizedKey)) {
        const numberValue = toNumber(value);
        if (numberValue !== undefined) parsed.width = numberValue;
      }
      if (parsed.height === undefined && ["height", "empty_latent_height"].includes(normalizedKey)) {
        const numberValue = toNumber(value);
        if (numberValue !== undefined) parsed.height = numberValue;
      }
      if (parsed.seed === undefined && ["seed", "noise_seed", "random_seed"].includes(normalizedKey)) {
        const numberValue = toNumber(value);
        if (numberValue !== undefined) parsed.seed = numberValue;
      }
      if (parsed.steps === undefined && normalizedKey === "steps") {
        const numberValue = toNumber(value);
        if (numberValue !== undefined) parsed.steps = numberValue;
      }
      if (parsed.cfg === undefined && ["cfg", "cfg_scale"].includes(normalizedKey)) {
        const numberValue = toNumber(value);
        if (numberValue !== undefined) parsed.cfg = numberValue;
      }
      if (parsed.sampler === undefined && ["sampler_name", "sampler"].includes(normalizedKey)) {
        if (typeof value === "string") {
          parsed.sampler = normalizeString(value) || undefined;
        }
      }
      if (parsed.scheduler === undefined && normalizedKey === "scheduler") {
        if (typeof value === "string") {
          parsed.scheduler = normalizeString(value) || undefined;
        }
      }
      if (normalizedKey.includes("lora")) {
        const names = extractStringArray(value);
        for (const name of names) {
          loras.add(name);
        }
      }
    }
  }

  if (loras.size > 0) {
    parsed.loras = Array.from(loras);
  }

  return parsed;
};

const parseJsonText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false as const, error: "empty_json" };
  try {
    return { ok: true as const, value: JSON.parse(trimmed) };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
};

const resolvePromptPayload = (payload: unknown): unknown => {
  if (!payload || typeof payload !== "object") return payload;
  const record = payload as Record<string, unknown>;
  if (record.prompt) {
    if (typeof record.prompt === "string") {
      const parsed = parseJsonText(record.prompt);
      return parsed.ok ? parsed.value : record.prompt;
    }
    return record.prompt;
  }
  return payload;
};

const parseExifUserComment = (buffer: Buffer): string | null => {
  if (buffer.length < 14) return null;
  const byteOrder = buffer.toString("ascii", 0, 2);
  const littleEndian = byteOrder === "II";
  const readUInt16 = (offset: number) => (littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  const readUInt32 = (offset: number) => (littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  if (readUInt16(2) !== 0x2a) return null;
  const ifdOffset = readUInt32(4);
  if (ifdOffset + 2 > buffer.length) return null;

  const readIfd = (offset: number) => {
    if (offset + 2 > buffer.length) return [];
    const count = readUInt16(offset);
    const entries: Array<{ tag: number; type: number; count: number; valueOffset: number }> = [];
    let cursor = offset + 2;
    for (let i = 0; i < count; i += 1) {
      if (cursor + 12 > buffer.length) break;
      entries.push({
        tag: readUInt16(cursor),
        type: readUInt16(cursor + 2),
        count: readUInt32(cursor + 4),
        valueOffset: readUInt32(cursor + 8)
      });
      cursor += 12;
    }
    return entries;
  };

  const getValueOffset = (entry: { type: number; count: number; valueOffset: number }) => {
    const typeSizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
    const size = (typeSizes[entry.type] || 1) * entry.count;
    if (size <= 4) return null;
    return entry.valueOffset;
  };

  const ifd0 = readIfd(ifdOffset);
  const exifPointer = ifd0.find((entry) => entry.tag === 0x8769);
  if (!exifPointer) return null;
  const exifIfdOffset = exifPointer.valueOffset;
  if (!exifIfdOffset || exifIfdOffset >= buffer.length) return null;
  const exifIfd = readIfd(exifIfdOffset);
  const userComment = exifIfd.find((entry) => entry.tag === 0x9286);
  if (!userComment) return null;
  const valueOffset = getValueOffset(userComment) ?? null;
  const valueStart = valueOffset ? valueOffset : null;
  if (valueStart === null || valueStart >= buffer.length) return null;
  const valueEnd = valueStart + userComment.count;
  if (valueEnd > buffer.length) return null;
  const raw = buffer.slice(valueStart, valueEnd);
  if (raw.length < 8) return null;
  const prefix = raw.slice(0, 8).toString("ascii");
  const commentBody = raw.slice(8);
  if (prefix.startsWith("ASCII")) {
    return normalizeString(commentBody.toString("ascii").replace(/\0+$/, "")) || null;
  }
  if (prefix.startsWith("UNICODE")) {
    return normalizeString(commentBody.toString("utf16le").replace(/\0+$/, "")) || null;
  }
  return normalizeString(commentBody.toString("ascii").replace(/\0+$/, "")) || null;
};

const parsePngTextChunks = (buffer: Buffer) => {
  const raw: Record<string, string> = {};
  let width: number | undefined;
  let height: number | undefined;
  let exifUserComment: string | null = null;
  let offset = PNG_SIGNATURE.length;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    offset += 8;
    const dataEnd = offset + length;
    if (dataEnd > buffer.length) break;
    const data = buffer.slice(offset, dataEnd);
    offset = dataEnd + 4;

    if (type === "IHDR" && data.length >= 8) {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "tEXt") {
      const separator = data.indexOf(0);
      if (separator > 0) {
        const key = toLatin1(data.slice(0, separator));
        const value = toLatin1(data.slice(separator + 1));
        assignRaw(raw, key, value);
      }
    } else if (type === "zTXt") {
      const separator = data.indexOf(0);
      if (separator > 0 && separator + 2 <= data.length) {
        const key = toLatin1(data.slice(0, separator));
        const compressed = data.slice(separator + 2);
        try {
          const value = toLatin1(zlib.inflateSync(compressed));
          assignRaw(raw, key, value);
        } catch {
          // ignore invalid zlib
        }
      }
    } else if (type === "iTXt") {
      const separator = data.indexOf(0);
      if (separator > 0 && separator + 5 <= data.length) {
        const key = toLatin1(data.slice(0, separator));
        const compressionFlag = data[separator + 1];
        const textStart = (() => {
          let idx = separator + 3;
          while (idx < data.length && data[idx] !== 0) idx += 1;
          idx += 1;
          while (idx < data.length && data[idx] !== 0) idx += 1;
          return Math.min(idx + 1, data.length);
        })();
        const textData = data.slice(textStart);
        try {
          const decoded =
            compressionFlag === 1 ? toUtf8(zlib.inflateSync(textData)) : toUtf8(textData);
          assignRaw(raw, key, decoded);
        } catch {
          // ignore invalid zlib
        }
      }
    } else if (type === "eXIf") {
      const comment = parseExifUserComment(data);
      if (comment) {
        exifUserComment = comment;
      }
    }
  }

  return { raw, width, height, exifUserComment };
};

const extractJpegExif = (buffer: Buffer) => {
  let offset = JPEG_SIGNATURE.length;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) break;
    const segmentStart = offset + 4;
    const segmentEnd = segmentStart + segmentLength - 2;
    if (segmentEnd > buffer.length) break;
    if (marker === 0xe1) {
      const header = buffer.slice(segmentStart, segmentStart + 6).toString("ascii");
      if (header === "Exif\0\0") {
        const exifBuffer = buffer.slice(segmentStart + 6, segmentEnd);
        const comment = parseExifUserComment(exifBuffer);
        return comment;
      }
    }
    offset = segmentEnd;
  }
  return null;
};

export const extractImageMetadata = (buffer: Buffer): GalleryMetadataExtract => {
  const raw: Record<string, string> = {};
  const parsed: GalleryMetadataParsed = {};
  const parseErrors: string[] = [];
  let source: "a1111" | "comfyui" | "none" = "none";

  if (buffer.length >= PNG_SIGNATURE.length && buffer.slice(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    const result = parsePngTextChunks(buffer);
    Object.assign(raw, result.raw);
    if (result.exifUserComment) {
      assignRaw(raw, "UserComment", result.exifUserComment);
    }

    if (raw.parameters) {
      source = "a1111";
      Object.assign(parsed, parseA1111Parameters(raw.parameters));
    } else if (raw.prompt || raw.workflow || raw.extra_pnginfo) {
      source = "comfyui";
      const jsonText = raw.extra_pnginfo ?? raw.prompt ?? raw.workflow;
      if (jsonText) {
        const jsonResult = parseJsonText(jsonText);
        if (jsonResult.ok) {
          const promptPayload = resolvePromptPayload(jsonResult.value);
          const parsedPrompt = parseComfyPrompt(promptPayload);
          Object.assign(parsed, parsedPrompt);
        } else {
          parseErrors.push("invalid_json");
        }
      }
    } else {
      parseErrors.push("no_metadata");
    }

    if (parsed.width === undefined && result.width !== undefined) parsed.width = result.width;
    if (parsed.height === undefined && result.height !== undefined) parsed.height = result.height;
  } else if (buffer.length >= JPEG_SIGNATURE.length && buffer.slice(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    const userComment = extractJpegExif(buffer);
    if (userComment) {
      assignRaw(raw, "UserComment", userComment);
      const parsedComment = parseA1111Parameters(userComment);
      if (parsedComment.positive || parsedComment.negative) {
        source = "a1111";
        Object.assign(parsed, parsedComment);
      } else {
        parseErrors.push("no_metadata");
      }
    } else {
      parseErrors.push("no_metadata");
    }
  } else {
    parseErrors.push("unknown_format");
  }

  if (source === "none" && parseErrors.length === 0) {
    parseErrors.push("no_metadata");
  }

  return { raw, parsed, parseErrors, source };
};
