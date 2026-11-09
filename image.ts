/** Pixel size from an image file's header; undefined when the header is unrecognised or cut off. Handles PNG, GIF, WebP and JPEG. */
export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
	if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	if (buf.length > 10 && buf.toString("latin1", 0, 4) === "GIF8") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
	if (buf.length > 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
		const chunk = buf.toString("latin1", 12, 16);
		if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
		if (chunk === "VP8L") {
			const bits = buf.readUInt32LE(21);
			return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
		}
		if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
	}
	if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
		// walk the marker segments to the first start-of-frame (SOF0-SOF15, except DHT/JPG/DAC)
		for (let i = 2; i + 9 < buf.length; ) {
			if (buf[i] !== 0xff) {
				i++;
				continue;
			}
			const marker = buf[i + 1];
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
			}
			i += 2 + buf.readUInt16BE(i + 2);
		}
	}
	return undefined;
}
