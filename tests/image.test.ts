import { expect, test } from "bun:test";
import { imageSize } from "../image.ts";

test("PNG", () => {
	const b = Buffer.alloc(33);
	b.writeUInt32BE(0x89504e47, 0);
	b.writeUInt32BE(640, 16);
	b.writeUInt32BE(480, 20);
	expect(imageSize(b)).toEqual({ width: 640, height: 480 });
});

test("GIF is little-endian", () => {
	const b = Buffer.alloc(16);
	b.write("GIF89a", 0, "latin1");
	b.writeUInt16LE(300, 6);
	b.writeUInt16LE(200, 8);
	expect(imageSize(b)).toEqual({ width: 300, height: 200 });
});

test("JPEG: skips earlier segments (APP0, DHT) to find the frame header", () => {
	const soi = Buffer.from([0xff, 0xd8]);
	const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
	// DHT is marker 0xC4: in the SOF range but not a frame header, so it must be skipped
	const dht = Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]);
	const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]); // 300 high, 600 wide
	expect(imageSize(Buffer.concat([soi, app0, dht, sof, Buffer.alloc(10)]))).toEqual({ width: 600, height: 300 });
});

function webp(chunk: string): Buffer {
	const b = Buffer.alloc(40);
	b.write("RIFF", 0, "latin1");
	b.write("WEBP", 8, "latin1");
	b.write(chunk, 12, "latin1");
	return b;
}

test("WebP lossy (VP8)", () => {
	const b = webp("VP8 ");
	b.writeUInt16LE(800, 26);
	b.writeUInt16LE(600, 28);
	expect(imageSize(b)).toEqual({ width: 800, height: 600 });
});

test("WebP lossless (VP8L) stores size minus one in 14-bit fields", () => {
	const b = webp("VP8L");
	b.writeUInt32LE(1023 | (767 << 14), 21);
	expect(imageSize(b)).toEqual({ width: 1024, height: 768 });
});

test("WebP extended (VP8X) stores size minus one in 24-bit fields", () => {
	const b = webp("VP8X");
	b.writeUIntLE(1919, 24, 3);
	b.writeUIntLE(1079, 27, 3);
	expect(imageSize(b)).toEqual({ width: 1920, height: 1080 });
});

test("truncated or unknown data has no size", () => {
	expect(imageSize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
	expect(imageSize(Buffer.from("not an image at all, just text"))).toBeUndefined();
	expect(imageSize(Buffer.alloc(0))).toBeUndefined();
});
