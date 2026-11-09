import { expect, test } from "bun:test";
import { prettyJson } from "../json.ts";

const minified = '{"name":"demo","version":"1.0.0","dependencies":{"alpha":"^1.2.3","beta":"^2.0.0"},"scripts":{"build":"tsc"}}';

test("a minified file is indented", () => {
	expect(prettyJson(minified, 1)).toBe(JSON.stringify(JSON.parse(minified), null, 2));
});

test("a file that is already multi-line is left alone, so its line numbers stay real", () => {
	expect(prettyJson(JSON.stringify(JSON.parse(minified), null, 2), 12)).toBeUndefined();
});

test("short or invalid input is left alone", () => {
	expect(prettyJson('{"a":1}', 1)).toBeUndefined();
	expect(prettyJson(`{"broken": ${"x".repeat(150)}`, 1)).toBeUndefined();
});
